// lib/custom-app-chat-context.ts
// 自定义 app → 聊天提示词的注入通道。app 调 chat.setContext 写一段自然语言状态，
// 由 {{customAppContext}} 宏渲染进提示词。
//
// 这个宏只能放在 chatHistory 之后的条目里：llm-provider-adapter.ts 给整个 system
// 串只挂一个 cache_control 断点，任何进 system 的每轮变动文本都会把整段系统提示词的
// 缓存打掉；放在历史之后则只作废尾巴。内置预设把条目排在 prompt_order 最末就是这个原因。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadInstalledCustomApps } from "./custom-app-storage";

const KEY = "custom_app_chat_context_v1";
registerKvMigration(KEY);

export const CUSTOM_APP_CHAT_CONTEXT_EVENT = "custom-app-chat-context-changed";

const MAX_TEXT_LENGTH = 4000;
const MAX_LABEL_LENGTH = 40;
const MAX_ENTRIES_PER_APP = 20;
/** 未指定角色的片段落在这个键上，对所有会话生效 */
const GLOBAL_SCOPE = "__global__";

export type CustomAppChatContextEntry = {
    appId: string;
    appName: string;
    /** 小标题，渲染成【appName · label】；留空只渲染 app 名 */
    label: string;
    text: string;
    characterId: string;
    updatedAt: number;
};

type Store = Record<string, Record<string, CustomAppChatContextEntry>>;

function readStore(): Store {
    try {
        const raw = kvGet(KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Store : {};
    } catch {
        return {};
    }
}

function writeStore(store: Store): void {
    kvSet(KEY, JSON.stringify(store));
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CUSTOM_APP_CHAT_CONTEXT_EVENT));
    }
}

function trim(value: unknown, max: number): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function setCustomAppChatContext(
    appId: string,
    appName: string,
    input: { text?: unknown; label?: unknown; characterId?: unknown },
): CustomAppChatContextEntry | null {
    const id = trim(appId, 160);
    if (!id) return null;
    const characterId = trim(input.characterId, 160);
    const scope = characterId || GLOBAL_SCOPE;
    const text = trim(input.text, MAX_TEXT_LENGTH);
    const store = readStore();

    if (!text) {
        if (store[id]) {
            delete store[id][scope];
            if (Object.keys(store[id]).length === 0) delete store[id];
            writeStore(store);
        }
        return null;
    }

    const entry: CustomAppChatContextEntry = {
        appId: id,
        appName: trim(appName, 60) || id,
        label: trim(input.label, MAX_LABEL_LENGTH),
        text,
        characterId,
        updatedAt: Date.now(),
    };
    const bucket = store[id] || {};
    bucket[scope] = entry;
    // 按角色写的片段可能越攒越多（换角色试、角色删了），只留最近的
    const scopes = Object.keys(bucket);
    if (scopes.length > MAX_ENTRIES_PER_APP) {
        scopes
            .sort((a, b) => (bucket[a].updatedAt || 0) - (bucket[b].updatedAt || 0))
            .slice(0, scopes.length - MAX_ENTRIES_PER_APP)
            .forEach(k => { delete bucket[k]; });
    }
    store[id] = bucket;
    writeStore(store);
    return entry;
}

/** characterId 省略时清掉这个 app 的全部片段 */
export function clearCustomAppChatContext(appId: string, characterId?: string): void {
    const id = trim(appId, 160);
    if (!id) return;
    const store = readStore();
    if (!store[id]) return;
    if (characterId === undefined) {
        delete store[id];
    } else {
        delete store[id][trim(characterId, 160) || GLOBAL_SCOPE];
        if (Object.keys(store[id]).length === 0) delete store[id];
    }
    writeStore(store);
}

export function readCustomAppChatContexts(appId: string): CustomAppChatContextEntry[] {
    const bucket = readStore()[trim(appId, 160)];
    return bucket ? Object.values(bucket) : [];
}

/**
 * 汇总当前对该角色生效的片段。只认还装着、且还持有 chat.context 权限的 app——
 * 用户在权限页撤销授权后注入必须立刻停，不能靠 app 自己收手。
 */

const CONTEXT_STALE_MS = 6 * 60 * 60 * 1000;
function isStaleContext(updatedAt: unknown): boolean {
    const at = Number(updatedAt);
    if (!Number.isFinite(at) || at <= 0) return false;
    if (Date.now() - at > CONTEXT_STALE_MS) return true;
    const a = new Date(at), n = new Date();
    return a.getFullYear() !== n.getFullYear() || a.getMonth() !== n.getMonth() || a.getDate() !== n.getDate();
}

export function formatCustomAppChatContextForPrompt(characterId?: string): string {
    const store = readStore();
    if (Object.keys(store).length === 0) return "";
    const allowed = new Map(
        loadInstalledCustomApps()
            .filter(app => app.permissions.includes("chat.context"))
            .map(app => [app.id, app.name]),
    );
    if (allowed.size === 0) return "";

    const scope = trim(characterId, 160);
    const blocks: string[] = [];
    for (const [appId, bucket] of Object.entries(store)) {
        if (!allowed.has(appId)) continue;
        const entry = (scope && bucket[scope]) || bucket[GLOBAL_SCOPE];
        if (!entry?.text?.trim()) continue;
        // app 关着就不再刷新，写死的「在开会」过几小时就是假话；隔了天更别当此刻
        if (isStaleContext(entry.updatedAt)) continue;
        const name = allowed.get(appId) || entry.appName || appId;
        const title = entry.label ? `【${name} · ${entry.label}】` : `【${name}】`;
        blocks.push(`${title}\n${entry.text.trim()}`);
    }
    if (blocks.length === 0) return "";

    return [
        "<app_context>",
        "以下是你手机里的 app 同步过来的、你此刻的真实状态。当成刚发生的事实来演，",
        "不要复述字段名，也不要说这些信息来自哪个 app。",
        "",
        blocks.join("\n\n"),
        "</app_context>",
    ].join("\n");
}
