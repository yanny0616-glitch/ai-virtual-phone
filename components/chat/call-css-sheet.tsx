"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { CALL_CSS_HOOKS, CALL_CSS_PRESETS } from "@/lib/call-css";

export function CallCssSheet({ value, onSave, onClose }: { value: string; onSave: (css: string) => void; onClose: () => void }) {
    const [draft, setDraft] = useState(value);
    const [showHooks, setShowHooks] = useState(false);

    return createPortal(
        <div className="dg-scrim" onClick={onClose}>
            <div className="dg-sheet cx-vars" role="dialog" aria-label="通话美化" onClick={e => e.stopPropagation()}>
                <div className="dg-grab" />
                <div className="cx-sh-head">
                    <span className="cx-sh-title"><b>通话美化</b><small>只管这个聊天的语音和视频通话</small></span>
                    <button type="button" className="cx-x" aria-label="关闭" onClick={onClose}><X size={13} /></button>
                </div>
                <div className="dg-sh-body cx-art-body">
                    <div className="cx-chips">
                        <span className="cx-chips-l">套用</span>
                        <button type="button" aria-pressed={!draft.trim()} onClick={() => setDraft("")}>默认</button>
                        {CALL_CSS_PRESETS.map(preset => (
                            <button key={preset.id} type="button" aria-pressed={draft.trim() === preset.css.trim()} onClick={() => setDraft(preset.css)}>{preset.name}</button>
                        ))}
                    </div>
                    <textarea className="cx-code" value={draft} spellCheck={false} placeholder={".call-sub { font-size: 15px; }"} onChange={e => setDraft(e.target.value)} />
                    <div className="cx-list">
                        <button type="button" className="cx-kv cx-hooks-h" aria-expanded={showHooks} onClick={() => setShowHooks(v => !v)}>
                            <span>能用的钩子</span><b>{showHooks ? "收起" : `${CALL_CSS_HOOKS.length} 个，点开看`}</b>
                        </button>
                        {showHooks && CALL_CSS_HOOKS.map(([selector, desc]) => (
                            <div key={selector} className="cx-kv cx-hook"><code>{selector}</code><b>{desc}</b></div>
                        ))}
                    </div>
                    <p className="cx-note">写的时候不用加前缀，自动只作用在通话界面。挂断键怎么改都会留在最上层、能点。</p>
                </div>
                <div className="dg-sh-foot">
                    <button type="button" className="dg-pill is-ghost" onClick={onClose}>取消</button>
                    <button type="button" className="dg-pill" onClick={() => { onSave(draft.trim()); onClose(); }}>保存</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
