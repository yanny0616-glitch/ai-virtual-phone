"use client";

// components/chat-plugin-bootstrap.tsx
// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。
// 放在根布局，保证插件的 hook 在用户进入聊天前就已注册。

import { useEffect } from "react";
import { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";
import { autoUpdateOfficialChatPlugins } from "@/lib/chat-plugin-official";

export function ChatPluginBootstrap() {
    useEffect(() => {
        void (async () => {
            // 先升级再启动：官方插件随宿主发布，装过的用户不必再手动导入新版
            try { await autoUpdateOfficialChatPlugins(); } catch { /* 离线或没有官方插件目录 */ }
            await getChatPluginRuntime().ensureStarted();
        })();
    }, []);
    return null;
}
