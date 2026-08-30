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
    /** 命中提示缓存的输入 token（按 1/10 计费），已包含在 promptTokens 里 */
    cacheReadTokens: number;
    /** 写入提示缓存的输入 token（按 1.25 倍计费），已包含在 promptTokens 里 */
    cacheWriteTokens: number;
};

/** 角色维度的桶多带一个显示名：角色卡删了以后 id 还在统计里，没有名字就只剩一串乱码。 */
export type ApiUsageCharacterBucket = ApiUsageBucket & { name?: string };

export type ApiUsageDay = ApiUsageBucket & {
    /** 本地时区的 YYYY-MM-DD */
    date: string;
    byModel: Record<string, ApiUsageBucket>;
    /** chat / background / qa */
    bySource: Record<string, ApiUsageBucket>;
    /** key 优先用角色卡 id；后台功能调用没有 id，退回 "name:<功能名>" */
    byCharacter: Record<string, ApiUsageCharacterBucket>;
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
    return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

type UsageDelta = { prompt: number; completion: number; total: number; cacheRead: number; cacheWrite: number };

function addInto(target: ApiUsageBucket, delta: UsageDelta): void {
    target.calls += 1;
    target.promptTokens += delta.prompt;
    target.completionTokens += delta.completion;
    target.totalTokens += delta.total;
    // 老版本存下来的桶没有这两个字段，直接 += 会得到 NaN，读的时候兜个 0。
    target.cacheReadTokens = (target.cacheReadTokens || 0) + delta.cacheRead;
    target.cacheWriteTokens = (target.cacheWriteTokens || 0) + delta.cacheWrite;
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
    characterId?: string;
    characterName?: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cache_read_tokens?: number;
        cache_write_tokens?: number;
    };
}): void {
    try {
        const prompt = Math.max(0, Math.floor(input.usage?.prompt_tokens ?? 0));
        const completion = Math.max(0, Math.floor(input.usage?.completion_tokens ?? 0));
        // 有些服务商只给 total，有些只给分项：两边互相兜底，避免总量凭空少一半。
        const total = Math.max(0, Math.floor(input.usage?.total_tokens ?? (prompt + completion)));
        const delta: UsageDelta = {
            prompt,
            completion,
            total,
            cacheRead: Math.max(0, Math.floor(input.usage?.cache_read_tokens ?? 0)),
            cacheWrite: Math.max(0, Math.floor(input.usage?.cache_write_tokens ?? 0)),
        };
        const model = (input.model || "未知模型").slice(0, 120);
        const source = input.source || "chat";
        const characterName = (input.characterName || "").slice(0, 120);
        // 角色卡 id 优先：改名不断档。后台功能没有卡，用功能名当 key，前缀区分避免撞 id。
        const characterKey = input.characterId
            ? input.characterId.slice(0, 120)
            : characterName ? `name:${characterName}` : "name:未标注";

        const days = loadDays();
        const key = localDateKey(new Date());
        let day = days.length && days[days.length - 1].date === key ? days[days.length - 1] : undefined;
        if (!day) {
            day = days.find(item => item.date === key);
        }
        if (!day) {
            day = { date: key, ...emptyBucket(), byModel: {}, bySource: {}, byCharacter: {} };
            days.push(day);
            days.sort((a, b) => a.date.localeCompare(b.date));
        }
        // byCharacter 是后加的字段，老数据里没有，读回来要补。
        if (!day.byCharacter) day.byCharacter = {};
        if (!day.byModel[model]) day.byModel[model] = emptyBucket();
        if (!day.bySource[source]) day.bySource[source] = emptyBucket();
        if (!day.byCharacter[characterKey]) day.byCharacter[characterKey] = { ...emptyBucket(), name: characterName || undefined };
        else if (characterName) day.byCharacter[characterKey].name = characterName;
        addInto(day, delta);
        addInto(day.byModel[model], delta);
        addInto(day.bySource[source], delta);
        addInto(day.byCharacter[characterKey], delta);
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
        const day = stored.get(key);
        result.push(day
            ? {
                ...emptyBucket(),
                ...day,
                byModel: Object.fromEntries(
                    Object.entries(day.byModel ?? {}).map(([model, bucket]) => [model, { ...emptyBucket(), ...bucket }]),
                ),
                bySource: Object.fromEntries(
                    Object.entries(day.bySource ?? {}).map(([source, bucket]) => [source, { ...emptyBucket(), ...bucket }]),
                ),
                byCharacter: Object.fromEntries(
                    Object.entries(day.byCharacter ?? {}).map(([character, bucket]) => [character, { ...emptyBucket(), ...bucket }]),
                ),
            }
            : { date: key, ...emptyBucket(), byModel: {}, bySource: {}, byCharacter: {} });
    }
    return result;
}

export function clearApiUsageStats(): void { try { kvRemove(USAGE_KEY); } catch { } }
