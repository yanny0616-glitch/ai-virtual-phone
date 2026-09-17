import { getChatPluginVar, listChatPluginVars, setChatPluginVar, unsetChatPluginVar } from "./chat-plugin-storage";
import type { ChatPluginVarScope } from "./chat-plugin-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

// 聊天变量：值就存在插件共用的变量池里（插件、APP 都读得到），
// 这里只另记用户给变量写的说明、取值范围、更新规则和改动历史。
const KEY = "chat_var_defs_v1";
registerKvMigration(KEY);

export const CHAT_VAR_DEFS_CHANGED_EVENT = "chat-var-defs-changed";

export type ChatVarKind = "number" | "choice" | "text";
export type ChatVarChange = { at: number; from: string; to: string; why: string; by: "ai" | "user" };
export type ChatVarDef = {
    id: string;
    name: string;
    scope: ChatPluginVarScope;
    targetId?: string;
    kind: ChatVarKind;
    min?: number;
    max?: number;
    options?: string[];
    desc: string;
    rule: string;
    ai: boolean;
    history: ChatVarChange[];
    createdAt: number;
};

const HISTORY_LIMIT = 20;
const TEXT_LIMIT = 200;

export function loadChatVarDefs(): ChatVarDef[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter((d): d is ChatVarDef => !!d && typeof d.id === "string" && typeof d.name === "string") : [];
    } catch {
        return [];
    }
}

function saveChatVarDefs(defs: ChatVarDef[]): void {
    kvSet(KEY, JSON.stringify(defs));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHAT_VAR_DEFS_CHANGED_EVENT));
}

export function chatVarDefsFor(sessionId: string, characterId?: string): ChatVarDef[] {
    return loadChatVarDefs().filter(def =>
        def.scope === "global"
        || (def.scope === "session" && def.targetId === sessionId)
        || (def.scope === "character" && !!characterId && def.targetId === characterId));
}

export function varValueText(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try { return JSON.stringify(value); } catch { return String(value); }
}

export function readChatVar(def: ChatVarDef): string {
    return varValueText(getChatPluginVar(def.name, def.scope, def.targetId));
}

const roundNum = (n: number) => Math.round(n * 100) / 100;

/** 把输入按变量类型收拾好：数字夹回范围，选项只收列表里的，文字截断 */
export function coerceChatVar(def: Pick<ChatVarDef, "kind" | "min" | "max" | "options">, raw: string): { ok: true; value: string | number } | { ok: false } {
    const text = raw.trim();
    if (def.kind === "number") {
        const n = Number(text.replace(/[＋]/g, "+").replace(/[－−]/g, "-"));
        if (!text || !Number.isFinite(n)) return { ok: false };
        let v = n;
        if (typeof def.min === "number") v = Math.max(def.min, v);
        if (typeof def.max === "number") v = Math.min(def.max, v);
        return { ok: true, value: roundNum(v) };
    }
    if (def.kind === "choice") {
        const hit = (def.options ?? []).find(option => option === text) ?? (def.options ?? []).find(option => option.toLowerCase() === text.toLowerCase());
        return hit === undefined ? { ok: false } : { ok: true, value: hit };
    }
    return { ok: true, value: text.slice(0, TEXT_LIMIT) };
}

export function writeChatVar(def: ChatVarDef, raw: string, by: "ai" | "user", why = ""): { from: string; to: string } | null {
    const coerced = coerceChatVar(def, raw);
    if (!coerced.ok) return null;
    const from = readChatVar(def);
    const to = String(coerced.value);
    if (from === to) return null;
    setChatPluginVar(def.name, coerced.value, def.scope, def.targetId);
    const defs = loadChatVarDefs();
    const target = defs.find(d => d.id === def.id);
    if (target) {
        target.history = [{ at: Date.now(), from, to, why: why.trim().slice(0, 60), by }, ...(target.history ?? [])].slice(0, HISTORY_LIMIT);
        saveChatVarDefs(defs);
    }
    return { from, to };
}

export function chatVarNameProblem(name: string, scope: ChatPluginVarScope, targetId: string | undefined, selfId?: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "名称不能空着";
    if (/[=＝|｜\[\]【】\n]/.test(trimmed)) return "名称里不能有 = | [ ] 这些符号";
    if (trimmed.length > 20) return "名称最多 20 个字";
    const clash = loadChatVarDefs().some(def => def.id !== selfId && def.scope === scope && def.targetId === targetId && def.name === trimmed);
    return clash ? "同一处已经有这个名字了" : "";
}

export function saveChatVarDef(def: ChatVarDef, value: string): void {
    const defs = loadChatVarDefs();
    const index = defs.findIndex(d => d.id === def.id);
    const previous = index >= 0 ? defs[index] : null;
    const clean: ChatVarDef = { ...def, name: def.name.trim(), desc: def.desc.trim(), rule: def.rule.trim() };
    if (index >= 0) defs[index] = clean; else defs.push(clean);
    saveChatVarDefs(defs);
    if (previous && previous.name !== clean.name) {
        const old = getChatPluginVar(previous.name, previous.scope, previous.targetId);
        unsetChatPluginVar(previous.name, previous.scope, previous.targetId);
        if (old !== null) setChatPluginVar(clean.name, old, clean.scope, clean.targetId);
    }
    writeChatVar(clean, value, "user", "你手动改");
}

export function deleteChatVarDef(id: string): void {
    const defs = loadChatVarDefs();
    const def = defs.find(d => d.id === id);
    if (!def) return;
    saveChatVarDefs(defs.filter(d => d.id !== id));
    unsetChatPluginVar(def.name, def.scope, def.targetId);
}

export function newChatVarDef(scope: ChatPluginVarScope, targetId?: string): ChatVarDef {
    return {
        id: `cv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: "", scope, targetId, kind: "number", min: 0, max: 100, options: [],
        desc: "", rule: "", ai: true, history: [], createdAt: Date.now(),
    };
}

function rangeText(def: ChatVarDef): string {
    if (def.kind === "number") {
        const lo = typeof def.min === "number" ? def.min : "";
        const hi = typeof def.max === "number" ? def.max : "";
        return lo === "" && hi === "" ? "（数字）" : `（${lo}–${hi}）`;
    }
    if (def.kind === "choice") return `（只能是：${(def.options ?? []).join("/")}）`;
    return "";
}

/** {{chatVariables}}：只列交给 AI 维护的变量；一个都没有时整条预设条目为空 */
export function buildChatVariablesPrompt(sessionId: string, characterId?: string): string {
    const defs = chatVarDefsFor(sessionId, characterId).filter(def => def.ai);
    if (!defs.length) return "";
    const lines = defs.map(def => {
        const value = readChatVar(def) || "（空）";
        const desc = def.desc ? `：${def.desc}` : "";
        const rule = def.rule ? `。规则：${def.rule}` : "";
        return `- ${def.name} = ${value}${rangeText(def)}${desc}${rule}`;
    });
    return [
        "## 聊天变量",
        "下面这些值记在这段聊天里，按各自的「规则」判断这轮要不要改：",
        ...lines,
        "要改就在回复最后另起一行，一个一行：",
        `[变量 ${defs[0].name}=新值｜为什么改]`,
        "没变化就不写。",
    ].join("\n");
}

const VAR_LINE_RE = /^[ \t]*[\[【]\s*变量[ \t:：]+([^=＝\]】\n]+?)\s*[=＝]\s*([^｜|\]】\n]*?)\s*(?:[｜|]\s*([^\]】\n]*?))?\s*[\]】][ \t]*$/gm;

export type ChatVarUpdate = { name: string; value: string; why: string };

export function extractChatVarLines(text: string): { text: string; updates: ChatVarUpdate[] } {
    const updates: ChatVarUpdate[] = [];
    const stripped = text.replace(VAR_LINE_RE, (_, name: string, value: string, why?: string) => {
        updates.push({ name: name.trim(), value: value.trim(), why: (why ?? "").trim() });
        return "";
    });
    if (!updates.length) return { text, updates };
    return { text: stripped.replace(/\n{3,}/g, "\n\n").trim(), updates };
}

export type ChatVarApplied = { name: string; from: string; to: string; why: string };

/** AI 只能改交给它维护的变量；插件的变量和只许用户改的变量一律不动 */
export function applyChatVarUpdates(sessionId: string, characterId: string | undefined, updates: ChatVarUpdate[]): ChatVarApplied[] {
    if (!updates.length) return [];
    const defs = chatVarDefsFor(sessionId, characterId).filter(def => def.ai);
    const applied: ChatVarApplied[] = [];
    for (const update of updates) {
        const def = defs.find(d => d.name === update.name);
        if (!def) continue;
        const result = writeChatVar(def, update.value, "ai", update.why);
        if (result) applied.push({ name: def.name, ...result, why: update.why });
    }
    return applied;
}

export function describeChatVarChanges(applied: ChatVarApplied[]): string {
    return applied.map(change => `${change.name} ${change.from || "（空）"} → ${change.to || "（空）"}${change.why ? ` · ${change.why}` : ""}`).join("；");
}

// ── 世界书 / 角色卡 {{setvar}}：local 存进本会话，global 存进全局 ──

export type MacroVarStore = {
    get(scope: "local" | "global", name: string): string | undefined;
    set(scope: "local" | "global", name: string, value: string): void;
};

export function createMacroVarStore(sessionId: string): MacroVarStore {
    const where = (scope: "local" | "global"): [ChatPluginVarScope, string | undefined] =>
        scope === "local" ? ["session", sessionId] : ["global", undefined];
    return {
        get(scope, name) {
            const [s, t] = where(scope);
            const value = getChatPluginVar(name, s, t);
            return value === null ? undefined : varValueText(value);
        },
        set(scope, name, value) {
            const [s, t] = where(scope);
            if (varValueText(getChatPluginVar(name, s, t)) !== value) setChatPluginVar(name, value, s, t);
        },
    };
}

export { listChatPluginVars };
