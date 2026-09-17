"use client";

import { useState, type SyntheticEvent } from "react";
import {
    REROLL_QUICK_TAGS,
    loadRerollAttachPrevious,
    loadRerollPresets,
    saveRerollAttachPrevious,
    saveRerollPresets,
    type ReplyVersionView,
} from "@/lib/chat-reroll";

export type RerollRequest = { tags: string[]; note: string; attachPrevious: boolean };

// 弹窗挂在聊天列表内部：不拦指针事件的话，在弹窗里按住会触发底下气泡的长按菜单
const stop = (e: SyntheticEvent) => e.stopPropagation();
const overlayGuards = {
    onPointerDown: stop,
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerMove: stop,
    onContextMenu: stop,
};

export function RerollDialog({ onCancel, onConfirm }: {
    onCancel: () => void;
    onConfirm: (request: RerollRequest) => void;
}) {
    const [tags, setTags] = useState<string[]>([]);
    const [note, setNote] = useState("");
    const [presets, setPresets] = useState<string[]>(() => loadRerollPresets());
    const [editingPresets, setEditingPresets] = useState(false);
    const [attachPrevious, setAttachPrevious] = useState(() => loadRerollAttachPrevious());

    const trimmedNote = note.trim();
    const hasInput = tags.length > 0 || trimmedNote.length > 0;

    const toggleTag = (label: string) => {
        setTags(prev => (prev.includes(label) ? prev.filter(tag => tag !== label) : [...prev, label]));
    };
    const applyPreset = (text: string) => {
        setNote(prev => {
            const current = prev.trim();
            if (current.includes(text)) return prev;
            return current ? `${current}\n${text}` : text;
        });
    };
    const updatePresets = (next: string[]) => {
        setPresets(next);
        saveRerollPresets(next);
        if (next.length === 0) setEditingPresets(false);
    };
    const toggleAttach = (value: boolean) => {
        setAttachPrevious(value);
        saveRerollAttachPrevious(value);
    };

    return (
        <div className="modal-overlay" data-ui="modal" {...overlayGuards} onClick={e => { e.stopPropagation(); onCancel(); }}>
            <div className="modal-dialog chat-reroll-dialog" data-ui="modal-dialog" onClick={stop}>
                <div className="modal-header" data-ui="modal-header">
                    <h3 className="modal-title">重新生成</h3>
                </div>
                <div className="modal-body chat-reroll-body" data-ui="modal-body">
                    <div className="chat-reroll-hint">说说上一版哪里不对，留空就直接重来。</div>
                    <div className="chat-reroll-chips">
                        {REROLL_QUICK_TAGS.map(tag => (
                            <button
                                key={tag.label}
                                type="button"
                                className="ui-chip"
                                {...(tags.includes(tag.label) ? { "data-selected": "" } : {})}
                                onClick={() => toggleTag(tag.label)}
                            >
                                {tag.label}
                            </button>
                        ))}
                    </div>
                    <textarea
                        className="ui-textarea chat-reroll-textarea"
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        placeholder="比如：太短了，而且把见面地点说错了"
                    />
                    <div className="chat-reroll-label">
                        <span>我的常用</span>
                        <span className="chat-reroll-label-actions">
                            {presets.length > 0 && (
                                <button type="button" onClick={() => setEditingPresets(v => !v)}>
                                    {editingPresets ? "完成" : "管理"}
                                </button>
                            )}
                            <button
                                type="button"
                                disabled={!trimmedNote || presets.includes(trimmedNote)}
                                onClick={() => updatePresets([...presets, trimmedNote])}
                            >
                                把这条存为常用
                            </button>
                        </span>
                    </div>
                    {presets.length > 0 ? (
                        <div className="chat-reroll-chips">
                            {presets.map(text => (
                                <button
                                    key={text}
                                    type="button"
                                    className="ui-chip chat-reroll-mine"
                                    onClick={() => (editingPresets ? updatePresets(presets.filter(p => p !== text)) : applyPreset(text))}
                                >
                                    {text}
                                    {editingPresets && <span className="chat-reroll-mine-remove" aria-label="删除">×</span>}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="chat-reroll-empty">写好一句后点「把这条存为常用」，下次一点就能用。</div>
                    )}
                    <label className="chat-reroll-check">
                        <input type="checkbox" checked={attachPrevious} onChange={e => toggleAttach(e.target.checked)} />
                        <span>附上上一版给 TA 对照</span>
                        <small>更容易改对，多花一点 token</small>
                    </label>
                </div>
                <div className="modal-footer" data-ui="modal-footer">
                    <button type="button" className="ui-btn ui-btn-ghost" onClick={onCancel}>取消</button>
                    <button
                        type="button"
                        className="ui-btn ui-btn-action"
                        onClick={() => onConfirm({ tags, note: trimmedNote, attachPrevious })}
                    >
                        {hasInput ? "按说明重来" : "直接重来"}
                    </button>
                </div>
            </div>
        </div>
    );
}

function formatVersionTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ReplyVersionPicker({ versions, onPick, onClose }: {
    versions: ReplyVersionView[];
    onPick: (index: number) => void;
    onClose: () => void;
}) {
    return (
        <div className="modal-overlay" data-ui="modal" {...overlayGuards} onClick={e => { e.stopPropagation(); onClose(); }}>
            <div className="modal-dialog chat-reply-version-dialog" data-ui="modal-dialog" onClick={stop}>
                <div className="modal-header" data-ui="modal-header">
                    <h3 className="modal-title">选一版</h3>
                </div>
                <div className="modal-body chat-reply-version-body" data-ui="modal-body">
                    <div className="chat-reply-version-list">
                        {versions.map(version => {
                            const time = formatVersionTime(version.createdAt);
                            return (
                                <button
                                    key={version.index}
                                    type="button"
                                    className="chat-reply-version-card"
                                    {...(version.active ? { "data-current": "" } : {})}
                                    onClick={() => { if (!version.active) onPick(version.index); }}
                                >
                                    <span className="chat-reply-version-meta">
                                        <span>第 {version.index + 1} 版{time ? ` · ${time}` : ""}</span>
                                        {version.active && <b>正在用</b>}
                                    </span>
                                    <span className="chat-reply-version-text">
                                        {version.lines.length > 0 ? version.lines.join("\n") : "这一版没有文字内容"}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="chat-reply-version-note">点一版就换上。发下条消息时，其余版本清掉。</div>
                </div>
                <div className="modal-footer" data-ui="modal-footer">
                    <button type="button" className="ui-btn ui-btn-ghost" onClick={onClose}>关闭</button>
                </div>
            </div>
        </div>
    );
}
