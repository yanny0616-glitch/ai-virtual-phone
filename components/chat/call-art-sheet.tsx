"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Star, Trash2, X } from "lucide-react";
import { CALL_ART_CHANGED_EVENT, callArtItems, loadCallArt, saveCallArt, type CallArt, type CallArtKind, type CallArtLibrary } from "@/lib/call-art";
import { useChatImage } from "./use-chat-image";

const KIND_LABEL: Record<CallArtKind, string> = { portrait: "立绘", scene: "场景" };

function ArtTile({ art, isDefault, selected, onClick }: { art: CallArt; isDefault: boolean; selected: boolean; onClick: () => void }) {
    const url = useChatImage(art.image);
    return (
        <button type="button" className="cx-art" aria-pressed={selected} onClick={onClick}>
            <span className="cx-art-img">{url && <img src={url} alt="" />}</span>
            <span className="cx-art-nm">{art.name || "未命名"}</span>
            {isDefault && <span className="cx-art-def">默认</span>}
        </button>
    );
}

export function CallArtSheet({ characterId, characterName, artSwitch, onArtSwitch, onClose }: {
    characterId: string;
    characterName: string;
    artSwitch: boolean;
    onArtSwitch: (on: boolean) => void;
    onClose: () => void;
}) {
    const [lib, setLib] = useState<CallArtLibrary>(() => loadCallArt(characterId));
    const [kind, setKind] = useState<CallArtKind>("portrait");
    const [cat, setCat] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const onChange = (e: Event) => {
            if ((e as CustomEvent<{ characterId?: string }>).detail?.characterId === characterId) setLib(loadCallArt(characterId));
        };
        window.addEventListener(CALL_ART_CHANGED_EVENT, onChange);
        return () => window.removeEventListener(CALL_ART_CHANGED_EVENT, onChange);
    }, [characterId]);

    const items = callArtItems(lib, kind);
    const cats = useMemo(() => [...new Set(items.map(item => item.category.trim()).filter(Boolean))], [items]);
    const shown = cat ? items.filter(item => item.category.trim() === cat) : items;
    const defaultId = kind === "portrait" ? lib.defaultPortrait : lib.defaultScene;
    const effectiveDefault = items.find(item => item.id === defaultId)?.id ?? items[0]?.id;
    const selected = items.find(item => item.id === selectedId) ?? null;

    const commit = (next: CallArtLibrary) => { setLib(next); saveCallArt(characterId, next); };
    const withItems = (next: CallArt[]): CallArtLibrary => (kind === "portrait" ? { ...lib, portraits: next } : { ...lib, scenes: next });
    const patch = (id: string, change: Partial<CallArt>) => commit(withItems(items.map(item => (item.id === id ? { ...item, ...change } : item))));

    const addFiles = async (files: FileList | null) => {
        if (!files?.length) return;
        setBusy(true);
        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const added: CallArt[] = [];
            for (const file of Array.from(files)) {
                const image = await saveChatImageToIndexedDB(file);
                added.push({ id: `art_${Date.now().toString(36)}_${added.length}`, name: file.name.replace(/\.[^.]+$/, "").slice(0, 12), category: cat, image });
            }
            commit(withItems([...items, ...added]));
            setSelectedId(added[0]?.id ?? null);
        } catch {
            alert("图片保存失败，请重试");
        } finally {
            setBusy(false);
            if (fileRef.current) fileRef.current.value = "";
        }
    };

    const remove = (id: string) => {
        const next = withItems(items.filter(item => item.id !== id));
        if (kind === "portrait" && next.defaultPortrait === id) next.defaultPortrait = undefined;
        if (kind === "scene" && next.defaultScene === id) next.defaultScene = undefined;
        commit(next);
        setSelectedId(null);
    };

    return createPortal(
        <div className="dg-scrim" onClick={onClose}>
            <div className="dg-sheet cx-vars" role="dialog" aria-label="立绘和场景" onClick={e => e.stopPropagation()}>
                <div className="dg-grab" />
                <div className="cx-sh-head">
                    <span className="cx-sh-title"><b>立绘和场景</b><small>{characterName} · 所有和 TA 的通话共用</small></span>
                    <button type="button" className="cx-x" aria-label="关闭" onClick={onClose}><X size={13} /></button>
                </div>
                <div className="cx-seg" role="tablist">
                    {(["portrait", "scene"] as const).map(key => (
                        <button key={key} type="button" role="tab" aria-selected={kind === key} onClick={() => { setKind(key); setCat(""); setSelectedId(null); }}>
                            <span>{KIND_LABEL[key]}</span><i>{callArtItems(lib, key).length}</i>
                        </button>
                    ))}
                </div>
                <div className="dg-sh-body cx-art-body">
                    {cats.length > 0 && (
                        <div className="cx-chips">
                            <button type="button" aria-pressed={!cat} onClick={() => setCat("")}>全部</button>
                            {cats.map(name => <button key={name} type="button" aria-pressed={cat === name} onClick={() => setCat(name)}>{name}</button>)}
                        </div>
                    )}
                    <div className="cx-art-grid">
                        {shown.map(art => (
                            <ArtTile key={art.id} art={art} isDefault={art.id === effectiveDefault} selected={art.id === selectedId} onClick={() => setSelectedId(art.id === selectedId ? null : art.id)} />
                        ))}
                        <button type="button" className="cx-art cx-art-add" disabled={busy} onClick={() => fileRef.current?.click()}>
                            <span className="cx-art-img"><Plus size={20} strokeWidth={1.6} /></span>
                            <span className="cx-art-nm">{busy ? "保存中…" : `加${KIND_LABEL[kind]}`}</span>
                        </button>
                        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => void addFiles(e.target.files)} />
                    </div>
                    {selected && (
                        <div className="cx-list cx-art-edit">
                            <label className="cx-kv"><span>名字</span><input className="cx-inp" value={selected.name} maxLength={12} placeholder={kind === "portrait" ? "如 开心、困了" : "如 公司、卧室"} onChange={e => patch(selected.id, { name: e.target.value })} /></label>
                            <label className="cx-kv"><span>分类</span><input className="cx-inp" value={selected.category} maxLength={10} placeholder="可不填" onChange={e => patch(selected.id, { category: e.target.value })} /></label>
                            <div className="cx-art-acts">
                                <button type="button" className="dg-pill is-soft" disabled={selected.id === effectiveDefault} onClick={() => commit(kind === "portrait" ? { ...lib, defaultPortrait: selected.id } : { ...lib, defaultScene: selected.id })}>
                                    <Star size={12} />{selected.id === effectiveDefault ? "已是默认" : "设成默认"}
                                </button>
                                <button type="button" className="dg-pill is-danger" onClick={() => remove(selected.id)}><Trash2 size={12} />删除</button>
                            </div>
                        </div>
                    )}
                    <label className="cx-list cx-swrow">
                        <span className="cx-swrow-tx"><b>让 TA 按心情换</b><span>TA 回话时可以写 [立绘:开心] [场景:公司]，只能挑这里有的</span></span>
                        <span className="cx-sw"><input type="checkbox" checked={artSwitch} onChange={e => onArtSwitch(e.target.checked)} /><i /></span>
                    </label>
                    <p className="cx-note">{kind === "portrait" ? "立绘只在视频通话里用，最好是去了底的 PNG；一张都没有就用头像。" : "场景名字写成地方（公司、宿舍、卧室），在线状态里说 TA 在哪就能自动对上；一个都没有就用通话背景。"}</p>
                </div>
            </div>
        </div>,
        document.body,
    );
}
