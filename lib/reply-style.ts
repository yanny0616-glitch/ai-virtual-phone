import { loadCharacters } from "./character-storage";
import {
    CHAT_OFFLINE_MODE_CHANGED_EVENT,
    CHAT_OFFLINE_MODE_PREFIX,
    pushChatMessage,
    type ChatSession,
} from "./chat-storage";
import { kvSet } from "./kv-db";
import { resolveUserIdentity } from "./settings-storage";

export type ReplyLengthMode = NonNullable<ChatSession["replyLength"]>;

export const REPLY_LENGTH_MODES: { id: ReplyLengthMode; label: string; desc: string }[] = [
    { id: "mood", label: "跟情绪", desc: "平时 1～4 句，激动、委屈、有好消息时可以多说几句" },
    { id: "short", label: "短", desc: "1～2 句，像在忙着回" },
    { id: "mid", label: "中", desc: "2～4 句" },
    { id: "long", label: "长", desc: "4～6 句，愿意展开说" },
    { id: "custom", label: "自定", desc: "每轮说几句你来定" },
];

export const REPLY_COUNT_MAX = 12;
const FIXED: Partial<Record<ReplyLengthMode, [number, number]>> = { short: [1, 2], mid: [2, 4], long: [4, 6] };

export function replyRange(session: Pick<ChatSession, "replyLength" | "replyMin" | "replyMax">): [number, number] | null {
    const mode = session.replyLength ?? "mood";
    if (mode === "custom") {
        const min = Math.max(1, Math.min(REPLY_COUNT_MAX, Math.round(session.replyMin ?? 1)));
        return [min, Math.max(min, Math.min(REPLY_COUNT_MAX, Math.round(session.replyMax ?? 4)))];
    }
    return FIXED[mode] ?? null;
}

/** {{replyStyle}}：全是默认时为空，预设条目整条不出现，和没这功能时一字不差 */
export function buildReplyStylePrompt(session: ChatSession, mode: "text" | "offline" | "other"): string {
    if (session.isGroup || mode === "other") return "";
    const lines: string[] = [];
    if (mode === "text") {
        const range = replyRange(session);
        if (range) {
            const count = range[0] === range[1] ? `${range[0]}` : `${range[0]}～${range[1]}`;
            lines.push(`- 回复长度：这段聊天每轮说 ${count} 句。以这条为准，盖过上面「大部分1-4句话」的说法。`);
        }
        if (session.singleBubble) lines.push("- 一轮回复写成一条消息：不要用空行拆成几条，要换话题就直接换行。表情包、照片这类方括号标记照旧单独一行。");
        if (session.onlineActions) lines.push("- 可以用 *星号* 包一小段看得见的动作或神态，比如 *揉了揉眼睛*，一轮最多一两处；星号里不写心理独白。语音条里仍然不写动作。");
        if (session.autoModeSwitch) lines.push("- 如果聊着聊着你们真的见面了（到了同一个地方、面对面），在回复最后单独一行写 [切到线下]，之后转成线下互动。只是约好了、还在路上都不算。");
    } else if (session.autoModeSwitch) {
        lines.push("- 如果这次见面结束、你们分开了（各自走了、回到手机上聊），在正文最后单独一行写 [切到线上]，之后回到微信聊天。");
    }
    return lines.length ? ["## 回复方式", ...lines].join("\n") : "";
}

/** 单气泡：相邻的纯文字段合成一段，表情包、照片等富媒体保持单独一条 */
export function mergeSingleBubble<T extends { content: string; mediaType?: unknown }>(parts: T[]): T[] {
    const out: T[] = [];
    for (const part of parts) {
        const prev = out[out.length - 1];
        if (prev && !prev.mediaType && !part.mediaType) out[out.length - 1] = { ...prev, content: `${prev.content}\n${part.content}` };
        else out.push(part);
    }
    return out;
}

const MODE_LINE_RE = /^[ \t]*[\[【]\s*切(?:换)?(?:到|回)\s*(线下|线上)\s*[\]】][ \t]*$/m;

export function extractModeSwitch(text: string): { text: string; target: "offline" | "online" | null } {
    const match = text.match(MODE_LINE_RE);
    if (!match) return { text, target: null };
    return {
        text: text.replace(MODE_LINE_RE, "").replace(/\n{3,}/g, "\n\n").trim(),
        target: match[1] === "线下" ? "offline" : "online",
    };
}

export const CHAT_MODE_SWITCHED_EVENT = "chat-mode-switched";

/** 角色切的留一行提示给 AI 和用户看，并通知聊天页弹「切回去」；用户点「切回去」只切不留痕 */
export function switchChatMode(session: Pick<ChatSession, "id" | "contactId">, target: "offline" | "online", by: "char" | "user"): void {
    kvSet(CHAT_OFFLINE_MODE_PREFIX + session.id, target === "offline" ? "1" : "0");
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(CHAT_OFFLINE_MODE_CHANGED_EVENT, { detail: { sessionId: session.id, on: target === "offline" } }));
    if (by !== "char") return;
    const charName = loadCharacters().find(c => c.id === session.contactId)?.name ?? "对方";
    const userName = resolveUserIdentity(session.contactId, "chat")?.name ?? "用户";
    pushChatMessage({
        sessionId: session.id,
        role: "system",
        content: target === "offline" ? `${charName}和${userName}见面了，聊天转到线下` : `${charName}和${userName}分开了，回到微信上聊`,
        uiText: target === "offline" ? `${charName}把聊天切到了线下` : `${charName}把聊天切回了线上`,
        mediaData: { modeSwitch: target },
    });
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    window.dispatchEvent(new CustomEvent(CHAT_MODE_SWITCHED_EVENT, { detail: { sessionId: session.id, target, charName } }));
}
