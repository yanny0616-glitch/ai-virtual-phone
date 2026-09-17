// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { describeMemoryTime, mergeRecallContext, rankMemoriesByRelevance } from "./memory-recall";

const QUERY_EMBEDDING_TIMEOUT_MS = 3000;
const RECALL_QUERY_CHARS = 2000;

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    return retrieveLongTermMemories(characterId, currentContext, config);
}

async function retrieveLongTermMemories(characterId: string, currentContext: string, config: MemoryConfig): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];
    if (config.longTermRecallMode === "relevant") return retrieveRelevantLongTerm(longTermEntries, currentContext, config);

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export function buildLongTermRecallContext(
    timelineContext: string,
    requestMessages: { content?: unknown; isRetracted?: boolean }[],
    config: MemoryConfig,
): string {
    return config.longTermRecallMode === "relevant" ? mergeRecallContext(timelineContext, requestMessages) : timelineContext;
}

async function retrieveRelevantLongTerm(entries: MemoryEntry[], currentContext: string, config: MemoryConfig): Promise<MemoryEntry[]> {
    const query = currentContext.slice(-RECALL_QUERY_CHARS);
    const queryEmbedding = await resolveQueryEmbedding(query, config);
    const now = Date.now();
    const spans = new Map(entries.map(entry => [entry.id, resolveMemorySpan(entry)] as const));
    const hits = rankMemoriesByRelevance(
        query,
        entries.map(entry => ({
            id: entry.id,
            content: entry.content,
            importance: entry.importance,
            time: spans.get(entry.id)!.end,
            embedding: entry.embedding,
        })),
        { topK: config.longTermRecallTopK, now, queryEmbedding },
    );
    const byId = new Map(entries.map(entry => [entry.id, entry] as const));
    const picked = fillByBudget(hits.map(hit => byId.get(hit.id)!), config.longTermTokenBudget);
    // recallLabel 只挂在返回的副本上给 formatLongTermMemories 用，不写回存储
    return picked
        .sort((a, b) => spans.get(a.id)!.end - spans.get(b.id)!.end)
        .map(entry => {
            const span = spans.get(entry.id)!;
            return { ...entry, metadata: { ...entry.metadata, recallLabel: describeMemoryTime(span.start, span.end, now) } };
        });
}

async function resolveQueryEmbedding(query: string, config: MemoryConfig): Promise<number[] | null> {
    if (!config.vectorRecallEnabled) return null;
    const apiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if (!apiConfig || !resolveEmbeddingModel(apiConfig)) return null;
    // 嵌入接口卡住不能拖住整轮回复，超时就只走关键词
    const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), QUERY_EMBEDDING_TIMEOUT_MS));
    return Promise.race([generateEmbedding(query, apiConfig).catch(() => null), timeout]);
}

function resolveMemorySpan(entry: MemoryEntry): { start: number; end: number } {
    const created = Date.parse(entry.createdAt);
    const fallback = Number.isFinite(created) ? created : Date.now();
    const timeSpan = entry.metadata?.timeSpan;
    if (typeof timeSpan === "string") {
        const [start, end] = timeSpan.split("~").map(part => Date.parse(part.trim()));
        if (Number.isFinite(start) && Number.isFinite(end)) return { start: Math.min(start, end), end: Math.max(start, end) };
    }
    return { start: fallback, end: fallback };
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
