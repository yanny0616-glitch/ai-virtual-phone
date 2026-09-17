import {
    createChatMessageBatch,
    loadChatMessages,
    loadChatSessions,
    updateChatMessage,
    type ChatMessage,
    type ChatSession,
} from "./chat-storage";
import type { ContentAppId } from "./settings-types";

// 通话记录不另存：直接从聊天消息里认「发起了 / 挂断了 / 拒绝了 / 取消了 / 未接听」这几种标记。
// 群通话（「群语音通话」）不在这里。

export type CallKind = "voice" | "video";
/** answered 接通后挂断；broken 有发起没挂断（小手机被关掉）；rejected TA 拒接；declined 你拒接 */
export type CallOutcome = "answered" | "broken" | "missed" | "rejected" | "declined" | "cancelled";

export type CallRecord = {
    id: string;
    kind: CallKind;
    outcome: CallOutcome;
    startAt: string;
    endAt?: string;
    duration?: string;
    hungUpBy?: "user" | "char";
    startMsg?: ChatMessage;
    endMsg?: ChatMessage;
    lines: ChatMessage[];
    summary?: string;
    missedCount?: number;
    reason?: string;
};

const START_RE = /\[我(?:向.+?)?发起了(语音|视频)通话\]/;
const END_RE = /\[我(挂断|拒绝|取消)了(语音|视频)通话\](?:\(时长\s*(\d+:\d+)\))?/;
const MISSED_RE = /\[我未接听(语音|视频)通话\]/;
/** 中断的通话往后认几句：隔超过这么久、或者出现照片表情这类，就当通话已经断了 */
const BROKEN_GAP_MS = 10 * 60_000;

const kindOf = (label: string): CallKind => (label === "视频" ? "video" : "voice");
export const callKindLabel = (kind: CallKind) => (kind === "video" ? "视频通话" : "语音通话");

export const isCallMarker = (content: string) => START_RE.test(content) || END_RE.test(content) || MISSED_RE.test(content);

export function listCallRecords(messages: ChatMessage[]): CallRecord[] {
    const out: CallRecord[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const content = msg.content || "";
        const missed = content.match(MISSED_RE);
        if (missed) {
            out.push({ id: msg.id, kind: kindOf(missed[1]), outcome: "missed", startAt: msg.createdAt, lines: [], startMsg: msg, missedCount: msg.mediaData?.callMissedCount || 1 });
            continue;
        }
        const start = content.match(START_RE);
        if (start) {
            const lines: ChatMessage[] = [];
            let endMsg: ChatMessage | undefined;
            let j = i + 1;
            for (; j < messages.length; j++) {
                const next = messages[j].content || "";
                if (START_RE.test(next) || MISSED_RE.test(next)) break;
                if (END_RE.test(next)) { endMsg = messages[j]; break; }
                lines.push(messages[j]);
            }
            if (endMsg) {
                out.push({ ...fromEnd(endMsg, kindOf(start[1])), id: msg.id, startAt: msg.createdAt, startMsg: msg, lines });
                i = j;
                continue;
            }
            const kept: ChatMessage[] = [];
            let prev = Date.parse(msg.createdAt);
            for (const line of lines) {
                const at = Date.parse(line.createdAt);
                if ((line.mediaType && line.mediaType !== "audio") || at - prev > BROKEN_GAP_MS) break;
                kept.push(line);
                prev = at;
            }
            out.push({ id: msg.id, kind: kindOf(start[1]), outcome: "broken", startAt: msg.createdAt, startMsg: msg, lines: kept });
            i += kept.length;
            continue;
        }
        if (END_RE.test(content)) out.push({ ...fromEnd(msg, kindOf(content.match(END_RE)![2])), id: msg.id, startAt: msg.createdAt, lines: [] });
    }
    return out.reverse();
}

function fromEnd(endMsg: ChatMessage, kind: CallKind): Omit<CallRecord, "id" | "startAt" | "lines"> {
    const match = endMsg.content.match(END_RE)!;
    const verb = match[1];
    const outcome: CallOutcome = verb === "挂断" ? "answered" : verb === "取消" ? "cancelled" : endMsg.role === "assistant" ? "rejected" : "declined";
    return {
        kind,
        outcome,
        endAt: endMsg.createdAt,
        endMsg,
        duration: endMsg.mediaData?.callDuration || match[3],
        hungUpBy: verb === "挂断" ? (endMsg.role === "assistant" ? "char" : "user") : undefined,
        summary: endMsg.mediaData?.callSummary,
        reason: endMsg.mediaData?.callReason,
    };
}

/** 总结长期记忆时：有小结的通话只留一行小结，逐句原文不进 */
export function foldSummarizedCalls(messages: ChatMessage[]): { skip: Set<string>; replace: Map<string, string> } {
    const skip = new Set<string>();
    const replace = new Map<string, string>();
    for (const record of listCallRecords(messages)) {
        if (record.outcome !== "answered" || !record.summary || !record.endMsg) continue;
        if (record.startMsg) skip.add(record.startMsg.id);
        record.lines.forEach(line => skip.add(line.id));
        replace.set(record.endMsg.id, `[${callKindLabel(record.kind)}${record.duration ? ` ${record.duration}` : ""}，聊了：${record.summary}]`);
    }
    return { skip, replace };
}

const notifyMessages = (sessionId: string) => {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
};

/** 补一条挂断记录，时间紧跟在通话最后一句后面，聊天里就能收成一张通话卡片 */
export async function repairBrokenCall(sessionId: string, record: CallRecord): Promise<void> {
    const last = record.lines[record.lines.length - 1] ?? record.startMsg;
    if (!last) return;
    const batch = createChatMessageBatch(undefined, { insertByCreatedAt: true });
    batch.push({
        sessionId,
        role: "user",
        content: `[我挂断了${callKindLabel(record.kind)}]`,
        createdAt: new Date(Date.parse(last.createdAt) + 1).toISOString(),
    });
    await batch.commit();
    notifyMessages(sessionId);
}

const cleanSummary = (raw: string) => raw
    .replace(/\[内心\][\s\S]*?\[\/内心\]/g, "")
    .replace(/<[^>]+>/g, "")
    .split("\n").map(line => line.trim()).find(Boolean)
    ?.replace(/^[「『"“]|[」』"”]$/g, "")
    .slice(0, 80) ?? "";

export async function summarizeCall(session: ChatSession, record: CallRecord): Promise<string> {
    if (!record.endMsg || !record.lines.some(line => line.content.trim())) return "";
    const { generateChatCompletion, flattenCompletionResult } = await import("./chat-engine");
    const history = [record.startMsg, ...record.lines, record.endMsg].filter((m): m is ChatMessage => !!m);
    const summary = cleanSummary(flattenCompletionResult(await generateChatCompletion(session, history, { appId: "call_summary" as ContentAppId })));
    if (!summary) return "";
    updateChatMessage(record.endMsg.id, { mediaData: { ...record.endMsg.mediaData, callSummary: summary } });
    notifyMessages(session.id);
    return summary;
}

/** 挂断后自动写小结（通话一栏里能关） */
export async function summarizeLatestCall(sessionId: string): Promise<void> {
    const session = loadChatSessions().find(s => s.id === sessionId);
    if (!session || session.isGroup || session.callSummary === false) return;
    const record = listCallRecords(loadChatMessages(sessionId)).find(r => r.outcome === "answered");
    if (!record || record.summary) return;
    try {
        await summarizeCall(session, record);
    } catch (error) {
        console.warn("[CallRecords] 通话小结失败", error);
    }
}
