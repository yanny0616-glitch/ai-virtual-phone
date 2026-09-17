"use client";

import { loadChatSessions } from "./chat-storage";
import {
    CHAT_PLUGIN_WAKE_PREFIX,
    loadTimedWakeSchedules,
    removeTimedWakeSchedule,
    saveTimedWakeSchedule,
    type TimedWakeSchedule,
} from "./timed-wake-storage";

const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 7 * 24 * 3600_000;

export function pluginWakeId(pluginId: string, key: string): string {
    const safeKey = String(key || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
    if (!safeKey) throw new Error("scheduleWake 缺少 key（字母数字）");
    return `${CHAT_PLUGIN_WAKE_PREFIX}${pluginId}_${safeKey}`;
}

export async function schedulePluginTimedWake(
    pluginId: string,
    input: { characterId: string; fireAt: number; intent: string; key: string },
): Promise<{ id: string; armed: boolean; reason?: string }> {
    const intent = String(input.intent || "").trim().slice(0, 500);
    if (!intent) throw new Error("scheduleWake 缺少 intent（到点时角色想说什么）");
    const now = Date.now();
    const fireAt = Math.round(Number(input.fireAt));
    if (!Number.isFinite(fireAt) || fireAt < now + MIN_AHEAD_MS) throw new Error("scheduleWake 的 fireAt 至少要在 1 分钟之后");
    if (fireAt > now + MAX_AHEAD_MS) throw new Error("scheduleWake 最多提前 7 天");
    const session = loadChatSessions().find(s => !s.isGroup && s.contactId === input.characterId);
    if (!session) throw new Error("scheduleWake 找不到这个角色的单聊");
    const schedule: TimedWakeSchedule = {
        id: pluginWakeId(pluginId, input.key),
        sessionId: session.id,
        characterId: input.characterId,
        fireAt,
        createdAt: now,
        delayMinutes: Math.max(1, Math.round((fireAt - now) / 60_000)),
        intent,
        source: "tool",
    };
    saveTimedWakeSchedule(schedule);
    // 推送兜底模块依赖提示词装配链，静态引入会和插件运行时成环
    const { armTimedWakeBailout } = await import("./push-bailout-client");
    const result = await armTimedWakeBailout(schedule);
    return { id: schedule.id, armed: result.ok, reason: result.ok ? undefined : result.reason };
}

export function cancelPluginTimedWake(pluginId: string, key: string): void {
    const id = pluginWakeId(pluginId, key);
    if (!loadTimedWakeSchedules().some(item => item.id === id)) return;
    removeTimedWakeSchedule(id);
    void import("./push-bailout-client").then(m => m.cancelBailoutKey(`timedwake:${id}`));
}
