import { kvGet, kvSet } from "./kv-db";
import { getChatMessagePreview, isSystemInstructionMessage, type ChatMessage } from "./chat-storage";

const PRESETS_KEY = "ai_phone_chat_reroll_presets_v1";
const ATTACH_PREVIOUS_KEY = "ai_phone_chat_reroll_attach_previous_v1";
// 版本正文存在 kv 里：媒体清理会扫描全部 kv 字符串，旧版本引用的图片因此不会被当成孤儿删掉
const VERSIONS_KEY = "ai_phone_chat_reply_versions_v1";
const MAX_VERSIONS = 8;
const PREVIOUS_REPLY_LIMIT = 1500;

export const REROLL_QUICK_TAGS: ReadonlyArray<{ label: string; prompt: string }> = [
    { label: "角色 OOC", prompt: "角色 OOC，言行不符合人设" },
    { label: "忘了前文", prompt: "忘了前文，和之前说过的内容对不上" },
    { label: "搞错事情", prompt: "搞错了事实或细节" },
    { label: "太短", prompt: "回复太短" },
    { label: "太长", prompt: "回复太长" },
    { label: "重复前文", prompt: "重复了前文的内容或句式" },
];

function readJson(key: string): unknown {
    try {
        const raw = kvGet(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function loadRerollPresets(): string[] {
    const list = readJson(PRESETS_KEY);
    if (!Array.isArray(list)) return [];
    return list.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function saveRerollPresets(list: string[]): void {
    kvSet(PRESETS_KEY, JSON.stringify(list));
}

export function loadRerollAttachPrevious(): boolean {
    return kvGet(ATTACH_PREVIOUS_KEY) !== "0";
}

export function saveRerollAttachPrevious(value: boolean): void {
    kvSet(ATTACH_PREVIOUS_KEY, value ? "1" : "0");
}

function messageLines(messages: ChatMessage[]): string[] {
    return messages
        .filter(m => m.role === "assistant" && !m.isRetracted)
        .map(m => (getChatMessagePreview(m) || m.content || "").trim())
        .filter(Boolean);
}

export function buildRerollInstruction(params: { tags: string[]; note: string; previousReply?: ChatMessage[] }): string | null {
    const picked = REROLL_QUICK_TAGS.filter(tag => params.tags.includes(tag.label)).map(tag => tag.prompt);
    const note = params.note.trim();
    if (picked.length === 0 && !note) return null;
    const lines = ["【重写要求】用户对你刚才这一轮回复不满意，请重新写这一轮。"];
    if (picked.length > 0) lines.push(`问题：${picked.join("；")}。`);
    if (note) lines.push(`用户说明：${note}`);
    const previous = params.previousReply ? messageLines(params.previousReply).join("\n") : "";
    if (previous) {
        const clipped = previous.length > PREVIOUS_REPLY_LIMIT ? `${previous.slice(0, PREVIOUS_REPLY_LIMIT)}…` : previous;
        lines.push(`被否掉的上一版如下，只用来对照哪里要改，不要照抄，也不要在回复里提到重写：\n${clipped}`);
    }
    return lines.join("\n");
}

type ReplyVersion = { createdAt: string; messages: ChatMessage[] | null };
export type ReplyVersionSet = { anchorId: string | null; versions: ReplyVersion[]; active: number };

function loadStore(): Record<string, ReplyVersionSet> {
    const store = readJson(VERSIONS_KEY);
    return store && typeof store === "object" && !Array.isArray(store) ? store as Record<string, ReplyVersionSet> : {};
}

function writeSet(sessionId: string, set: ReplyVersionSet | null): void {
    const store = loadStore();
    if (set) store[sessionId] = set;
    else if (store[sessionId]) delete store[sessionId];
    else return;
    kvSet(VERSIONS_KEY, JSON.stringify(store));
}

function tailAfterAnchor(messages: ChatMessage[], anchorId: string | null): ChatMessage[] | null {
    if (anchorId === null) return messages;
    const index = messages.findIndex(m => m.id === anchorId);
    return index < 0 ? null : messages.slice(index + 1);
}

function isUserTurn(msg: ChatMessage): boolean {
    return msg.role === "user" || isSystemInstructionMessage(msg);
}

/** messages 须为会话全量且已排序；用户发过新消息或锚点被删后返回 null。 */
export function getLiveReplyVersions(sessionId: string, messages: ChatMessage[]): { set: ReplyVersionSet; tail: ChatMessage[] } | null {
    const set = loadStore()[sessionId];
    if (!set || !Array.isArray(set.versions) || set.versions.length < 2) return null;
    const tail = tailAfterAnchor(messages, set.anchorId);
    if (!tail || tail.some(isUserTurn)) return null;
    return { set, tail };
}

/** 重试删除前调用：被删的尾巴存成一版，并给这次生成占住「正在用」的位置。 */
/** 返回 rollback：这一次重试没产出时把版本记录恢复成重试前的样子，免得选择器里多一版空的。 */
export function recordReplyVersionBeforeRetry(sessionId: string, messages: ChatMessage[], targetIndex: number): { rollback: () => void } {
    const before = loadStore()[sessionId] ?? null;
    const rollback = () => writeSet(sessionId, before);
    const removed = messages.slice(targetIndex);
    if (removed.length === 0 || removed.some(isUserTurn)) {
        writeSet(sessionId, null);
        return { rollback };
    }
    const anchorId = targetIndex > 0 ? messages[targetIndex - 1].id : null;
    const now = new Date().toISOString();
    const live = getLiveReplyVersions(sessionId, messages);
    let set: ReplyVersionSet;
    if (live && live.set.anchorId === anchorId) {
        const versions = live.set.versions.map((v, i) => (i === live.set.active ? { ...v, messages: removed } : v));
        versions.push({ createdAt: now, messages: null });
        set = { anchorId, versions, active: versions.length - 1 };
    } else {
        set = { anchorId, versions: [{ createdAt: removed[0].createdAt, messages: removed }, { createdAt: now, messages: null }], active: 1 };
    }
    while (set.versions.length > MAX_VERSIONS) {
        set.versions.shift();
        set.active -= 1;
    }
    writeSet(sessionId, set);
    return { rollback };
}

export type ReplyVersionView = { index: number; createdAt: string; lines: string[]; active: boolean };

export function describeReplyVersions(live: { set: ReplyVersionSet; tail: ChatMessage[] }): ReplyVersionView[] {
    return live.set.versions.map((version, index) => ({
        index,
        createdAt: version.createdAt,
        lines: messageLines(version.messages ?? live.tail),
        active: index === live.set.active,
    }));
}

/** 只算不写：调用方删掉 removeFromId 起的尾巴、放回 restore 成功后，再 commit。 */
export function planReplyVersionSwitch(sessionId: string, messages: ChatMessage[], target: number): {
    removeFromId: string | null;
    removed: ChatMessage[];
    restore: ChatMessage[];
    commit: () => void;
} | null {
    const live = getLiveReplyVersions(sessionId, messages);
    if (!live || target === live.set.active || !live.set.versions[target]) return null;
    const restore = live.set.versions[target].messages ?? [];
    const versions = live.set.versions.map((v, i) => {
        if (i === live.set.active) return { ...v, messages: live.tail };
        if (i === target) return { ...v, messages: null };
        return v;
    });
    return {
        removeFromId: live.tail[0]?.id ?? null,
        removed: live.tail,
        restore,
        commit: () => writeSet(sessionId, { ...live.set, versions, active: target }),
    };
}
