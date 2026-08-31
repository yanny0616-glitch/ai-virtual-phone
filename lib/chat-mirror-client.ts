// 聊天镜像：把新产生的聊天消息抄送一份到用户自己的个人云（Supabase）。
// 纯加法——本地 IndexedDB 仍是唯一事实来源，镜像失败不影响任何聊天功能。
// 用途：让云端离线判断（未回应降速、动态复核）与挂念面板能看到最新对话。
// 安全模型与离线推送一致：只发往用户自己的项目、service key 逐次校验、
// 表仅 service_role 可读写；开关默认关闭，云端数据可随时一键清空。

import {
    CHAT_MESSAGE_PUSHED_EVENT,
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
};

let installed = false;
let flushing = false;
let flushTimer: number | null = null;
let retryTimer: number | null = null;
// 网关能力探测缓存：null=未探测，true/false=本次会话内的结论。
// 旧版个人云函数没有 chat-mirror 动作，探测失败时静默停发（不丢队列）。
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
    const contact = loadChatContacts().find(item => item.id === session.contactId);
    return contact?.characterId || "";
}

function toMirrorEntry(msg: ChatMessage): ChatMirrorEntry | null {
    if (msg.role !== "user" && msg.role !== "assistant") return null;
    const characterId = characterIdForSession(msg.sessionId);
    // 群聊会话（characterId 解析不到单一角色）暂不镜像，控制数据量与隐私面。
    if (!characterId) return null;
    const content = (msg.content || getChatMessagePreview(msg) || "").slice(0, CONTENT_MAX);
    return {
        id: msg.id,
        sessionId: msg.sessionId,
        characterId,
        role: msg.role,
        content,
        mediaType: msg.mediaType || undefined,
        createdAt: msg.createdAt,
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

/** 开关镜像；开启时回填最近会话，让云端判断立刻有上下文可用。 */
export function setChatMirrorEnabled(enabled: boolean): void {
    kvSet(MIRROR_ENABLED_KEY, enabled ? "1" : "0");
    if (enabled) {
        mirrorCapable = null; // 用户刚可能重新部署过，重新探测
        backfillRecentChat();
        scheduleFlush();
    }
}

/** 回填最近 10 个单聊会话、每个最多 60 条，安静补齐云端上下文。 */
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

/** 清空云端镜像（全部或指定角色）。本地聊天记录不受影响。 */
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

/** 应用启动时挂载：监听消息落库事件，把新消息排队抄送到个人云。 */
export function installChatMirror(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;
    window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, event => {
        if (!isChatMirrorEnabled() || !isPersonalPushCloudActive()) return;
        const message = (event as CustomEvent<{ message?: ChatMessage }>).detail?.message;
        if (!message) return;
        const entry = toMirrorEntry(message);
        if (entry) enqueue(entry);
    });
    if (retryTimer === null) {
        retryTimer = window.setInterval(() => {
            if (getChatMirrorQueueSize() > 0) void flushQueue();
        }, RETRY_INTERVAL_MS);
    }
    if (isChatMirrorEnabled() && getChatMirrorQueueSize() > 0) scheduleFlush();
}
