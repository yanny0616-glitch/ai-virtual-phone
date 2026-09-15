"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { readChatBlock, sendFriendVerification, VERIFY_RETRY_MS } from "@/lib/chat-block";

export function ChatBlockBar({ charName, onUnblock }: { charName: string; onUnblock: () => void }) {
    return (
        <div className="cx-blockbar">
            <span>你已把 {charName} 拉黑，TA 的消息都会被拒收</span>
            <button type="button" className="dg-pill is-soft" onClick={onUnblock}>解除拉黑</button>
        </div>
    );
}

export function RejectTip({ kind, charName, onVerify }: { kind: "block" | "delete"; charName: string; onVerify?: () => void }) {
    if (kind === "block") return <div className="cx-reject-tip">消息已发出，但被对方拒收了。</div>;
    return (
        <div className="cx-reject-tip">
            {charName}开启了朋友验证，你还不是他（她）朋友。请先发送朋友验证请求，对方验证通过后，才能聊天。
            {onVerify && <button type="button" onClick={onVerify}>发送朋友验证</button>}
        </div>
    );
}

export function FriendVerifySheet({ sessionId, charName, userName, onClose }: { sessionId: string; charName: string; userName: string; onClose: () => void }) {
    const [text, setText] = useState(`我是${userName}`);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    const [waitMin] = useState(() => {
        const rejectedAt = readChatBlock(sessionId).charBlock?.verifyRejectedAt;
        return rejectedAt ? Math.ceil((VERIFY_RETRY_MS - (Date.now() - Date.parse(rejectedAt))) / 60000) : 0;
    });

    const send = async () => {
        setSending(true);
        setError("");
        const result = await sendFriendVerification(sessionId, text);
        setSending(false);
        if (result.ok) onClose();
        else setError(result.reason);
    };

    if (typeof document === "undefined") return null;
    return createPortal(
        <div className="dg-scrim" onClick={sending ? undefined : onClose}>
            <div className="dg-sheet" role="dialog" aria-label="发送朋友验证" onClick={e => e.stopPropagation()}>
                <div className="dg-grab" />
                <div className="cx-sh-head">
                    <span className="cx-sh-title"><b>发送朋友验证</b><small>{charName} 会看到这句话，再决定要不要加回你</small></span>
                    <button type="button" className="cx-x" aria-label="关闭" onClick={onClose} disabled={sending}><X size={13} /></button>
                </div>
                <div className="dg-sh-body cx-verify">
                    <textarea aria-label="验证消息" value={text} maxLength={120} onChange={e => setText(e.target.value)} disabled={sending} />
                    {waitMin > 0 && <div className="cx-note">刚被拒绝过，{waitMin} 分钟后才能再发。</div>}
                    {error && <div className="cx-error" role="alert">{error}</div>}
                </div>
                <div className="dg-sh-foot">
                    <span className="cx-note">{sending ? `${charName} 正在看…` : "被拒后要等 10 分钟才能再发"}</span>
                    <button type="button" className="dg-pill" onClick={send} disabled={sending || waitMin > 0}>{sending ? "等待验证" : "发送"}</button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
