// 小卷出主题：CSS 方案的准备 → 预览 → 应用 / 撤销，外加一个主题库。
// 和 mascot-edit-store 的方案日志是一回事，只是 CSS 不属于 EditScope（六个位置各存各的），
// 所以单开一条管线，落点全部收在 writeCssByTarget 这一个函数里。

import { kvGet, kvSet } from "./kv-db";

export const CSS_PLANS_KEY = "mascot_css_plans_v1";
export const CSS_LIBRARY_KEY = "mascot_css_library_v1";
const MAX_PLANS = 20;
const MAX_LIBRARY = 50;
const MAX_JOURNAL_BYTES = 4_000_000;

export type CssPlanStatus = "draft" | "previewing" | "applied" | "undone";

export type CssTarget = {
    location: string;
    /** chat_session / story 用；其余位置没有会话 */
    sessionId?: string;
    displayName?: string;
};

export type CssPlan = CssTarget & {
    id: string;
    title: string;
    before: string;
    after: string;
    status: CssPlanStatus;
    createdAt: string;
    appliedAt?: string;
    undoneAt?: string;
    libraryId?: string;
};

export type CssLibraryEntry = {
    id: string;
    name: string;
    location: string;
    sessionId?: string;
    displayName?: string;
    css: string;
    createdAt: string;
};

export const CSS_LOCATION_LABEL: Record<string, string> = {
    chat_app: "聊天应用",
    chat_session: "单独聊天室",
    mascot_chat: "AI助手聊天室",
    story: "剧情模式",
    music: "音乐",
    calendar: "日历",
};

function makeId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readRows<T>(key: string): T[] {
    const raw = kvGet(key);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        return [];
    }
}

export function readCssPlans(): CssPlan[] {
    return readRows<CssPlan>(CSS_PLANS_KEY);
}

export function getCssPlan(id: string): CssPlan | undefined {
    return readCssPlans().find(plan => plan.id === id);
}

function writeCssPlans(rows: CssPlan[]): void {
    const kept = rows.slice(-MAX_PLANS);
    while (kept.length > 1 && JSON.stringify(kept).length > MAX_JOURNAL_BYTES) kept.shift();
    kvSet(CSS_PLANS_KEY, JSON.stringify(kept));
}

export function createCssPlan(input: CssTarget & { title: string; before: string; after: string }): CssPlan {
    const plan: CssPlan = {
        ...input,
        id: makeId("cssplan"),
        status: "draft",
        createdAt: new Date().toISOString(),
    };
    writeCssPlans([...readCssPlans(), plan]);
    return plan;
}

function patchPlan(id: string, patch: Partial<CssPlan>): CssPlan {
    const rows = readCssPlans();
    const index = rows.findIndex(plan => plan.id === id);
    if (index < 0) throw new Error("找不到这份主题方案（只保留最近 20 份）");
    const updated = { ...rows[index], ...patch };
    rows[index] = updated;
    writeCssPlans(rows);
    return updated;
}

// ── 六个位置的读写 ──

function emit(name: string, detail?: unknown): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
}

export async function readCssByTarget(target: CssTarget): Promise<string> {
    if (target.location === "chat_app") return kvGet("chat-app-custom-css") || "";
    if (target.location === "music") return kvGet("music-custom-css") || "";
    if (target.location === "calendar") return kvGet("calendar-custom-css") || "";
    if (target.location === "mascot_chat") {
        const { getMascotSettingsSnapshot } = await import("./mascot-settings");
        return getMascotSettingsSnapshot().chatCustomCSS || "";
    }
    if (target.location === "chat_session") {
        if (!target.sessionId) throw new Error("缺少聊天会话 id");
        const { loadChatSessions } = await import("./chat-storage");
        const session = loadChatSessions().find(s => s.id === target.sessionId) as Record<string, unknown> | undefined;
        return (session?.customCSS as string) || "";
    }
    if (target.location === "story") {
        if (!target.sessionId) throw new Error("缺少剧情会话 id");
        const { loadStorySessions } = await import("./story-storage");
        const session = loadStorySessions().find(s => s.id === target.sessionId) as Record<string, unknown> | undefined;
        return (session?.customCSS as string) || "";
    }
    throw new Error(`未知 CSS 位置：${target.location}`);
}

export async function writeCssByTarget(target: CssTarget, css: string): Promise<void> {
    const trimmed = css.trim();
    const { kvRemove } = await import("./kv-db");
    if (target.location === "chat_app") {
        if (trimmed) kvSet("chat-app-custom-css", trimmed); else kvRemove("chat-app-custom-css");
        emit("chat-app-css-updated");
        return;
    }
    if (target.location === "mascot_chat") {
        const { updateMascotSettings } = await import("./mascot-settings");
        updateMascotSettings({ chatCustomCSS: trimmed });
        return;
    }
    if (target.location === "music") {
        if (trimmed) kvSet("music-custom-css", trimmed); else kvRemove("music-custom-css");
        emit("music-css-change", trimmed);
        return;
    }
    if (target.location === "calendar") {
        if (trimmed) kvSet("calendar-custom-css", trimmed); else kvRemove("calendar-custom-css");
        emit("calendar-css-updated", trimmed);
        return;
    }
    if (target.location === "chat_session") {
        if (!target.sessionId) throw new Error("缺少聊天会话 id");
        const { loadChatSessions, saveChatSessions } = await import("./chat-storage");
        const sessions = loadChatSessions();
        const index = sessions.findIndex(s => s.id === target.sessionId);
        if (index < 0) throw new Error("找不到这个聊天会话");
        (sessions[index] as Record<string, unknown>).customCSS = trimmed;
        saveChatSessions(sessions);
        emit("chat-session-css-updated", { sessionId: target.sessionId, css: trimmed });
        return;
    }
    if (target.location === "story") {
        if (!target.sessionId) throw new Error("缺少剧情会话 id");
        const { updateStorySession } = await import("./story-storage");
        updateStorySession(target.sessionId, { customCSS: trimmed });
        emit("story-session-css-updated", { sessionId: target.sessionId, css: trimmed });
        return;
    }
    throw new Error(`未知 CSS 位置：${target.location}`);
}

// ── 局部补丁 ──

export type CssPatch = { find: string; replace: string };

/** 每条补丁的原文必须在当前 CSS 里恰好出现一次，命中不唯一就整份拒绝，不赌哪一处。 */
export function applyCssPatches(current: string, patches: CssPatch[]): string {
    if (!Array.isArray(patches) || !patches.length) throw new Error("patches 不能为空");
    if (patches.length > 30) throw new Error("一次最多 30 条补丁");
    let css = current;
    for (const patch of patches) {
        const find = typeof patch?.find === "string" ? patch.find : "";
        const replace = typeof patch?.replace === "string" ? patch.replace : "";
        if (!find.trim()) throw new Error("补丁的 find 不能为空；整段重写请改用 css 参数");
        const index = css.indexOf(find);
        if (index < 0) throw new Error(`补丁没找到原文：${find.slice(0, 60)}…（请先读取CSS 拿到最新内容）`);
        if (css.indexOf(find, index + 1) >= 0) throw new Error(`补丁原文出现多次：${find.slice(0, 60)}…（请把定位片段写长一点）`);
        css = css.slice(0, index) + replace + css.slice(index + find.length);
    }
    return css;
}

// ── 预览 / 应用 / 撤销 ──

export async function previewCssPlan(id: string): Promise<CssPlan> {
    const plan = getCssPlan(id);
    if (!plan) throw new Error("找不到这份主题方案");
    await writeCssByTarget(plan, plan.after);
    return patchPlan(id, { status: "previewing" });
}

export async function endCssPreview(id: string): Promise<CssPlan> {
    const plan = getCssPlan(id);
    if (!plan) throw new Error("找不到这份主题方案");
    await writeCssByTarget(plan, plan.before);
    return patchPlan(id, { status: "draft" });
}

export async function applyCssPlan(id: string): Promise<CssPlan> {
    const plan = getCssPlan(id);
    if (!plan) throw new Error("找不到这份主题方案");
    await writeCssByTarget(plan, plan.after);
    return patchPlan(id, { status: "applied", appliedAt: new Date().toISOString() });
}

export async function undoCssPlan(id: string): Promise<CssPlan> {
    const plan = getCssPlan(id);
    if (!plan) throw new Error("找不到这份主题方案");
    await writeCssByTarget(plan, plan.before);
    return patchPlan(id, { status: "undone", undoneAt: new Date().toISOString() });
}

// ── 主题库 ──

export function readCssLibrary(): CssLibraryEntry[] {
    return readRows<CssLibraryEntry>(CSS_LIBRARY_KEY);
}

export function addToCssLibrary(entry: Omit<CssLibraryEntry, "id" | "createdAt">): CssLibraryEntry {
    const row: CssLibraryEntry = { ...entry, id: makeId("csslib"), createdAt: new Date().toISOString() };
    const rows = [...readCssLibrary(), row].slice(-MAX_LIBRARY);
    kvSet(CSS_LIBRARY_KEY, JSON.stringify(rows));
    return row;
}

export function removeCssLibraryEntry(id: string): void {
    kvSet(CSS_LIBRARY_KEY, JSON.stringify(readCssLibrary().filter(row => row.id !== id)));
}

/** 只存不应用：方案进主题库，页面上的 CSS 一个字都不动。 */
export function saveCssPlanToLibrary(id: string, name?: string): CssLibraryEntry {
    const plan = getCssPlan(id);
    if (!plan) throw new Error("找不到这份主题方案");
    const entry = addToCssLibrary({
        name: (name || plan.title || "未命名主题").slice(0, 40),
        location: plan.location,
        sessionId: plan.sessionId,
        displayName: plan.displayName,
        css: plan.after,
    });
    patchPlan(id, { libraryId: entry.id });
    return entry;
}

/** 从主题库套用一份：同样走方案管线，套坏了还能撤销。 */
export async function planFromLibraryEntry(entryId: string): Promise<CssPlan> {
    const entry = readCssLibrary().find(row => row.id === entryId);
    if (!entry) throw new Error("主题库里没有这一份");
    const target: CssTarget = { location: entry.location, sessionId: entry.sessionId, displayName: entry.displayName };
    const before = await readCssByTarget(target);
    return createCssPlan({ ...target, title: `套用主题库 · ${entry.name}`, before, after: entry.css });
}
