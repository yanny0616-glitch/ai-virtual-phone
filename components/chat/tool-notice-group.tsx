"use client";
import type { ChatMessage } from "@/lib/chat-storage";
import type { ReactNode } from "react";
export function ToolNoticeGroup({messages,onContextMenu,renderActions}:{messages:Pick<ChatMessage,"id"|"content">[];onContextMenu?:(id:string,x:number,y:number)=>void;renderActions?:(id:string)=>ReactNode}) {
    const failures=messages.filter(m=>/[×✗❌]|失败|Error/.test(m.content)).length;
    const running=/正在/.test(messages.at(-1)?.content||"");
    return <details className="mx-auto w-[90%] rounded-lg border border-black/5 px-3 py-2 dark:border-white/10">
        <summary className="chat-sys-msg cursor-pointer select-none">{running?"工具执行中":"工具调用"} · {messages.length} 条记录{failures?` · ${failures} 条失败`:""}</summary>
        <div className="mt-2 flex flex-col gap-2">{messages.map(m=><div key={m.id} className="relative"><p className="chat-sys-msg whitespace-pre-wrap break-words" onContextMenu={e=>{if(onContextMenu){e.preventDefault();onContextMenu(m.id,e.clientX,e.clientY);}}}>{m.content}</p>{renderActions?.(m.id)}</div>)}</div>
    </details>;
}
