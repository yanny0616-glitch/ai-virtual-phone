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

/**
 * 长期总结分批：每批 size 条，同一时刻的记录不拆开（水位线按「晚于」读，拆开会漏掉同刻的后半截），
 * 末尾不足 min 条的并进上一批。
 */
export function splitSummaryBatches<T extends { timestamp: string }>(entries: T[], size: number, min = 4): T[][] {
    const step = Math.max(min, Math.floor(size) || 80);
    const batches: T[][] = [];
    let start = 0;
    while (start < entries.length) {
        let end = Math.min(entries.length, start + step);
        while (end < entries.length && entries[end].timestamp === entries[end - 1].timestamp) end++;
        batches.push(entries.slice(start, end));
        start = end;
    }
    if (batches.length > 1 && batches[batches.length - 1].length < min) {
        const tail = batches.pop()!;
        batches[batches.length - 1].push(...tail);
    }
    return batches;
}
