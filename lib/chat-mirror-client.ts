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
const QUEUE_CAP = 5_000;
const FLUSH_BATCH = 50;
const FLUSH_DEBOUNCE_MS = 2_500;
const RETRY_INTERVAL_MS = 60_000;
const CONTENT_MAX = 4_000;
// 回填范围：开开关那次、以及队列为空时手动点「立即上传」抓的量。
// 上限 = SESSIONS × PER_SESSION，要留在 QUEUE_CAP 以内，否则前面的会被挤掉。
const BACKFILL_SESSIONS = 20;
const BACKFILL_PER_SESSION = 200;

registerKvMigration(MIRROR_ENABLED_KEY);
registerKvMigration(MIRROR_QUEUE_KEY);

export type ChatMirrorEntry = {
    id: string;
    /** 本地排队操作的版本，确认旧请求时不能删掉同一消息的新编辑。 */
    queueId?: string;
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
let flushPromise: Promise<{ sent: number; queued: number }> | null = null;
let clearPromise: Promise<void> | null = null;
let flushTimer: number | null = null;
let retryTimer: number | null = null;
// null=未探测；旧版个人云函数没有 chat-mirror 动作，探测失败时静默停发（不丢队列）。
let mirrorCapable: boolean | null = null;
let capabilityCheckedAt = 0;
const CAPABILITY_TTL_MS = 5 * 60_000;

export function isChatMirrorEnabled(): boolean {
    return kvGet(MIRROR_ENABLED_KEY) === "1";
}

function loadQueue(): ChatMirrorEntry[] {
    try {
        const raw = kvGet(MIRROR_QUEUE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        const latest = new Map<string, ChatMirrorEntry>();
        let changed = false;
        for (const entry of parsed as ChatMirrorEntry[]) {
            if (latest.has(entry.id)) { latest.delete(entry.id); changed = true; }
            if (!entry.queueId) changed = true;
            latest.set(entry.id, { ...entry, queueId: entry.queueId || crypto.randomUUID() });
        }
        const queue = [...latest.values()];
        if (changed) saveQueue(queue);
        return queue;
    } catch {
        return [];
    }
}

function saveQueue(queue: ChatMirrorEntry[]): void {
    kvSet(MIRROR_QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_CAP).map(entry => ({ ...entry, queueId: entry.queueId || crypto.randomUUID() }))));
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

/**
 * 镜像正文：云端只拿得到这一段文字，看不到 mediaData。
 * 预览函数把语音条、红包留言、位置名、表情名都截成了 [语音] 这样的固定标记，
 * 引用则只剩回复本身、丢了被引的原话——判断时这些恰恰是有信息量的部分，这里补回去。
 * 媒体文件本身（图片 base64、音频）仍然不上云。
 */
function mirrorText(msg: ChatMessage): string {
    const label = msg.mediaData?.label?.trim() || "";
    if (msg.mediaType === "quote") {
        const quoted = msg.mediaData?.quotePreview?.trim() || "";
        const body = (msg.content || "").trim();
        return quoted ? `引用「${quoted}」：${body}` : body;
    }
    const base = (msg.content || getChatMessagePreview(msg) || "").trim();
    // 图片的预览已经是「[图片] 描述」，别再拼一遍
    if (label && !base.includes(label)) return base ? `${base} ${label}` : label;
    return base;
}

function toMirrorEntry(msg: ChatMessage, deleted?: true): ChatMirrorEntry | null {
    if (msg.role !== "user" && msg.role !== "assistant") return null;
    const characterId = characterIdForSession(msg.sessionId);
    // 群聊会话（characterId 解析不到单一角色）暂不镜像，控制数据量与隐私面。
    // 删除例外：会话可能已经没了，按 id 删不需要角色。
    if (!characterId && !deleted) return null;
    const content = deleted ? "" : mirrorText(msg).slice(0, CONTENT_MAX);
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
    if (mirrorCapable !== null && Date.now() - capabilityCheckedAt < CAPABILITY_TTL_MS) return mirrorCapable;
    mirrorCapable = null;
    try {
        const res = await personalPushFetch("health", { method: "GET" });
        const data = await res.json().catch(() => null) as { ok?: boolean; capabilities?: string[] } | null;
        // 临时 HTTP 错误、网关错误页和无效 JSON 都不是“不支持”的证据。
        if (!res.ok || data?.ok !== true || !Array.isArray(data.capabilities)) return false;
        mirrorCapable = data.capabilities.includes("chat-mirror");
        capabilityCheckedAt = Date.now();
    } catch {
        // 网络抖动不下结论，下次再探
        return false;
    }
    return mirrorCapable;
}

/** 自动和手动上传共用一个任务；确认时只删除实际送达的操作版本。 */
function uploadQueue(manual = false): Promise<{ sent: number; queued: number }> {
    if (clearPromise) return clearPromise.then(() => uploadQueue(manual));
    if (flushPromise) return flushPromise;
    const run = async () => {
        if (!isChatMirrorEnabled()) throw new Error("聊天镜像开关未开启。");
        if (!isPersonalPushCloudActive()) throw new Error("个人云离线推送未部署或未激活。");
        if (manual) mirrorCapable = null;
        if (!await checkMirrorCapability()) throw new Error("无法确认聊天镜像能力，请检查网络或重新部署离线推送。");
        if (clearPromise) return { sent: 0, queued: getChatMirrorQueueSize() };
        if (manual && loadQueue().length === 0) backfillRecentChat();
        let sent = 0;
        for (;;) {
            // 用户关掉镜像后，不再发送下一批。
            if (clearPromise || !isChatMirrorEnabled() || !isPersonalPushCloudActive()) break;
            const batch = loadQueue().slice(0, FLUSH_BATCH);
            if (batch.length === 0) break;
            const res = await personalPushFetch("chat-mirror", {
                method: "POST",
                body: JSON.stringify({ entries: batch }),
            });
            const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
            if (!res.ok || !data?.ok) throw new Error(data?.error || `上传失败：HTTP ${res.status}（已传 ${sent} 条）`);
            const acknowledged = new Set(batch.map(entry => entry.queueId));
            saveQueue(loadQueue().filter(entry => !acknowledged.has(entry.queueId)));
            sent += batch.length;
        }
        return { sent, queued: getChatMirrorQueueSize() };
    };
    flushPromise = run().finally(() => { flushPromise = null; });
    return flushPromise;
}

async function flushQueue(): Promise<void> {
    try { await uploadQueue(); } catch { /* 自动上传失败留队，下一轮重试，不打扰聊天。 */ }
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
    const queue = loadQueue().filter(item => item.id !== entry.id);
    queue.push({ ...entry, queueId: crypto.randomUUID() });
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
            .slice(0, BACKFILL_SESSIONS);
        const queue = loadQueue();
        const queued = new Set(queue.map(item => item.id));
        for (const session of sessions) {
            for (const msg of loadChatMessages(session.id, BACKFILL_PER_SESSION)) {
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
    return uploadQueue(true);
}

export function clearChatMirrorCloud(characterId?: string): Promise<void> {
    if (clearPromise) return clearPromise.then(() => clearChatMirrorCloud(characterId));
    // 划定清空边界；期间新增的操作（包括同一消息的新编辑）必须留下。
    const beforeClear = new Set(loadQueue()
        .filter(entry => !characterId || entry.characterId === characterId)
        .map(entry => entry.queueId));
    const uploading = flushPromise;
    clearPromise = Promise.resolve().then(async () => {
        // 已发出的请求必须先结束，防止 DELETE 成功后旧 POST 又把消息写回来。
        await uploading?.catch(() => undefined);
        const res = await personalPushFetch("chat-mirror", {
            method: "DELETE",
            body: JSON.stringify(characterId ? { characterId } : {}),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !data?.ok) {
            throw new Error(data?.error || `云函数返回 HTTP ${res.status}（旧版函数不支持聊天镜像，请到云服务部署里重新部署离线推送）`);
        }
        saveQueue(loadQueue().filter(entry => !beforeClear.has(entry.queueId)));
    }).finally(() => {
        clearPromise = null;
        if (isChatMirrorEnabled() && getChatMirrorQueueSize() > 0) scheduleFlush();
    });
    return clearPromise;
}

export function installChatMirror(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;
    // 镜像跟着本地变：新增、编辑、整批重生成都按 id 覆盖，删除按 id 删。
    // 云端裁决读的就是这份镜像，本地删掉的话不该再被当成还在。
    // 只有 id 在手（整批重建顶掉的旧消息）：云端删除只认 id，其余字段填个能过表约束的空壳
    const mirrorDeletedIds = (ids: string[], sessionId: string) => {
        if (!isChatMirrorEnabled() || !isPersonalPushCloudActive()) return;
        for (const id of ids) {
            if (!id) continue;
            enqueue({ id, sessionId, characterId: "", role: "assistant", content: "", createdAt: new Date().toISOString(), deleted: true });
        }
    };
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
        const detail = (event as CustomEvent<{ messages?: ChatMessage[]; replacedIds?: string[]; sessionId?: string }>).detail;
        // 重建出来的是新 id，旧的那几条本地已经没了：不删的话云端会一直留着看不见的旧版本
        if (Array.isArray(detail?.replacedIds) && detail.replacedIds.length > 0) {
            mirrorDeletedIds(detail.replacedIds, detail.sessionId || "");
        }
        if (Array.isArray(detail?.messages)) mirrorMessages(detail.messages);
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
