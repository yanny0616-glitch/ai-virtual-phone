"use client";

import { useState } from "react";
import { loadInstalledCustomApps } from "@/lib/custom-app-storage";
import { toCustomAppIconId } from "@/lib/custom-app-types";

/** Compatibility entry point. All memory management lives in the installable app. */
export function ShiguangPanel({ characterId }: { characterId?: string; characterName?: string; userName?: string }) {
    const [notice, setNotice] = useState("");
    const open = () => {
        const app = loadInstalledCustomApps().find(item => item.manifest.id === "float.shiguang");
        if (!app) {
            setNotice("先在应用市场导入拾光安装包，再点这里打开。已有记忆和整理进度会直接接续。");
            return;
        }
        window.dispatchEvent(new CustomEvent("open-app", { detail: {
            appId: toCustomAppIconId(app.id), launchContext: { characterId, source: "memory" },
        } }));
    };
    return <section className="menu-group p-4 my-3" aria-label="拾光独立 APP">
        <h3 className="ts-17 font-semibold">拾光已独立成 APP</h3>
        <p className="ts-14 text-secondary my-3">在拾光里查看和编辑供 AI 回忆的摘要、管理发送方式、整理新消息。已有记录会保留，聊天仍能自动调用。</p>
        <button type="button" className="ui-btn ui-btn-primary" style={{ minHeight: 44 }} onClick={open}>打开拾光</button>
        <p role="status" className="ts-14 text-secondary mt-3">{notice}</p>
    </section>;
}
