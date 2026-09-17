// 长期记忆按话题挑选：关键词一路（CJK 双字切分 + BM25）总在，配了向量模型再并一路向量。
// 不 import 任何模块，scripts/check-memory-recall.mjs 直接剥类型后在沙箱里跑。

export type RecallCandidate = {
    id: string;
    content: string;
    importance?: number;
    time: number;
    embedding?: number[];
};

export type RecallHit = { id: string; score: number };

const BM25_K1 = 1.2;
const BM25_B = 0.75;
// 只命中「用户」「今天」这类到处都有的词时 BM25 很低，过不了这道闸
const KEYWORD_GATE = 1.0;
const VECTOR_GATE = 0.4;
const VECTOR_FLOOR = 0.25;
const RELATIVE_CUTOFF = 0.4;
const DUPLICATE_COSINE = 0.9;
const DUPLICATE_OVERLAP = 0.8;
const RECENCY_HALF_DAYS = 90;
// 记忆很少时 BM25 分不清常用词和关键词：按至少 20 条来算 idf，出现在六成以上记忆里的词本轮不参与，两条以内不设闸
const IDF_MIN_DOCS = 20;
const UBIQUITOUS_SHARE = 0.6;
const SMALL_POOL = 2;
const STOP_TOKENS = new Set(["用户", "角色"]);
const DAY_MS = 86_400_000;

export function tokenizeForRecall(text: string): string[] {
    const lower = text.toLowerCase();
    const words = lower.match(/[a-z0-9]+/g) || [];
    const cjk = lower.match(/[⺀-鿿豈-﫿가-힯]+/g) || [];
    const bigrams: string[] = [];
    for (const seg of cjk) {
        if (seg.length === 1) bigrams.push(seg);
        for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
    }
    return [...words, ...bigrams];
}

function cosine(a: number[], b: number[]): number | null {
    if (a.length === 0 || a.length !== b.length) return null;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return null;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / Math.min(a.size, b.size);
}

export function rankMemoriesByRelevance(
    query: string,
    candidates: RecallCandidate[],
    options: { topK: number; now: number; queryEmbedding?: number[] | null },
): RecallHit[] {
    if (candidates.length === 0) return [];
    const docs = candidates.map(c => tokenizeForRecall(c.content));
    const docSets = docs.map(d => new Set(d));
    const n = docs.length;
    const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / n || 1;
    const docFreq = new Map<string, number>();
    for (const set of docSets) for (const t of set) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    const queryTokens = Array.from(new Set(tokenizeForRecall(query)))
        .filter(t => !STOP_TOKENS.has(t) && !(n > SMALL_POOL && (docFreq.get(t) || 0) / n >= UBIQUITOUS_SHARE));
    const idfDocs = Math.max(n, IDF_MIN_DOCS);

    const scored = candidates.map((candidate, index) => {
        const doc = docs[index];
        const termFreq = new Map<string, number>();
        for (const t of doc) termFreq.set(t, (termFreq.get(t) || 0) + 1);
        let keyword = 0;
        for (const t of queryTokens) {
            const f = termFreq.get(t);
            if (!f) continue;
            const df = docFreq.get(t) || 0;
            const idf = Math.log(1 + (idfDocs - df + 0.5) / (df + 0.5));
            keyword += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * doc.length / avgLength));
        }
        const vector = options.queryEmbedding && candidate.embedding ? cosine(options.queryEmbedding, candidate.embedding) : null;
        return { candidate, index, keyword, vector };
    });

    const maxKeyword = Math.max(0, ...scored.map(s => s.keyword));
    const ranked = scored
        .filter(s => n <= SMALL_POOL || s.keyword >= KEYWORD_GATE || (s.vector ?? 0) >= VECTOR_GATE)
        .map(s => {
            const keywordNorm = maxKeyword > 0 ? s.keyword / maxKeyword : 0;
            const vectorNorm = s.vector === null ? null : Math.max(0, (s.vector - VECTOR_FLOOR) / (1 - VECTOR_FLOOR));
            const relevance = vectorNorm === null
                ? keywordNorm
                : 0.7 * Math.max(keywordNorm, vectorNorm) + 0.3 * Math.min(keywordNorm, vectorNorm);
            const ageDays = Math.max(0, (options.now - s.candidate.time) / DAY_MS);
            const importance = Math.min(1, Math.max(0, s.candidate.importance ?? 0.5));
            return { ...s, score: relevance + 0.15 * importance + 0.1 * Math.exp(-ageDays / RECENCY_HALF_DAYS) };
        })
        .sort((a, b) => b.score - a.score);
    if (ranked.length === 0) return [];

    const cutoff = ranked[0].score * RELATIVE_CUTOFF;
    const picked: typeof ranked = [];
    for (const r of ranked) {
        if (r.score < cutoff) break;
        const duplicate = picked.some(p => {
            const a = p.candidate, b = r.candidate;
            const cos = a.embedding && b.embedding ? cosine(a.embedding, b.embedding) : null;
            if (cos !== null && cos > DUPLICATE_COSINE) return true;
            if (a.content.includes(b.content) || b.content.includes(a.content)) return true;
            return overlapRatio(docSets[p.index], docSets[r.index]) > DUPLICATE_OVERLAP;
        });
        if (duplicate) continue;
        picked.push(r);
        if (picked.length >= Math.max(1, options.topK)) break;
    }
    return picked.map(p => ({ id: p.candidate.id, score: p.score }));
}

// 线下会话的当前场景被排除在时间线外（本轮剧情走 history），不并进来就只能按线上聊天挑
export function mergeRecallContext(
    timelineContext: string,
    requestMessages: { content?: unknown; isRetracted?: boolean }[],
    limit = 8,
): string {
    const recent = requestMessages
        .filter(m => !m.isRetracted && typeof m.content === "string" && m.content.trim())
        .slice(-limit)
        .map(m => (m.content as string).trim());
    return [timelineContext.trim(), ...recent].filter(Boolean).join("\n");
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function startOfDay(ms: number): number {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function formatDay(ms: number, nowMs: number): string {
    const d = new Date(ms);
    const monthDay = `${d.getMonth() + 1}月${d.getDate()}日`;
    return d.getFullYear() === new Date(nowMs).getFullYear() ? monthDay : `${d.getFullYear()}年${monthDay}`;
}

function describeAgo(endMs: number, nowMs: number): string {
    const days = Math.round((startOfDay(nowMs) - startOfDay(endMs)) / DAY_MS);
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    if (days === 2) return "前天";
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `约 ${Math.round(days / 7)} 周前`;
    if (days < 365) return `约 ${Math.max(1, Math.round(days / 30))} 个月前`;
    const years = Math.floor(days / 365);
    return days % 365 >= 30 ? `${years} 年多前` : `约 ${years} 年前`;
}

export function describeMemoryTime(startMs: number, endMs: number, nowMs: number): string {
    const sameDay = startOfDay(startMs) === startOfDay(endMs);
    const range = sameDay
        ? `${formatDay(endMs, nowMs)}（${WEEKDAYS[new Date(endMs).getDay()]}）`
        : `${formatDay(startMs, nowMs)}–${formatDay(endMs, nowMs)}`;
    return `${range} · ${describeAgo(endMs, nowMs)}`;
}
