// 聊天镜像：把新聊天消息抄送到用户个人云（Supabase），供云端判断使用；纯加法，本地 IndexedDB 仍是唯一事实来源，镜像失败不影响聊天。
// 安全模型与离线推送一致：只发往用户自己项目、service key 逐次校验、表仅 service_role 可读写；开关默认关闭。

import {
    CHAT_MESSAGE_EDITED_EVENT,
    CHAT_MESSAGE_PUSHED_EVENT,
    CHAT_MESSAGES_DELETED_EVENT,
    CHAT_RESPONSE_BATCH_REPLACED_EVENT,
    getChatMessagePreview,
    loadChatContacts,
    loadChatMessages,
    loadChatSessions,
    type ChatMessage,
} from "./chat-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { isPersonalPushCloudActive, personalPushFetch } from "./personal-push-cloud";

const MIRROR_ENABLED_KEY = "chat_mirror_enabled_v1";
const MIRROR_QUEUE_KEY = "chat_mirror_queue_v1";
const QUEUE_CAP = 800;
const FLUSH_BATCH = 50;
const FLUSH_DEBOUNCE_MS = 2_500;
const RETRY_INTERVAL_MS = 60_000;
const CONTENT_MAX = 4_000;

registerKvMigration(MIRROR_ENABLED_KEY);
registerKvMigration(MIRROR_QUEUE_KEY);

export type ChatMirrorEntry = {
    id: string;
    sessionId: string;
    characterId: string;
    role: "user" | "assistant";
    content: string;
    mediaType?: string;
    createdAt: string;
    /** 本地删掉了这条：云端按 id 删。内容留空 */
    deleted?: true;
};

let installed = false;
let flushing = false;
let flushTimer: number | null = null;
let retryTimer: number | null = null;
// null=未探测；旧版个人云函数没有 chat-mirror 动作，探测失败时静默停发（不丢队列）。
let mirrorCapable: boolean | null = null;

export function isChatMirrorEnabled(): boolean {
    return kvGet(MIRROR_ENABLED_KEY) === "1";
}

function loadQueue(): ChatMirrorEntry[] {
    try {
        const raw = kvGet(MIRROR_QUEUE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed as ChatMirrorEntry[] : [];
    } catch {
        return [];
    }
}

function saveQueue(queue: ChatMirrorEntry[]): void {
    kvSet(MIRROR_QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_CAP)));
}

export function getChatMirrorQueueSize(): number {
    return loadQueue().length;
}

function characterIdForSession(sessionId: string): string {
    const session = loadChatSessions().find(item => item.id === sessionId);
    if (!session || session.isGroup) return "";
    // session.contactId 存的直接就是 characterId（contact.id 是另一套 contact_ 前缀 ID）；
    // 两种口径都查一遍做兼容，查不到就把 contactId 当角色 ID 用，避免整条会话被静默丢弃。
    const cid = session.contactId || "";
    if (!cid) return "";
    const contact = loadChatContacts().find(item => item.characterId === cid || item.id === cid);
    return contact?.characterId || cid;
}

function toMirrorEntry(msg: ChatMessage, deleted?: true): ChatMirrorEntry | null {
    if (msg.role !== "user" && msg.role !== "assistant") return null;
    const characterId = characterIdForSession(msg.sessionId);
    // 群聊会话（characterId 解析不到单一角色）暂不镜像，控制数据量与隐私面。
    // 删除例外：会话可能已经没了，按 id 删不需要角色。
    if (!characterId && !deleted) return null;
    const content = deleted ? "" : (msg.content || getChatMessagePreview(msg) || "").slice(0, CONTENT_MAX);
    return {
        id: msg.id,
        sessionId: msg.sessionId,
        characterId,
        role: msg.role,
        content,
        mediaType: msg.mediaType || undefined,
        createdAt: msg.createdAt,
        ...(deleted ? { deleted: true as const } : {}),
    };
}

async function checkMirrorCapability(): Promise<boolean> {
    if (mirrorCapable !== null) return mirrorCapable;
    try {
        const res = await personalPushFetch("health", { method: "GET" });
        const data = await res.json().catch(() => null) as { ok?: boolean; capabilities?: string[] } | null;
        mirrorCapable = Boolean(res.ok && data?.ok && data.capabilities?.includes("chat-mirror"));
    } catch {
        // 网络抖动不下结论，下次再探
        return false;
    }
    return mirrorCapable;
}

async function flushQueue(): Promise<void> {
    if (flushing || !isChatMirrorEnabled() || !isPersonalPushCloudActive()) return;
    flushing = true;
    try {
        if (!await checkMirrorCapability()) return;
        for (;;) {
            const queue = loadQueue();
            if (queue.length === 0) return;
            const batch = queue.slice(0, FLUSH_BATCH);
            const res = await personalPushFetch("chat-mirror", {
                method: "POST",
                body: JSON.stringify({ entries: batch }),
            });
            const data = await res.json().catch(() => null) as { ok?: boolean } | null;
            if (!res.ok || !data?.ok) return; // 留在队列里，等下一轮重试
            saveQueue(loadQueue().slice(batch.length));
        }
    } catch {
        // 静默：镜像永不打扰聊天主流程
    } finally {
        flushing = false;
    }
}

function scheduleFlush(): void {
    if (typeof window === "undefined") return;
    if (flushTimer !== null) window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
        flushTimer = null;
        void flushQueue();
    }, FLUSH_DEBOUNCE_MS);
}

function enqueue(entry: ChatMirrorEntry): void {
    const queue = loadQueue();
    queue.push(entry);
    saveQueue(queue);
    scheduleFlush();
}

/** 开启时回填最近会话，让云端判断立刻有上下文可用。 */
export function setChatMirrorEnabled(enabled: boolean): void {
    kvSet(MIRROR_ENABLED_KEY, enabled ? "1" : "0");
    if (enabled) {
        mirrorCapable = null; // 用户刚可能重新部署过，重新探测
        backfillRecentChat();
        scheduleFlush();
    }
}

function backfillRecentChat(): void {
    try {
        const sessions = loadChatSessions()
            .filter(session => !session.isGroup)
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
            .slice(0, 10);
        const queue = loadQueue();
        const queued = new Set(queue.map(item => item.id));
        for (const session of sessions) {
            for (const msg of loadChatMessages(session.id, 60)) {
                if (queued.has(msg.id)) continue;
                const entry = toMirrorEntry(msg);
                if (entry) {
                    queue.push(entry);
                    queued.add(entry.id);
                }
            }
        }
        saveQueue(queue);
    } catch {
        // 回填失败无妨，后续消息仍会逐条镜像
    }
}

/** 手动触发一次上传并暴露真实错误（设置页排障用；自动流程仍走静默的 flushQueue）。 */
export async function flushChatMirrorNow(): Promise<{ sent: number; queued: number }> {
    if (!isChatMirrorEnabled()) throw new Error("聊天镜像开关未开启。");
    if (!isPersonalPushCloudActive()) throw new Error("个人云离线推送未部署或未激活。");
    mirrorCapable = null; // 可能刚重新部署过，重新探测
    const res = await personalPushFetch("health", { method: "GET" });
    const health = await res.json().catch(() => null) as { ok?: boolean; capabilities?: string[]; error?: string } | null;
    if (!res.ok || !health?.ok) throw new Error(health?.error || `健康检查失败：HTTP ${res.status}`);
    if (!health.capabilities?.includes("chat-mirror")) {
        throw new Error("云函数版本偏旧，不支持聊天镜像。请重新部署离线推送。");
    }
    mirrorCapable = true;
    if (loadQueue().length === 0) backfillRecentChat();
    let sent = 0;
    for (;;) {
        const queue = loadQueue();
        if (queue.length === 0) break;
        const batch = queue.slice(0, FLUSH_BATCH);
        const post = await personalPushFetch("chat-mirror", {
            method: "POST",
            body: JSON.stringify({ entries: batch }),
        });
        const data = await post.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        if (!post.ok || !data?.ok) {
            throw new Error(data?.error || `上传失败：HTTP ${post.status}（已传 ${sent} 条，剩 ${queue.length} 条）`);
        }
        sent += batch.length;
        saveQueue(loadQueue().slice(batch.length));
    }
    return { sent, queued: getChatMirrorQueueSize() };
}

export async function clearChatMirrorCloud(characterId?: string): Promise<void> {
    const res = await personalPushFetch("chat-mirror", {
        method: "DELETE",
        body: JSON.stringify(characterId ? { characterId } : {}),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `云函数返回 HTTP ${res.status}（旧版函数不支持聊天镜像，请到云服务部署里重新部署离线推送）`);
    }
}

export function installChatMirror(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;
    // 镜像跟着本地变：新增、编辑、整批重生成都按 id 覆盖，删除按 id 删。
    // 云端裁决读的就是这份镜像，本地删掉的话不该再被当成还在。
    const mirrorMessages = (messages: ChatMessage[], deleted?: true) => {
        if (!isChatMirrorEnabled() || !isPersonalPushCloudActive()) return;
        for (const message of messages) {
            const entry = toMirrorEntry(message, deleted);
            if (entry) enqueue(entry);
        }
    };
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, event => {
        const message = (event as CustomEvent<{ message?: ChatMessage }>).detail?.message;
        if (message) mirrorMessages([message]);
    });
    window.addEventListener(CHAT_MESSAGE_EDITED_EVENT, event => {
        const message = (event as CustomEvent<{ message?: ChatMessage }>).detail?.message;
        if (message) mirrorMessages([message]);
    });
    window.addEventListener(CHAT_RESPONSE_BATCH_REPLACED_EVENT, event => {
        const messages = (event as CustomEvent<{ messages?: ChatMessage[] }>).detail?.messages;
        if (Array.isArray(messages)) mirrorMessages(messages);
    });
    window.addEventListener(CHAT_MESSAGES_DELETED_EVENT, event => {
        const messages = (event as CustomEvent<{ messages?: ChatMessage[] }>).detail?.messages;
        if (Array.isArray(messages)) mirrorMessages(messages, true);
    });
    if (retryTimer === null) {
        retryTimer = window.setInterval(() => {
            if (getChatMirrorQueueSize() > 0) void flushQueue();
        }, RETRY_INTERVAL_MS);
    }
    if (isChatMirrorEnabled() && getChatMirrorQueueSize() > 0) scheduleFlush();
}
