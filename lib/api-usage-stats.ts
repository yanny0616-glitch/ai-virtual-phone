// lib/api-usage-stats.ts
// 按天累计的模型用量统计。与 api-log-store 的日志环分开存：日志环只留最近 150 条，
// 想看「今天用了多少 token」「最近 7 天趋势」必须有独立累加器，不能靠翻日志。
// 每条记录只存计数，不存提示词原文，所以体积极小，可以长期保留。

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

export type ApiUsageBucket = {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

export type ApiUsageDay = ApiUsageBucket & {
    /** 本地时区的 YYYY-MM-DD */
    date: string;
    byModel: Record<string, ApiUsageBucket>;
    /** chat / background / qa */
    bySource: Record<string, ApiUsageBucket>;
};

const USAGE_KEY = "ai_phone_api_usage_stats_v1";
registerKvMigration(USAGE_KEY);

/** 保留天数：一条日记录几百字节，半年也就几十 KB。 */
const MAX_DAYS = 180;

function localDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function emptyBucket(): ApiUsageBucket {
    return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addInto(target: ApiUsageBucket, prompt: number, completion: number, total: number): void {
    target.calls += 1;
    target.promptTokens += prompt;
    target.completionTokens += completion;
    target.totalTokens += total;
}

function loadDays(): ApiUsageDay[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(USAGE_KEY) : null;
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as ApiUsageDay[] : [];
    } catch { return []; }
}

function saveDays(days: ApiUsageDay[]): void {
    try { kvSet(USAGE_KEY, JSON.stringify(days.slice(-MAX_DAYS))); } catch { /* 统计失败不影响主流程 */ }
}

/** 记一次调用。usage 缺失时按 0 计入次数——服务商不回 usage 也要能看到调用频次。 */
export function recordApiUsage(input: {
    model?: string;
    source?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}): void {
    try {
        const prompt = Math.max(0, Math.floor(input.usage?.prompt_tokens ?? 0));
        const completion = Math.max(0, Math.floor(input.usage?.completion_tokens ?? 0));
        // 有些服务商只给 total，有些只给分项：两边互相兜底，避免总量凭空少一半。
        const total = Math.max(0, Math.floor(input.usage?.total_tokens ?? (prompt + completion)));
        const model = (input.model || "未知模型").slice(0, 120);
        const source = input.source || "chat";

        const days = loadDays();
        const key = localDateKey(new Date());
        let day = days.length && days[days.length - 1].date === key ? days[days.length - 1] : undefined;
        if (!day) {
            day = days.find(item => item.date === key);
        }
        if (!day) {
            day = { date: key, ...emptyBucket(), byModel: {}, bySource: {} };
            days.push(day);
            days.sort((a, b) => a.date.localeCompare(b.date));
        }
        if (!day.byModel[model]) day.byModel[model] = emptyBucket();
        if (!day.bySource[source]) day.bySource[source] = emptyBucket();
        addInto(day, prompt, completion, total);
        addInto(day.byModel[model], prompt, completion, total);
        addInto(day.bySource[source], prompt, completion, total);
        saveDays(days);
    } catch { /* 统计失败不影响主流程 */ }
}

/** 取最近 N 天（含今天，缺的天补零），新到旧由调用方自己排。默认 7 天。 */
export function getApiUsageDays(options?: { days?: number }): ApiUsageDay[] {
    const want = Math.max(1, Math.min(MAX_DAYS, Math.floor(options?.days ?? 7)));
    const stored = new Map(loadDays().map(day => [day.date, day]));
    const result: ApiUsageDay[] = [];
    const cursor = new Date();
    for (let i = want - 1; i >= 0; i -= 1) {
        const date = new Date(cursor);
        date.setDate(cursor.getDate() - i);
        const key = localDateKey(date);
        result.push(stored.get(key) ?? { date: key, ...emptyBucket(), byModel: {}, bySource: {} });
    }
    return result;
}

export function clearApiUsageStats(): void { try { kvRemove(USAGE_KEY); } catch { } }
