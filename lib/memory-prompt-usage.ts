// 记忆页「上次请求记忆占用」：聊天请求装配时按层记下注入了多少字，每个角色只留最近一次。
// 存原公式估算值，显示时再按模型校准（token-calibration.ts），校准样本变多后旧记录也跟着准。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { estimateTokens } from "./token-counter";

const KEY = "ai_phone_memory_prompt_usage_v1";
const MAX_CHARACTERS = 60;
registerKvMigration(KEY);

export type MemoryUsageLayerKey = "short_history" | "short_events" | "long_term" | "core" | "shiguang";

export const MEMORY_USAGE_LAYER_LABELS: Record<MemoryUsageLayerKey, string> = {
    short_history: "短期原话",
    short_events: "近期事件",
    long_term: "长期",
    core: "核心",
    shiguang: "拾光",
};

export type MemoryUsageLayer = { key: MemoryUsageLayerKey; count: number; chars: number; estimate: number };
export type MemoryPromptUsage = { at: string; model: string; appId: string; layers: MemoryUsageLayer[] };

export function measureMemoryLayer(key: MemoryUsageLayerKey, texts: string[]): MemoryUsageLayer {
    const kept = texts.filter(text => text.trim());
    return {
        key,
        count: kept.length,
        chars: kept.reduce((sum, text) => sum + text.length, 0),
        estimate: kept.reduce((sum, text) => sum + estimateTokens(text) + 4, 0),
    };
}

function load(): Record<string, MemoryPromptUsage> {
    try {
        const parsed: unknown = JSON.parse(kvGet(KEY) || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, MemoryPromptUsage> : {};
    } catch { return {}; }
}

export function recordMemoryPromptUsage(characterId: string, usage: MemoryPromptUsage): void {
    if (!characterId) return;
    try {
        const all = load();
        all[characterId] = usage;
        const ids = Object.keys(all);
        if (ids.length > MAX_CHARACTERS) {
            ids.sort((a, b) => String(all[a].at).localeCompare(String(all[b].at)));
            for (const id of ids.slice(0, ids.length - MAX_CHARACTERS)) delete all[id];
        }
        kvSet(KEY, JSON.stringify(all));
    } catch { /* 统计失败不影响聊天 */ }
}

export function loadMemoryPromptUsage(characterId: string): MemoryPromptUsage | null {
    return characterId ? load()[characterId] ?? null : null;
}
