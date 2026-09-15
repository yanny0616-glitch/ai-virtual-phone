"use client";

// 你打给单聊角色：接通前先问插件接不接（睡着、开会、忙），没接通的记在对方名下。

import { loadChatMessages, pushChatMessage, updateChatMessage } from "./chat-storage";
import { emitChatPluginEvent, runChatPluginTransform } from "./chat-plugin-hooks";
import type { CallBeforeConnectPayload, CallEndedPayload } from "./chat-plugin-types";

const DEFAULT_RING_MS = 3000;
/** 这么久之内又没接上，就并进上一条未接记录（×N） */
const MISSED_MERGE_MS = 30 * 60_000;

export async function resolveCallConnect(sessionId: string, characterId: string, kind: "voice" | "video"): Promise<CallBeforeConnectPayload> {
    const base: CallBeforeConnectPayload = { sessionId, characterId, kind, outcome: "answer", ringMs: DEFAULT_RING_MS };
    try {
        // 运行时依赖提示词装配链，静态引入会和通话界面的引擎依赖成环
        const { getChatPluginRuntime } = await import("./chat-plugin-runtime");
        await getChatPluginRuntime().ensureReady();
        const p = await runChatPluginTransform("call.beforeConnect", { ...base });
        const outcome = p.outcome === "noAnswer" || p.outcome === "reject" ? p.outcome : "answer";
        const ring = Number(p.ringMs);
        const reason = typeof p.reason === "string" ? p.reason.trim().slice(0, 30) : "";
        return { ...base, outcome, ringMs: Number.isFinite(ring) ? Math.max(500, Math.min(60_000, ring)) : DEFAULT_RING_MS, ...(reason ? { reason } : {}) };
    } catch {
        return base;
    }
}

const hhmm = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function recordUnansweredCall(sessionId: string, kind: "voice" | "video", outcome: "noAnswer" | "reject", reason?: string): void {
    const label = kind === "video" ? "视频通话" : "语音通话";
    const now = Date.now();
    if (outcome === "reject") {
        pushChatMessage({ sessionId, role: "assistant", content: `[我拒绝了${label}]${reason ? `(${reason})` : ""}`, mediaData: reason ? { callReason: reason } : undefined });
        return;
    }
    const prefix = `[我未接听${label}]`;
    const last = loadChatMessages(sessionId).at(-1);
    const lastAt = last ? Date.parse(last.mediaData?.callLastAt || last.createdAt) : 0;
    if (last && last.role === "assistant" && last.content.startsWith(prefix) && now - lastAt < MISSED_MERGE_MS) {
        const count = (last.mediaData?.callMissedCount || 1) + 1;
        updateChatMessage(last.id, {
            content: `${prefix}(${count}次，最后一次 ${hhmm(now)})`,
            mediaData: { ...last.mediaData, callMissedCount: count, callLastAt: new Date(now).toISOString() },
        });
        return;
    }
    pushChatMessage({ sessionId, role: "assistant", content: prefix, mediaData: { callMissedCount: 1, callLastAt: new Date(now).toISOString() } });
}

export function emitCallEnded(payload: CallEndedPayload): void {
    emitChatPluginEvent("call.ended", payload);
}
