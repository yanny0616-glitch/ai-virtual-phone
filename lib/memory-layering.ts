// 记忆方案阶段二的纯逻辑（2.0 预算校准、2.2 核心去重与合并）。
// 不 import 任何模块，scripts/check-memory-layering.mjs 直接剥类型后在沙箱里跑。

type EntryLike = { id: string; content: string; createdAt: string; metadata?: Record<string, unknown> };

/** 预算是按真实 token 定的；估算值 × 比例 = 真实值，所以估算侧的上限要除以比例 */
export function budgetForModel(budget: number, ratio: number | null | undefined): number {
    if (!(budget > 0) || !(typeof ratio === "number" && ratio > 0)) return budget;
    return Math.max(1, Math.floor(budget / ratio));
}

export function isSupersededCore(entry: EntryLike): boolean {
    return typeof entry.metadata?.supersededBy === "string" && entry.metadata.supersededBy !== "";
}

/** 核心记忆已经合成过的长期记忆（createdAt 不晚于核心水位线）不再注入 */
export function dropCoveredLongTerm<T extends EntryLike>(entries: T[], coveredUntil: string | null | undefined): T[] {
    return coveredUntil ? entries.filter(entry => entry.createdAt > coveredUntil) : entries;
}

export const CORE_MERGE_NOTE = "（下面先是现有的核心记忆，后面是之后新增的长期记忆。请合并输出一份完整的新核心记忆，它会替换旧版：旧核心里的内容不能丢，同一件事有新进展以最新为准。）";

/** 合并模式的 {{events}}：旧核心整段放前面，新增长期记忆按条列在后面 */
export function buildCoreMergeEvents(previousCores: EntryLike[], newEntries: string[]): string {
    const bullets = newEntries.map(content => `- ${content}`).join("\n");
    if (previousCores.length === 0) return bullets;
    const old = [...previousCores]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(entry => entry.content.trim())
        .join("\n\n");
    return `${CORE_MERGE_NOTE}\n\n【现有核心记忆】\n${old}\n\n【新增长期记忆】\n${bullets}`;
}

/** 旧核心 timeSpan 的起点，让新版核心的时间跨度从最早覆盖的那天算起 */
export function earliestCoreStart(previousCores: EntryLike[], fallback: string): string {
    let earliest = fallback;
    for (const entry of previousCores) {
        const span = entry.metadata?.timeSpan;
        const start = typeof span === "string" ? span.split("~")[0].trim() : entry.createdAt;
        if (start && start < earliest) earliest = start;
    }
    return earliest;
}

type RoundEntry = {
    timestamp: string;
    sourceApp: string;
    sourceDetail?: string;
    authorType?: string;
    sessionId?: string;
    groupSessionId?: string;
};

// 角色隔了这么久又主动发，算新的一轮
const ROUND_GAP_MS = 30 * 60_000;

/** 每条记录是不是新一轮的开头：用户一句（连发只算一次）+ 角色这次的回复算一轮；朋友圈、日记等每条单独一轮 */
export function markRoundStarts(entries: RoundEntry[]): boolean[] {
    const last = new Map<string, RoundEntry>();
    return entries.map(entry => {
        if (entry.sourceApp !== "chat") return true;
        const stream = entry.groupSessionId || entry.sessionId || entry.sourceDetail || "chat";
        const prev = last.get(stream);
        last.set(stream, entry);
        if (!prev) return true;
        if (entry.authorType === "user") return prev.authorType !== "user";
        return prev.authorType !== "user" && Date.parse(entry.timestamp) - Date.parse(prev.timestamp) > ROUND_GAP_MS;
    });
}

export function countRounds(entries: RoundEntry[]): number {
    return markRoundStarts(entries).filter(Boolean).length;
}

/**
 * 长期总结分批：每批 rounds 轮，只在新一轮开头切，一轮不拆开；
 * 同一时刻的记录不拆开（水位线按「晚于」读，拆开会漏掉同刻的后半截），末尾不足 min 条的并进上一批。
 */
export function splitSummaryBatches<T extends RoundEntry>(entries: T[], rounds: number, min = 4): T[][] {
    const perBatch = Math.max(1, Math.floor(rounds) || 30);
    const starts = markRoundStarts(entries);
    const batches: T[][] = [];
    let current: T[] = [];
    let roundsInCurrent = 0;
    entries.forEach((entry, index) => {
        const sameInstant = current.length > 0 && current[current.length - 1].timestamp === entry.timestamp;
        if (starts[index] && roundsInCurrent >= perBatch && !sameInstant) {
            batches.push(current);
            current = [];
            roundsInCurrent = 0;
        }
        if (starts[index]) roundsInCurrent++;
        current.push(entry);
    });
    if (current.length > 0) batches.push(current);
    if (batches.length > 1 && batches[batches.length - 1].length < min) {
        const tail = batches.pop()!;
        batches[batches.length - 1].push(...tail);
    }
    return batches;
}

/**
 * 2.1 短期原话窗口的起点：总结水位线往前 days 天。锚在水位线而不是「现在」，
 * 两次总结之间起点不动，提示词前缀才稳；还没总结过返回 null（照原来按预算带）。
 */
export function shortTermWindowStart(watermark: string | null | undefined, days: number): string | null {
    if (!watermark) return null;
    const end = Date.parse(watermark);
    if (!Number.isFinite(end)) return null;
    const span = Math.max(0, Number.isFinite(days) ? days : 3);
    return new Date(end - span * 86_400_000).toISOString();
}
