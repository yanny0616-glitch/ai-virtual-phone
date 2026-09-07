// The installable app uses the host's existing memory store and pipeline.
import { loadCharacters } from "./character-storage";
import { hydrateChatStorage } from "./chat-storage";
import { loadMemoryConfig, saveMemoryConfig, loadMemoryEntriesByType, saveShiguangEdit } from "./memory-storage";
import type { MemoryEntry } from "./memory-types";
import { defaultShiguangSummary, isShiguang, shiguangPromptText, shiguangRecallMode } from "./shiguang-domain";
import { SHIGUANG_CATEGORIES, type ShiguangCategory } from "./shiguang-types";
import { runShiguangPipeline } from "./shiguang-summarizer";
import { loadNativeTimeline } from "./short-term-assembler";
import { estimateTokens } from "./token-counter";

function text(value: unknown, label: string, max: number, required = false): string {
    if (typeof value !== "string" || value.trim().length > max || (required && !value.trim())) throw new Error(`${label}为空或超过 ${max} 字`);
    return value.trim();
}
function character(record: Record<string, unknown>) {
    const id = text(record.characterId, "角色", 200, true);
    const found = loadCharacters().find(c => c.id === id);
    if (!found) throw new Error("角色不存在，请重新选择");
    return found;
}
function settings() {
    const config = loadMemoryConfig();
    return { enabled: config.shiguangEnabled, autoEnabled: config.shiguangAutoEnabled, roundInterval: config.shiguangRoundInterval, tokenBudget: config.shiguangTokenBudget };
}
export function presentShiguangEntry(entry: MemoryEntry) {
    return { ...entry, shiguang: { ...entry.shiguang!, promptSummary: entry.shiguang!.promptSummary?.trim() || defaultShiguangSummary(entry), recallMode: shiguangRecallMode(entry) },
        promptText: shiguangPromptText(entry), promptTokens: estimateTokens(shiguangPromptText(entry)) + 4 };
}
async function existing(record: Record<string, unknown>) {
    const c = character(record);
    const id = text(record.id, "记忆编号", 1000, true);
    const entry = (await loadMemoryEntriesByType(c.id, "shiguang")).find(e => e.id === id && isShiguang(e));
    if (!entry) throw new Error("记忆不存在或已删除，请刷新列表");
    return entry;
}

export async function readShiguangApp(record: Record<string, unknown>) {
    const c = character(record);
    const entries = (await loadMemoryEntriesByType(c.id, "shiguang")).filter(isShiguang)
        .sort((a, b) => b.shiguang!.lastEventAt.localeCompare(a.shiguang!.lastEventAt));
    return { version: 1, entries: entries.map(presentShiguangEntry), settings: settings(), categories: SHIGUANG_CATEGORIES };
}
export function readShiguangSettings() { return settings(); }
export function configureShiguangApp(record: Record<string, unknown>) {
    const config = loadMemoryConfig();
    for (const [input, key] of [["enabled", "shiguangEnabled"], ["autoEnabled", "shiguangAutoEnabled"]] as const) {
        if (record[input] !== undefined) {
            if (typeof record[input] !== "boolean") throw new Error("开关值无效");
            config[key] = record[input];
        }
    }
    for (const [input, key, min, max] of [["roundInterval", "shiguangRoundInterval", 5, 80], ["tokenBudget", "shiguangTokenBudget", 200, 4000]] as const) {
        if (record[input] !== undefined) {
            const value = record[input];
            if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${input} 须在 ${min}–${max} 之间`);
            config[key] = value;
        }
    }
    saveMemoryConfig(config);
    return settings();
}
export async function saveShiguangApp(record: Record<string, unknown>) {
    const entry = await existing(record);
    const base = text(record.expectedUpdatedAt, "记录版本", 100, true);
    const input = record.draft;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("缺少编辑内容");
    const d = input as Record<string, unknown>;
    const mode = d.recallMode;
    if (mode !== "priority" && mode !== "relevant" && mode !== "off") throw new Error("回忆方式无效");
    const status = d.status;
    if (status !== "remembered" && status !== "pending" && status !== "completed" && status !== "changed") throw new Error("进展无效");
    const categories = Array.isArray(d.categories) ? [...new Set(d.categories)].filter((v): v is ShiguangCategory => SHIGUANG_CATEGORIES.includes(v as ShiguangCategory)) : [];
    if (!categories.length) throw new Error("至少选择一种记忆类型");
    const dueAt = text(d.dueAt ?? "", "约定日期", 10);
    if (dueAt && (!/^\d{4}-\d{2}-\d{2}$/.test(dueAt) || !Number.isFinite(Date.parse(dueAt)) || new Date(dueAt).toISOString().slice(0, 10) !== dueAt)) throw new Error("约定日期无效");
    if (!Array.isArray(d.details) || d.details.length > 12) throw new Error("具体信息最多 12 项");
    const details = d.details.map(value => {
        if (!value || typeof value !== "object") throw new Error("具体信息格式无效");
        const fact = value as Record<string, unknown>;
        return { label: text(fact.label, "信息名称", 40, true), value: text(fact.value, "信息内容", 400, true) };
    });
    if (!Array.isArray(d.keywords) || d.keywords.length > 8) throw new Error("关键词最多 8 个");
    const next: MemoryEntry = { ...entry, content: text(d.content, "卡片简述", 200, true),
        updatedAt: new Date(Math.max(Date.now(), Date.parse(entry.updatedAt) + 1)).toISOString(),
        shiguang: { ...entry.shiguang!, title: text(d.title, "标题", 60, true), categories,
            reason: text(d.reason, "事情缘由", 1200), story: text(d.story, "事情经过", 1200), details,
            significance: text(d.significance, "值得记住的", 600), followup: text(d.followup, "后续", 1000),
            promptSummary: text(d.promptSummary, "供 AI 回忆的摘要", 12000, true), recallMode: mode,
            keywords: [...new Set(d.keywords.map(k => text(k, "关键词", 40, true)))],
            status, dueAt: status === "pending" ? dueAt || undefined : undefined, userEdited: true,
        } };
    await saveShiguangEdit(next, base);
    return presentShiguangEntry(next);
}
export async function deleteShiguangApp(record: Record<string, unknown>) {
    const entry = await existing(record);
    const base = text(record.expectedUpdatedAt, "记录版本", 100, true);
    const now = new Date(Math.max(Date.now(), Date.parse(entry.updatedAt) + 1)).toISOString();
    await saveShiguangEdit({ ...entry, updatedAt: now, shiguang: { ...entry.shiguang!, deletedAt: now, userEdited: true } }, base);
    return { deleted: true };
}
export async function shiguangAppSources(record: Record<string, unknown>) {
    const entry = await existing(record);
    await hydrateChatStorage();
    const ids = new Set(entry.sourceMessageIds || []);
    return loadNativeTimeline(entry.characterId).filter(item => ids.has(item.id)).map(item => ({ id: item.id, timestamp: item.timestamp, content: item.content, authorType: item.authorType }));
}
export async function organizeShiguangApp(record: Record<string, unknown>) {
    const c = character(record);
    await hydrateChatStorage();
    return runShiguangPipeline(c.id, c.name);
}
