"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { hasCharacterReferenceImage, imagePromptDefaults } from "@/lib/image-generation-service";
import {
    joinPhotoDescription,
    loadImageStylePresets,
    peekCharacterLook,
    resolveCharacterLook,
    saveCharacterLook,
    saveImageStylePresets,
    splitPhotoDescription,
    type ImageStylePreset,
} from "@/lib/image-prompt-extras";
import { loadImageGenerationSettings } from "@/lib/settings-storage";

export type GeneratedImageEdit = {
    description: string;
    useReferenceImage: boolean;
    /** null = 和方案默认一样，不单独存 */
    positive: string | null;
    negative: string | null;
};

/** 点开图片 → 编辑：画面、角色出镜（长相 + 此刻的样子）、画风预设、本次正向/负向 */
export function GeneratedImageEditDialog({
    description,
    useReferenceImage,
    positive,
    negative,
    characterId,
    busy,
    error,
    onCancel,
    onConfirm,
}: {
    description: string;
    useReferenceImage: boolean;
    positive?: string;
    negative?: string;
    characterId?: string;
    busy: boolean;
    error?: string;
    onCancel: () => void;
    onConfirm: (edit: GeneratedImageEdit) => void;
}) {
    const defaults = useMemo(() => imagePromptDefaults(), []);
    const appearanceOn = useMemo(() => loadImageGenerationSettings().appearanceOn !== false, []);
    const hasRef = useMemo(() => hasCharacterReferenceImage(characterId), [characterId]);
    const initial = useMemo(() => splitPhotoDescription(description), [description]);
    const [scene, setScene] = useState(initial.scene);
    const [now, setNow] = useState(initial.look);
    const [cameo, setCameo] = useState(useReferenceImage);
    const [pos, setPos] = useState(positive ?? defaults.positive);
    const [neg, setNeg] = useState(negative ?? defaults.negative);
    const [presets, setPresets] = useState<ImageStylePreset[]>(() => loadImageStylePresets());
    const [naming, setNaming] = useState<string | null>(null);
    const lookStale = () => Boolean(characterId) && appearanceOn && !peekCharacterLook(characterId!, defaults.style).fresh;
    const [look, setLook] = useState(() => characterId ? peekCharacterLook(characterId, defaults.style).text : "");
    // 缓存不新鲜（没提过或人设改了）才去提取，提取中显示「正在从人设提取…」
    const [lookState, setLookState] = useState<"idle" | "loading">(() => useReferenceImage && lookStale() ? "loading" : "idle");
    const lookBase = useRef(look);
    const lookTouched = useRef(false);
    const lookRequested = useRef(false);

    useEffect(() => {
        if (lookState !== "loading" || !characterId || lookRequested.current) return;
        lookRequested.current = true;
        void resolveCharacterLook(characterId, defaults.style).then(text => {
            lookBase.current = text;
            if (!lookTouched.current) setLook(text);
            setLookState("idle");
        });
    }, [characterId, defaults.style, lookState]);

    const active = presets.find(p => p.positive === pos.trim() && p.negative === neg.trim());
    const isDefault = pos.trim() === defaults.positive && neg.trim() === defaults.negative;
    const tagStyle = defaults.style === "tag";

    const savePreset = () => {
        const name = (naming || "").trim() || `画风 ${presets.length + 1}`;
        const next = [...presets, { id: `style_${Date.now().toString(36)}`, name, positive: pos.trim(), negative: neg.trim() }];
        saveImageStylePresets(next);
        setPresets(next);
        setNaming(null);
    };
    const removePreset = (id: string) => {
        const next = presets.filter(p => p.id !== id);
        saveImageStylePresets(next);
        setPresets(next);
    };

    const confirm = () => {
        if (cameo && characterId && appearanceOn && lookTouched.current && look.trim() !== lookBase.current.trim()) {
            saveCharacterLook(characterId, look, defaults.style);
        }
        onConfirm({
            description: joinPhotoDescription(cameo ? now : "", scene),
            useReferenceImage: cameo,
            positive: pos.trim() === defaults.positive ? null : pos.trim(),
            negative: neg.trim() === defaults.negative ? null : neg.trim(),
        });
    };

    const cameoHint = !characterId ? ""
        : defaults.provider === "novelai" ? "NovelAI 不读参考图，出镜靠长相描述"
        : hasRef ? "会带上角色参考图" : "这个角色没传参考图，只靠长相描述";

    return (
        <div
            className="modal-overlay"
            data-ui="modal"
            onPointerDown={e => e.stopPropagation()}
            onPointerUp={e => e.stopPropagation()}
            onPointerCancel={e => e.stopPropagation()}
            onPointerMove={e => e.stopPropagation()}
            onContextMenu={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onCancel(); }}
        >
            <div className="modal-dialog chat-generated-image-prompt-dialog gi-edit" data-ui="modal-dialog" onClick={e => e.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <h3 className="modal-title">编辑图片</h3>
                </div>
                <div className="modal-body chat-generated-image-prompt-body gi-edit-body" data-ui="modal-body">
                    <label className="gi-edit-field">
                        <span className="gi-edit-label">画面</span>
                        <textarea
                            id="gi-edit-scene"
                            className="ui-textarea gi-edit-textarea"
                            value={scene}
                            onChange={e => setScene(e.target.value)}
                            placeholder="主体、动作、环境、光线、构图"
                            disabled={busy}
                            rows={4}
                        />
                    </label>

                    <label className="chat-generated-image-prompt-check gi-edit-check">
                        <input id="gi-edit-cameo" type="checkbox" checked={cameo} disabled={busy} onChange={e => {
                            setCameo(e.target.checked);
                            if (e.target.checked && lookStale()) setLookState("loading");
                        }} />
                        <span>角色出镜</span>
                        {cameo && cameoHint && <span className="gi-edit-hint">{cameoHint}</span>}
                    </label>

                    {cameo && (
                        <div className="gi-edit-cameo">
                            {appearanceOn && characterId ? (
                                <label className="gi-edit-field">
                                    <span className="gi-edit-label">
                                        长相
                                        <span className="gi-edit-hint">{lookState === "loading" ? "正在从人设提取…" : "从人设提取，人设改了会重新提取；改了会记住"}</span>
                                    </span>
                                    <textarea
                                        id="gi-edit-look"
                                        className="ui-textarea gi-edit-textarea gi-edit-textarea--small"
                                        value={look}
                                        onChange={e => { lookTouched.current = true; setLook(e.target.value); }}
                                        placeholder={lookState === "loading" ? "" : tagStyle ? "black hair, long hair, drooping eyes…" : "黑色长发，眼尾微垂…（人设里没写长相就留空）"}
                                        disabled={busy}
                                        rows={2}
                                    />
                                </label>
                            ) : (
                                <div className="gi-edit-hint">{characterId ? "设置里关了「出镜时加长相」，长相不会写进提示词" : "没有对应角色，不加长相"}</div>
                            )}
                            <label className="gi-edit-field">
                                <span className="gi-edit-label">此刻的样子</span>
                                <textarea
                                    id="gi-edit-now"
                                    className="ui-textarea gi-edit-textarea gi-edit-textarea--small"
                                    value={now}
                                    onChange={e => setNow(e.target.value)}
                                    placeholder="这会儿的穿着、发型、妆容、伤痕…（可空）"
                                    disabled={busy}
                                    rows={2}
                                />
                            </label>
                            <div className="gi-edit-hint">两栏冲突时以「此刻的样子」为准。只加在角色出镜的图上，拍景物、食物不加。</div>
                        </div>
                    )}

                    <div className="gi-edit-field">
                        <span className="gi-edit-label">画风</span>
                        <div className="gi-edit-chips">
                            <button type="button" className="gi-edit-chip" data-on={isDefault || undefined} disabled={busy}
                                onClick={() => { setPos(defaults.positive); setNeg(defaults.negative); }}>
                                方案默认
                            </button>
                            {presets.map(preset => (
                                <span key={preset.id} className="gi-edit-chip-wrap">
                                    <button type="button" className="gi-edit-chip" data-on={(!isDefault && active?.id === preset.id) || undefined} disabled={busy}
                                        onClick={() => { setPos(preset.positive); setNeg(preset.negative); }}>
                                        {preset.name}
                                    </button>
                                    {!isDefault && active?.id === preset.id && (
                                        <button type="button" className="gi-edit-chip-x" aria-label={`删除预设 ${preset.name}`} disabled={busy} onClick={() => removePreset(preset.id)}>
                                            <X size={11} />
                                        </button>
                                    )}
                                </span>
                            ))}
                            {naming === null ? (
                                !isDefault && !active && (
                                    <button type="button" className="gi-edit-chip gi-edit-chip--add" disabled={busy} onClick={() => setNaming("")}>
                                        ＋ 存成预设
                                    </button>
                                )
                            ) : (
                                <span className="gi-edit-name">
                                    <input
                                        id="gi-edit-preset-name"
                                        className="ui-input gi-edit-name-input"
                                        value={naming}
                                        autoFocus
                                        placeholder={`画风 ${presets.length + 1}`}
                                        onChange={e => setNaming(e.target.value)}
                                        onKeyDown={e => { if (e.key === "Enter") savePreset(); if (e.key === "Escape") setNaming(null); }}
                                    />
                                    <button type="button" className="gi-edit-chip" data-on onClick={savePreset}>存</button>
                                    <button type="button" className="gi-edit-chip" onClick={() => setNaming(null)}>取消</button>
                                </span>
                            )}
                        </div>
                    </div>

                    <details className="gi-edit-advanced" open={!isDefault && !active ? true : undefined}>
                        <summary>本次正向 / 负向{isDefault ? "" : " · 已改"}</summary>
                        <label className="gi-edit-field">
                            <span className="gi-edit-label">正向</span>
                            <textarea id="gi-edit-positive" className="ui-textarea gi-edit-textarea gi-edit-textarea--small" value={pos}
                                onChange={e => setPos(e.target.value)} disabled={busy} rows={2}
                                placeholder={tagStyle ? "masterpiece, best quality…" : "画风、质感、镜头…"} />
                        </label>
                        <label className="gi-edit-field">
                            <span className="gi-edit-label">
                                负向
                                {!tagStyle && <span className="gi-edit-hint">GPT 类接口没有负向，会写成「不要出现：…」接在末尾</span>}
                            </span>
                            <textarea id="gi-edit-negative" className="ui-textarea gi-edit-textarea gi-edit-textarea--small" value={neg}
                                onChange={e => setNeg(e.target.value)} disabled={busy} rows={2}
                                placeholder={tagStyle ? "lowres, bad hands…" : "文字水印、多余的手指…"} />
                        </label>
                        <div className="gi-edit-hint">只改这一张；想以后都用，存成画风预设。</div>
                    </details>

                    {error && <div className="chat-generated-image-retry-error">{error}</div>}
                </div>
                <div className="modal-footer" data-ui="modal-footer">
                    <button className="ui-btn ui-btn-ghost" onClick={onCancel}>取消</button>
                    <button className="ui-btn ui-btn-action" disabled={busy || !scene.trim()} onClick={confirm}>生成</button>
                </div>
            </div>
        </div>
    );
}
