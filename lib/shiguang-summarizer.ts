import { loadMemoryConfig, loadMemoryEntriesByType, saveMemoryBatch, getShiguangWatermark, setShiguangWatermark } from "./memory-storage";
import { filterTimelineByAllowedSources, loadNativeTimeline } from "./short-term-assembler";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { buildShiguangExtractionPrompt, countShiguangRounds, parseShiguangResult, selectShiguangCandidates } from "./shiguang-domain";

const running = new Set<string>();
const retryAfter = new Map<string, number>();
type Result = { success: boolean; error?: string; saved?: number; hasMore?: boolean };

function pendingMessages(characterId: string) {
    const config = loadMemoryConfig();
    return filterTimelineByAllowedSources(loadNativeTimeline(characterId, { afterTimestamp: getShiguangWatermark(characterId) }), config.shortTermAllowedSources)
        .filter(e => e.sourceApp === "chat" && ["direct", "group", "chat_offline"].includes(e.sourceDetail || ""));
}

export async function maybeRunShiguang(characterId: string, characterName: string): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.shiguangEnabled || !config.shiguangAutoEnabled || running.has(characterId) || Date.now() < (retryAfter.get(characterId) || 0)) return;
    if (countShiguangRounds(pendingMessages(characterId)) < Math.max(5, config.shiguangRoundInterval || 20)) return;
    const result = await runShiguangPipeline(characterId, characterName);
    if (!result.success) {
        retryAfter.set(characterId, Date.now() + 5 * 60_000);
        console.warn("[Shiguang]", result.error);
    }
}

/** Separate request, watermark and lock; long-term memory progress is never touched. */
export async function runShiguangPipeline(characterId: string, characterName: string): Promise<Result> {
    if (running.has(characterId)) return { success: false, error: "正在整理拾光，请等待完成。" };
    if (!loadMemoryConfig().shiguangEnabled) return { success: false, error: "请先开启拾光记录与回忆。" };
    running.add(characterId);
    try {
        if (typeof navigator !== "undefined" && navigator.locks) {
            return await navigator.locks.request(`shiguang-summary:${characterId}`, { ifAvailable: true }, lock =>
                lock ? runUnlocked(characterId, characterName) : Promise.resolve({ success: false, error: "另一页面正在整理拾光。" }));
        }
        return await runUnlocked(characterId, characterName);
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "拾光整理失败，请重试。" };
    } finally { running.delete(characterId); }
}

async function runUnlocked(characterId: string, characterName: string): Promise<Result> {
    // Reuse the configured summary model; request frequency remains independent.
    const api = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!api) return { success: false, error: "请在绑定配置 → 辅助API绑定中配置记忆总结 API。" };
    const pending = pendingMessages(characterId);
    if (pending.length < 2) return { success: false, error: "还没有足够的新聊天消息，继续聊聊再整理。" };
    let count = 0, size = 0;
    for (const entry of pending) {
        const previous = pending[count - 1];
        const sameReply = previous?.responseBatchId && previous.responseBatchId === entry.responseBatchId;
        const answering = previous?.authorType === "user" && entry.authorType === "character";
        if (count >= 2 && size + entry.content.length > 24000 && entry.timestamp !== previous.timestamp && !sameReply && !answering) break;
        count++; size += entry.content.length;
    }
    const sources = pending.slice(0, count);
    const events = sources.map((entry,i) => `[s${i + 1}] sourceApp=${entry.sourceApp} sourceDetail=${entry.sourceDetail} 时间=${entry.timestamp} ${entry.content}`).join("\n");
    const existing = await loadMemoryEntriesByType(characterId, "shiguang");
    const candidates = selectShiguangCandidates(existing, events);
    const prompt = buildShiguangExtractionPrompt(`角色：${characterName}\n以下是尚未整理的聊天原消息：\n${events}`, candidates);
    const result = await simpleLLMCall(api, [{ role: "user", content: prompt }], { temperature: .3, label: `拾光整理·${characterName}` });
    if (!result.content) return { success: false, error: result.error || "拾光返回了空内容，未改变整理进度。" };
    if (result.wasTruncated) return { success: false, error: "拾光结果被截断，未保存；请提高模型输出上限后重试。" };
    const parsed = parseShiguangResult(result.content, sources, candidates, characterId, new Date().toISOString());
    // Include all saved records when detecting user-deleted/edited duplicates, not just prompt candidates.
    const entries = parsed.entries.filter(entry => !existing.some(old => old.shiguang
        && (old.id === entry.id || old.shiguang.title === entry.shiguang!.title)
        && (old.shiguang.deletedAt || (old.shiguang.userEdited && entry.metadata?.shiguangBaseUpdatedAt !== old.updatedAt))));
    await saveMemoryBatch(entries);
    setShiguangWatermark(characterId, sources[sources.length - 1].timestamp);
    retryAfter.delete(characterId);
    return { success: true, saved: entries.length, hasMore: count < pending.length };
}
