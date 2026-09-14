"use client";
import type { ChatMessage } from "@/lib/chat-storage";
import { useState, type ReactNode } from "react";

export function ToolNoticeGroup({ messages, onContextMenu, renderActions }: { messages: Pick<ChatMessage, "id" | "content">[]; onContextMenu?: (id: string, x: number, y: number) => void; renderActions?: (id: string) => ReactNode }) {
  const failures = messages.filter(m => /[×✗❌]|失败|Error/.test(m.content)).length;
  const running = /正在/.test(messages.at(-1)?.content || "");
  // 执行中自动展开看进度，跑完自动收起；用户手动点过之后就听用户的
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  return (
    <details className="chat-tool-fold" open={userOpen ?? running} onToggle={e => setUserOpen(e.currentTarget.open)}>
      <summary>
        <span className={`chat-tool-fold-dot${running ? " is-running" : failures ? " is-failed" : ""}`} />
        <span>{running ? "工具执行中" : "工具调用"}</span>
        <span className="chat-tool-fold-count">{messages.length} 条{failures ? ` · ${failures} 条失败` : ""}</span>
      </summary>
      <div className="chat-tool-fold-body">
        {messages.map(m => (
          <div key={m.id} className="relative">
            <p className="chat-tool-fold-item" onContextMenu={e => { if (onContextMenu) { e.preventDefault(); onContextMenu(m.id, e.clientX, e.clientY); } }}>{m.content}</p>
            {renderActions?.(m.id)}
          </div>
        ))}
      </div>
    </details>
  );
}
