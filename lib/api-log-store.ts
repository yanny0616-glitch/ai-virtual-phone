// 独立模块，避免 chat-engine ↔ api-helpers 循环依赖；聊天引擎与 simpleLLMCall（记忆总结、
// 朋友圈、日历等后台调用）共用这份日志，统一在「底层调用大模型日志」面板查看。

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";
import { recordApiUsage } from "./api-usage-stats";

export type DebugInfo = {
    id: string;
    characterName?: string;
    /** 角色卡 id。改名后仍然指向同一张卡，按角色筛选/统计只认它；后台功能调用没有这个字段 */
    characterId?: string;
    model?: string;
    messages: { role: string; content: string; marker?: string }[];
    rawResponse: string;
    timestamp: string;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        /** 命中提示缓存的输入 token（按 1/10 计费） */
        cache_read_tokens?: number;
        /** 写入提示缓存的输入 token（按 1.25 倍计费） */
        cache_write_tokens?: number;
    };
    /** 模型思维链（reasoning/CoT）原文，独立于回复内容存储，避免被清洗吞掉 */
    reasoning?: string;
    /** 调用来源。取值就是发起方的 appId：chat / xiaohongshu / moments / group_chat / checkphone_* 等，
     *  外加 background（simpleLLMCall 后台功能，具体功能名看 characterName 标签）、qa（工坊答疑）、
     *  custom_app:<id>（自定义 APP）。用量页按它分栏，所以不能再把各 APP 合并成 chat */
    source?: string;
    /** 这次调用失败了（HTTP 非 2xx、网络错误、超时、空回复）。失败也要留痕，
     *  否则「为什么没回复」在日志与用量页里都查不到 */
    failed?: boolean;
    /** 归属通道：qa 进工坊专用环，其余进底层调用日志环。分流只认这个显式字段，不看角色名 */
    channel?: "chat" | "qa";
};

// 原为 50，但聊天请求与 18 处 simpleLLMCall 后台调用共享一个环，很容易把刚才的聊天记录挤掉，
// 因此扩容；配合单条截断与体积预算控制总占用。用户可在「用量」APP 里调，默认仍是 150。
const DEFAULT_API_LOGS = 150;
export const API_LOG_CAPACITY_OPTIONS = [50, 150, 300, 500] as const;
const MIN_API_LOGS = 50;
const MAX_API_LOGS_CAP = 500;
// 工坊环容量：只有答疑引擎写入，量小，维持原值。
const MAX_QA_API_LOGS = 50;
// 单环序列化字符预算：超预算时从最旧开始丢弃，控制 IndexedDB 常驻体积与序列化开销。
// 按条数等比放大，否则用户把容量调到 500 也会被 2MB 预算提前砍回一百多条。
const API_LOG_CHARS_PER_ENTRY = Math.floor(2 * 1024 * 1024 / DEFAULT_API_LOGS);
const MAX_QA_LOGS_SERIALIZED_CHARS = 1024 * 1024;
// 记忆总结类调用的完整 prompt 动辄几十 KB，写日志前先截断，控制每次 push 的 parse/stringify 写放大与常驻体积。
const MAX_LOG_MESSAGE_CHARS = 4000;
const MAX_LOG_MESSAGES_TOTAL_CHARS = 96_000;
const MAX_LOG_RESPONSE_CHARS = 8000;
const MAX_LOG_METADATA_CHARS = 200;

const API_LOGS_KEY = "ai_phone_api_logs_v1";
const API_LOG_CAPACITY_KEY = "ai_phone_api_log_capacity_v1";
// 工坊（QA 助手）专用调用记录，与聊天页「底层调用大模型日志」彻底隔离。
const QA_LOGS_KEY = "ai_phone_qa_api_logs_v1";
registerKvMigration(API_LOGS_KEY);
registerKvMigration(API_LOG_CAPACITY_KEY);
registerKvMigration(QA_LOGS_KEY);

function _loadLogs(key: string): DebugInfo[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(key) : null;
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as DebugInfo[] : [];
    } catch { return []; }
}
function _saveLogs(key: string, logs: DebugInfo[]): void {
    try { kvSet(key, JSON.stringify(logs)); } catch { /* 日志失败不影响主流程 */ }
}

function truncateForLog(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n…[日志截断：原文共 ${text.length} 字符]`;
}

function truncateMessagesForLog(messages: DebugInfo["messages"]): DebugInfo["messages"] {
    const truncated = messages.map(message => ({
        ...message,
        content: truncateForLog(message.content, MAX_LOG_MESSAGE_CHARS),
    }));
    const totalChars = truncated.reduce((sum, message) => sum + message.content.length, 0);
    if (totalChars <= MAX_LOG_MESSAGES_TOTAL_CHARS || truncated.length <= 1) return truncated;

    // 首条通常是系统提示，保留它和尽可能多的最新上下文；中间历史用一条说明代替。
    const first = truncated[0];
    const tail: DebugInfo["messages"] = [];
    let usedChars = first.content.length;
    for (let index = truncated.length - 1; index >= 1; index -= 1) {
        const message = truncated[index];
        if (usedChars + message.content.length > MAX_LOG_MESSAGES_TOTAL_CHARS) break;
        tail.push(message);
        usedChars += message.content.length;
    }
    tail.reverse();
    const omittedCount = truncated.length - 1 - tail.length;
    return [
        first,
        ...(omittedCount > 0 ? [{
            role: "system",
            content: `…[日志截断：省略 ${omittedCount} 条中间消息]`,
            marker: "log-truncated",
        }] : []),
        ...tail,
    ];
}

function truncateEntryForLog(entry: Omit<DebugInfo, "id" | "timestamp">): Omit<DebugInfo, "id" | "timestamp"> {
    return {
        ...entry,
        characterName: entry.characterName !== undefined
            ? truncateForLog(entry.characterName, MAX_LOG_METADATA_CHARS)
            : undefined,
        characterId: entry.characterId !== undefined
            ? truncateForLog(entry.characterId, MAX_LOG_METADATA_CHARS)
            : undefined,
        model: entry.model !== undefined ? truncateForLog(entry.model, MAX_LOG_METADATA_CHARS) : undefined,
        messages: truncateMessagesForLog(entry.messages),
        rawResponse: truncateForLog(entry.rawResponse, MAX_LOG_RESPONSE_CHARS),
        reasoning: entry.reasoning !== undefined ? truncateForLog(entry.reasoning, MAX_LOG_RESPONSE_CHARS) : undefined,
    };
}

function trimLogsForStorage(logs: DebugInfo[], maxCount: number, maxSerializedChars: number): DebugInfo[] {
    const candidates = logs.slice(-maxCount);
    const newestFirst: DebugInfo[] = [];
    let serializedChars = 2; // []

    // 每条只序列化一次，避免超预算时反复 stringify 整个日志环造成主线程卡顿。
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const entryChars = JSON.stringify(candidates[index]).length;
        const separatorChars = newestFirst.length > 0 ? 1 : 0;
        if (serializedChars + separatorChars + entryChars > maxSerializedChars) break;
        newestFirst.push(candidates[index]);
        serializedChars += separatorChars + entryChars;
    }

    return newestFirst.reverse();
}

export function getApiLogs(): DebugInfo[] { return _loadLogs(API_LOGS_KEY); }
export function clearApiLogs(): void { try { kvRemove(API_LOGS_KEY); } catch { } }

export function getApiLogCapacity(): number {
    try {
        const raw = typeof window !== "undefined" ? kvGet(API_LOG_CAPACITY_KEY) : null;
        const value = Math.floor(Number(raw));
        if (!Number.isFinite(value) || value <= 0) return DEFAULT_API_LOGS;
        return Math.max(MIN_API_LOGS, Math.min(MAX_API_LOGS_CAP, value));
    } catch { return DEFAULT_API_LOGS; }
}

/** 改容量立刻按新上限裁一次：调小了要马上腾出空间，不能等下一次写日志 */
export function setApiLogCapacity(value: number): number {
    const next = Math.max(MIN_API_LOGS, Math.min(MAX_API_LOGS_CAP, Math.floor(Number(value)) || DEFAULT_API_LOGS));
    try {
        kvSet(API_LOG_CAPACITY_KEY, String(next));
        const logs = _loadLogs(API_LOGS_KEY);
        if (logs.length > next) {
            _saveLogs(API_LOGS_KEY, trimLogsForStorage(logs, next, next * API_LOG_CHARS_PER_ENTRY));
        }
    } catch { /* 存不下就维持原样，读的时候会退回默认值 */ }
    return next;
}

export function getQaApiLogs(): DebugInfo[] { return _loadLogs(QA_LOGS_KEY); }
export function clearQaApiLogs(): void { try { kvRemove(QA_LOGS_KEY); } catch { } }

export function pushApiLog(entry: Omit<DebugInfo, "id" | "timestamp">): void {
    // 分流只认显式 channel 字段，不看角色名——避免角色恰好叫「工坊」时被误分类。
    const isQa = entry.channel === "qa";
    const key = isQa ? QA_LOGS_KEY : API_LOGS_KEY;
    const maxCount = isQa ? MAX_QA_API_LOGS : getApiLogCapacity();
    const maxSerializedChars = isQa ? MAX_QA_LOGS_SERIALIZED_CHARS : maxCount * API_LOG_CHARS_PER_ENTRY;
    // 日志环是定长的，按天的用量必须在写日志时就记下来，不能靠翻日志累加。
    recordApiUsage({
        model: entry.model,
        source: entry.source,
        failed: entry.failed,
        usage: entry.usage,
        characterId: entry.characterId,
        characterName: entry.characterName,
    });
    try {
        const logs = _loadLogs(key);
        logs.push({
            ...truncateEntryForLog(entry),
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
        });
        _saveLogs(key, trimLogsForStorage(logs, maxCount, maxSerializedChars));
    } catch { /* 日志写入失败不影响主流程 */ }
}
