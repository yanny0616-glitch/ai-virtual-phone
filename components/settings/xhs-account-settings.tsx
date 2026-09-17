"use client";
import { useEffect, useState } from "react";

type Status = { state?: string; message?: string; nickname?: string; configured?: boolean };
export function XhsAccountSettings() {
    const [status,setStatus] = useState<Status>({message:"正在检查登录状态…"});
    const [cookie,setCookie] = useState("");
    const [busy,setBusy] = useState(false);
    const [error,setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        void fetch("/api/xhs-account",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"status"}),signal:controller.signal})
            .then(async response => { const data=await response.json(); if(!response.ok)throw new Error(data.error); if(!controller.signal.aborted)setStatus(data); })
            .catch(err => { if(!controller.signal.aborted)setError(err.message || "状态暂时不可用"); });
        return () => controller.abort();
    },[]);
    async function submit(action: "save" | "clear" | "status") {
        setBusy(true);setError("");
        try {
            const response=await fetch("/api/xhs-account",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,...(action==="save"?{cookie}:{refresh:true})})});
            const data=await response.json();if(!response.ok)throw new Error(data.error);
            setStatus(data);setCookie("");
        } catch(err) {setError(err instanceof Error?err.message:"操作失败");}
        finally {setBusy(false);}
    }
    return <section className="flex flex-col gap-2 rounded-xl border border-black/10 p-3 dark:border-white/10">
        <div className="text-sm font-medium">小红书账号</div>
        <p role="status" className="text-xs">{status.message}{status.nickname ? `（${status.nickname}）` : ""}</p>
        <p className="menu-desc">公开链接可独立读取。搜索、推荐、主页及账号操作需要有效的网页版 Cookie。</p>
        <label className="menu-desc" htmlFor="xhs-cookie">小红书 Cookie{status.configured ? "（已保存，输入可替换）" : ""}</label>
        <input id="xhs-cookie" type="password" autoComplete="off" spellCheck={false} value={cookie} onChange={e=>setCookie(e.target.value)} placeholder="粘贴包含 a1 和 web_session 的 Cookie" className="min-h-10 w-full rounded-lg border border-black/15 bg-transparent px-3 text-sm dark:border-white/20" />
        <p className="menu-desc">仅保存到本机服务端，不写入工具箱导出或发送给角色。</p>
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !cookie.trim()} onClick={()=>void submit("save")} className="min-h-10 rounded-lg bg-black/10 px-3 text-xs disabled:opacity-40 dark:bg-white/10">保存并检测</button>
            <button type="button" disabled={busy} onClick={()=>void submit("status")} className="min-h-10 rounded-lg bg-black/10 px-3 text-xs disabled:opacity-40 dark:bg-white/10">{busy?"处理中…":"重新检测"}</button>
            {status.configured && <button type="button" disabled={busy} onClick={()=>void submit("clear")} className="min-h-10 px-3 text-xs text-red-500 disabled:opacity-40">清除 Cookie</button>}
        </div>
    </section>;
}
