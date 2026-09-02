// 官方聊天插件：仓库 chat-plugins/ 随宿主发布到 /chat-plugins/（见 scripts/build-chat-plugins-dist.mjs）。
// App 内一键安装；已装的官方插件在启动时对照 index.json 自动升级，用户不必再手动导入文件。

import { installChatPluginFromCode } from "@/lib/chat-plugin-loader";
import { loadChatPlugins, recordChatPluginLog } from "@/lib/chat-plugin-storage";

export type OfficialChatPluginEntry = {
    id: string;
    name: string;
    version: string;
    description: string;
    file: string;
};

const INDEX_URL = "/chat-plugins/index.json";

export async function fetchOfficialChatPluginIndex(): Promise<OfficialChatPluginEntry[]> {
    try {
        const res = await fetch(INDEX_URL, { cache: "no-store" });
        if (!res.ok) return [];
        const data = await res.json() as unknown;
        if (!Array.isArray(data)) return [];
        return data.filter((x): x is OfficialChatPluginEntry =>
            !!x && typeof x === "object" && typeof (x as OfficialChatPluginEntry).id === "string" && typeof (x as OfficialChatPluginEntry).file === "string");
    } catch {
        return [];
    }
}

/** 比较 "1.4.1" 这类版本号；解析不了的按字符串比 */
export function compareVersion(a: string, b: string): number {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d < 0 ? -1 : 1;
    }
    return 0;
}

export async function installOfficialChatPlugin(entry: OfficialChatPluginEntry) {
    const res = await fetch(`/chat-plugins/${entry.file}`, { cache: "no-store" });
    if (!res.ok) return { ok: false as const, error: `下载失败（${res.status}）` };
    const code = await res.text();
    return installChatPluginFromCode(code, { expectedId: entry.id });
}

/** 启动时：已装的官方插件若落后于随宿主发布的版本，静默升级（设置与数据保留） */
export async function autoUpdateOfficialChatPlugins(): Promise<string[]> {
    const installed = loadChatPlugins();
    if (installed.length === 0) return [];
    const index = await fetchOfficialChatPluginIndex();
    const upgraded: string[] = [];
    for (const entry of index) {
        const cur = installed.find(p => p.manifest.id === entry.id);
        if (!cur || compareVersion(cur.manifest.version || "0", entry.version) >= 0) continue;
        const result = await installOfficialChatPlugin(entry);
        if (result.ok) upgraded.push(`${entry.name} v${cur.manifest.version || "?"} → v${entry.version}`);
        else recordChatPluginLog({ pluginId: entry.id, where: "autoUpdate", message: result.error || "升级失败", level: "error" });
    }
    return upgraded;
}
