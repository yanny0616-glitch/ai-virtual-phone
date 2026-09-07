"use client";

import { useState } from "react";
import { ensureShiguangInstalled } from "@/lib/shiguang-bundled-install";
import { toCustomAppIconId } from "@/lib/custom-app-types";

/** 记忆库里的拾光入口：随宿主发布的安装包，点一下装好并打开；已装且版本新就直接打开。 */
export function ShiguangPanel({ characterId }: { characterId?: string; characterName?: string; userName?: string }) {
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const open = async () => {
        if (busy) return;
        setBusy(true); setNotice("");
        try {
            const { app, action } = await ensureShiguangInstalled();
            if (action !== "kept") setNotice(action === "installed" ? "拾光已安装，正在打开。" : `拾光已更新到 ${app.version}，正在打开。`);
            window.dispatchEvent(new CustomEvent("open-app", { detail: {
                appId: toCustomAppIconId(app.id), launchContext: { characterId, source: "memory" },
            } }));
        } catch (err) {
            setNotice(err instanceof Error ? err.message : String(err));
        } finally { setBusy(false); }
    };
    return <section className="menu-group p-4 my-3" aria-label="拾光 APP">
        <h3 className="ts-17 font-semibold">拾光是一个独立 APP</h3>
        <p className="ts-14 text-secondary my-3">自动从聊天里整理值得记住的小事，按话题带进下一次对话；摘要看得见、改得了。第一次点会自动安装，之后有新版也在这里自动换包。</p>
        <button type="button" className="ui-btn ui-btn-primary" style={{ minHeight: 44 }} disabled={busy} onClick={() => void open()}>{busy ? "正在准备…" : "打开拾光"}</button>
        <p role="status" className="ts-14 text-secondary mt-3">{notice}</p>
    </section>;
}
