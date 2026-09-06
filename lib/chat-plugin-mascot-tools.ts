// 小卷「聊天插件套件」执行器：读规格 / 列出 / 读取 / 安装 / 更新 / 启停。
// 没有卸载——清理插件让用户自己在管理页做（与特调套件同规矩）。

import type { ToolResult } from "./tool-executor";
import { CHAT_PLUGIN_FULL_DOC } from "./chat-plugin-docs";
import { installChatPluginFromCode } from "./chat-plugin-loader";
import { fetchOfficialChatPluginIndex } from "./chat-plugin-official";
import {
    getInstalledChatPlugin,
    loadChatPluginErrors,
    loadChatPlugins,
    setChatPluginEnabled,
} from "./chat-plugin-storage";

function json(v: unknown): string {
    return JSON.stringify(v, null, 2);
}

function str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

async function officialIds(): Promise<Set<string>> {
    return new Set((await fetchOfficialChatPluginIndex()).map(e => e.id));
}

export function pluginToolReadSpec(): ToolResult {
    return { name: "读取插件规格", success: true, data: CHAT_PLUGIN_FULL_DOC };
}

export async function pluginToolList(): Promise<ToolResult> {
    const official = await officialIds();
    const plugins = loadChatPlugins().map(p => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version ?? "",
        description: p.manifest.description ?? "",
        enabled: p.enabled,
        official: official.has(p.manifest.id),
        updatedAt: p.updatedAt,
    }));
    return { name: "列出插件", success: true, data: json({ plugins, count: plugins.length }) };
}

export async function pluginToolRead(args: Record<string, unknown>): Promise<ToolResult> {
    const NAME = "读取插件";
    const id = str(args.id);
    if (!id) return { name: NAME, success: false, error: "请传插件 id（列出插件可查）" };
    const p = getInstalledChatPlugin(id);
    if (!p) return { name: NAME, success: false, error: `没有 id 为 ${id} 的插件` };
    const official = (await officialIds()).has(id);
    const logs = loadChatPluginErrors().filter(e => e.pluginId === id).slice(-10);
    return {
        name: NAME,
        success: true,
        data: json({ manifest: p.manifest, enabled: p.enabled, official, settings: p.settings, recentLogs: logs }) + "\n\n===== 源码 =====\n" + p.code,
    };
}

export async function pluginToolInstall(args: Record<string, unknown>): Promise<ToolResult> {
    const NAME = "安装插件";
    const code = str(args.code);
    if (!code) return { name: NAME, success: false, error: "请传插件源码 code" };
    const idMatch = code.match(/id\s*:\s*["'`]([A-Za-z0-9_.-]{2,64})["'`]/);
    const guessedId = idMatch?.[1];
    if (guessedId && getInstalledChatPlugin(guessedId)) {
        return { name: NAME, success: false, error: `id 为 ${guessedId} 的插件已存在，要改它请用「更新插件」；要另做一个请换 id` };
    }
    if (guessedId && (await officialIds()).has(guessedId)) {
        return { name: NAME, success: false, error: `${guessedId} 是官方插件的 id，宿主会自动升级覆盖它，请换一个 id` };
    }
    const res = await installChatPluginFromCode(code);
    if (!res.ok) return { name: NAME, success: false, error: res.error };
    return { name: NAME, success: true, data: `已安装并启用「${res.name}」，聊天里立即生效。运行出错会记进插件日志，读取插件可看最近 10 条` };
}

export async function pluginToolUpdate(args: Record<string, unknown>): Promise<ToolResult> {
    const NAME = "更新插件";
    const id = str(args.id);
    const code = str(args.code);
    if (!id) return { name: NAME, success: false, error: "请传插件 id" };
    if (!code) return { name: NAME, success: false, error: "请传完整的新源码 code（整份替换，不是补丁）" };
    if (!getInstalledChatPlugin(id)) return { name: NAME, success: false, error: `没有 id 为 ${id} 的插件，新装请用「安装插件」` };
    if ((await officialIds()).has(id)) {
        return { name: NAME, success: false, error: `${id} 是官方插件，宿主会自动升级把改动覆盖掉。想改它的规则，读取插件拿到源码后换个 id 装成自己的副本，再禁用官方那份` };
    }
    const res = await installChatPluginFromCode(code, { expectedId: id });
    if (!res.ok) return { name: NAME, success: false, error: res.error };
    return {
        name: NAME,
        success: true,
        data: `已热更新「${res.name}」（${res.fromVersion || "?"} → ${res.toVersion || "?"}），设置与插件数据保留`,
    };
}

export function pluginToolSetEnabled(args: Record<string, unknown>): ToolResult {
    const NAME = "启停插件";
    const id = str(args.id);
    if (!id) return { name: NAME, success: false, error: "请传插件 id" };
    if (typeof args.enabled !== "boolean") return { name: NAME, success: false, error: "请传 enabled（true 启用 / false 禁用）" };
    if (!getInstalledChatPlugin(id)) return { name: NAME, success: false, error: `没有 id 为 ${id} 的插件` };
    setChatPluginEnabled(id, args.enabled);
    return { name: NAME, success: true, data: `${id} 已${args.enabled ? "启用" : "禁用"}` };
}
