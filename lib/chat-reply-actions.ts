// 角色回复里的「动作」指令：撤回自己的话、给对方的消息贴表情、引用时对准具体那一条。
// 这些指令不出气泡，由解析器摘出来（见 rich-message-parser 的 actions），
// 本轮气泡放完后由聊天页按原话片段反查目标消息再落地。纯函数，不碰存储。

import type { ChatMessage } from "./chat-storage";

export type ReplyRoundAction =
    | { kind: "recall"; text: string }
    | { kind: "react"; emoji: string; target: string };

const RECALL_RE = /\[撤回\s*[:：]\s*([^\]\n]*)\]/g;
const REACT_RE = /\[回应\s*[:：]\s*([^\]|｜\n]+?)\s*(?:[|｜]\s*([^\]\n]*))?\]/g;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** 从回复原文里摘出撤回 / 表情回应指令，返回去掉指令后的文本。一轮最多一次撤回、两个表情。 */
export function extractReplyRoundActions(text: string): { text: string; actions: ReplyRoundAction[] } {
    const actions: ReplyRoundAction[] = [];
    let recalls = 0;
    let reacts = 0;
    let cleaned = text.replace(RECALL_RE, (_m, raw: string) => {
        const target = raw.trim();
        if (recalls < 1) actions.push({ kind: "recall", text: target });
        recalls += 1;
        return "";
    });
    cleaned = cleaned.replace(REACT_RE, (_m, rawEmoji: string, rawTarget?: string) => {
        const emoji = rawEmoji.trim();
        // 只认真 emoji，模型写成「[回应:好的]」这种不是表情的直接丢掉
        if (EMOJI_RE.test(emoji) && emoji.length <= 16 && reacts < 2) {
            actions.push({ kind: "react", emoji, target: (rawTarget || "").trim() });
            reacts += 1;
        }
        return "";
    });
    return { text: cleaned, actions };
}

/** 比较用：去掉空白和标点，英文转小写 */
function normalizeForMatch(value: string): string {
    return value.replace(/[\s\p{P}]/gu, "").toLowerCase();
}

function messageMatchText(msg: ChatMessage): string {
    const label = msg.mediaData?.label || msg.mediaData?.quotePreview || "";
    return msg.content || label;
}

function textMatches(msg: ChatMessage, needle: string): boolean {
    const n = normalizeForMatch(needle);
    if (!n) return false;
    const c = normalizeForMatch(messageMatchText(msg));
    if (!c) return false;
    return c.includes(n) || (c.length >= 2 && n.includes(c));
}

const isChatBubble = (msg: ChatMessage): boolean =>
    (msg.role === "user" || msg.role === "assistant")
    && !msg.isRetracted
    && msg.mediaType !== "tool_call" && msg.mediaType !== "tool_result" && msg.mediaType !== "tool_notice"
    && msg.mediaType !== "system_instruction";

const RECALL_WINDOW_MS = 10 * 60 * 1000;

/** 角色要撤回的那条：最近 12 条里、10 分钟内、角色自己发的、文字对得上的最新一条。 */
export function findRecallTarget(messages: ChatMessage[], text: string, now = Date.now()): ChatMessage | null {
    const recent = messages.slice(-12);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i];
        if (msg.role !== "assistant" || !isChatBubble(msg)) continue;
        if (now - new Date(msg.createdAt).getTime() > RECALL_WINDOW_MS) continue;
        if (!text.trim() || textMatches(msg, text)) return msg;
    }
    return null;
}

/** 表情回应的目标：最近 30 条里用户发的、文字对得上的最新一条；没给片段就是用户最新一条。 */
export function findReactionTarget(messages: ChatMessage[], target: string): ChatMessage | null {
    const recent = messages.slice(-30);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i];
        if (msg.role !== "user" || !isChatBubble(msg)) continue;
        if (!target.trim() || textMatches(msg, target)) return msg;
    }
    return null;
}

/** 角色 [引用:原文] 指向的那条：最近 40 条里文字对得上的最新一条（双方的都算）。 */
export function findQuoteTarget(messages: ChatMessage[], preview: string): ChatMessage | null {
    if (!preview.trim()) return null;
    const recent = messages.slice(-40);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i];
        if (!isChatBubble(msg) || msg.mediaType === "quote") continue;
        if (textMatches(msg, preview)) return msg;
    }
    // 引用别人的引用回复：拿它的回复正文比
    for (let i = recent.length - 1; i >= 0; i -= 1) {
        const msg = recent[i];
        if (isChatBubble(msg) && msg.mediaType === "quote" && msg.content && textMatches({ ...msg, mediaData: undefined }, preview)) return msg;
    }
    return null;
}

/** 本轮表情加到目标消息上：同一个表情不重复，最多留 3 个 */
export function addReaction(
    reactions: ChatMessage["reactions"],
    emoji: string,
    responseBatchId: string,
): NonNullable<ChatMessage["reactions"]> | null {
    const list = reactions ? [...reactions] : [];
    if (list.some(r => r.emoji === emoji)) return null;
    list.push({ emoji, responseBatchId });
    return list.slice(-3);
}
