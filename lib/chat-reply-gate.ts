// lib/chat-reply-gate.ts
// 自定义 app → 被动回复闸门。app 调 chat.setReplyGate 留下角色的作息（每天的睡眠窗）和
// 当天顾不上看手机的时段；用户发消息时宿主据此决定：立刻回、押后回、还是按概率被吵醒。
// app 关着时聊天照常发生，所以闸门必须是纯数据，宿主自己按墙钟判，不依赖 app 在线。
//
// 押后不是「不回」：人睡醒 / 忙完总会看到消息，所以睡着的三种模式在这里只分两路——
// 概率醒来（模式 2）掷中就立刻回，其余一律押到醒来之后。

import { kvGet, kvSet, kvRemove, kvKeysWithPrefix, registerKvMigration } from "./kv-db";
import { loadInstalledCustomApps } from "./custom-app-storage";

const GATE_KEY = "custom_app_reply_gate_v1";
const DEFER_PREFIX = "chat_reply_deferred_v1:";
registerKvMigration(GATE_KEY);

/** 押后回复真发出来之后，提示词里的「刚醒 / 偷空回」说明还保留这么久 */
const NOTE_TTL_MS = 15 * 60 * 1000;

export type ReplyGate = {
    /** 每天都生效的睡眠窗；bed > wake 视为跨夜 */
    sleep?: { bed: string; wake: string; mode: 0 | 1 | 2; wakeProb: number; bufferMin: number };
    /** 只对 date 这天生效的忙时段；peekMin=0 表示忙着也照常回 */
    busy?: { date: string; windows: { from: string; to: string; title: string }[]; peekMin: number };
    updatedAt: number;
};

export type ReplyGateDecision =
    | { kind: "now"; note?: string }
    | { kind: "delay"; until: number; note: string; reason: "sleep" | "busy" };

type DeferredReply = { until: number; note: string; firedAt?: number };

type Store = Record<string, Record<string, ReplyGate>>;

const URGENT_RE = /救命|出事|紧急|急事|报警|医院|受伤|流血|不舒服|害怕|崩溃|不想活|马上回|立刻回|快回|现在就回/;
const HM_RE = /^(\d{1,2}):(\d{2})$/;

function readStore(): Store {
    try {
        const raw = kvGet(GATE_KEY);
        const parsed = raw ? JSON.parse(raw) as unknown : null;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Store : {};
    } catch {
        return {};
    }
}

function hm(value: unknown): string {
    const m = HM_RE.exec(typeof value === "string" ? value.trim() : "");
    if (!m) return "";
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return "";
    return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

export function normalizeReplyGate(input: unknown): ReplyGate | null {
    if (!input || typeof input !== "object") return null;
    const raw = input as Record<string, unknown>;
    const gate: ReplyGate = { updatedAt: Date.now() };
    const sleep = raw.sleep as Record<string, unknown> | undefined;
    if (sleep && typeof sleep === "object") {
        const bed = hm(sleep.bed), wake = hm(sleep.wake);
        if (bed && wake && bed !== wake) {
            const mode = clampInt(sleep.mode, 0, 2, 0) as 0 | 1 | 2;
            gate.sleep = { bed, wake, mode, wakeProb: clampInt(sleep.wakeProb, 0, 100, 0), bufferMin: clampInt(sleep.bufferMin, 0, 120, 10) };
        }
    }
    const busy = raw.busy as Record<string, unknown> | undefined;
    if (busy && typeof busy === "object" && /^\d{4}-\d{2}-\d{2}$/.test(String(busy.date || ""))) {
        const windows = (Array.isArray(busy.windows) ? busy.windows : [])
            .map((w) => {
                const r = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
                const from = hm(r.from), to = hm(r.to);
                return from && to && to > from ? { from, to, title: typeof r.title === "string" ? r.title.trim().slice(0, 40) : "" } : null;
            })
            .filter((w): w is { from: string; to: string; title: string } => !!w)
            .slice(0, 40);
        if (windows.length) gate.busy = { date: String(busy.date), windows, peekMin: clampInt(busy.peekMin, 0, 60, 0) };
    }
    return gate.sleep || gate.busy ? gate : null;
}

export function setCustomAppReplyGate(appId: string, characterId: string, gate: ReplyGate | null): void {
    const store = readStore();
    if (gate) {
        store[appId] = { ...(store[appId] || {}), [characterId]: gate };
    } else if (store[appId]) {
        delete store[appId][characterId];
        if (Object.keys(store[appId]).length === 0) delete store[appId];
    }
    kvSet(GATE_KEY, JSON.stringify(store));
}

export function clearCustomAppReplyGate(appId: string): void {
    const store = readStore();
    if (!store[appId]) return;
    delete store[appId];
    kvSet(GATE_KEY, JSON.stringify(store));
}

/** 只认还装着、且还持有 chat.context 权限的 app；多个 app 都写了就取最近写的 */
export function readReplyGate(characterId: string): ReplyGate | null {
    const store = readStore();
    const allowed = new Set(loadInstalledCustomApps().filter(app => app.permissions.includes("chat.context")).map(app => app.id));
    let best: ReplyGate | null = null;
    for (const [appId, bucket] of Object.entries(store)) {
        const gate = allowed.has(appId) ? bucket[characterId] : null;
        if (gate && (!best || gate.updatedAt > best.updatedAt)) best = gate;
    }
    return best;
}

function fmtHM(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function atHM(base: Date, value: string, dayOffset = 0): number {
    const m = HM_RE.exec(value)!;
    return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, +m[1], +m[2]).getTime();
}

function jitterMin(base: number): number {
    return base * (0.6 + Math.random() * 0.8);
}

/** 明确要求马上回的话（救命、医院、快回…）：越过押后，也越过已有的等待 */
export function isUrgentReplyText(text: string): boolean {
    return URGENT_RE.test(String(text || "").replace(/\s+/g, ""));
}

export function evaluateReplyGate(gate: ReplyGate | null, text: string, nowMs = Date.now()): ReplyGateDecision {
    if (!gate) return { kind: "now" };
    if (URGENT_RE.test(text.replace(/\s+/g, ""))) return { kind: "now" };
    const now = new Date(nowMs);
    const cur = fmtHM(now);

    const sleep = gate.sleep;
    if (sleep) {
        const overnight = sleep.bed > sleep.wake;
        const asleep = overnight ? (cur >= sleep.bed || cur < sleep.wake) : (cur >= sleep.bed && cur < sleep.wake);
        if (asleep) {
            if (sleep.mode === 2 && Math.random() * 100 < sleep.wakeProb) {
                return { kind: "now", note: "你正睡着，被这条消息吵醒了：迷迷糊糊，只回一两句短的，多半还要接着睡。" };
            }
            const wakeAt = atHM(now, sleep.wake, overnight && cur >= sleep.bed ? 1 : 0);
            const until = wakeAt + jitterMin(sleep.bufferMin) * 60 * 1000;
            return { kind: "delay", until, reason: "sleep", note: `你刚起床，才看到对方 ${cur} 发来的消息（当时你睡着了，没看见）。可以自然带一句刚醒。` };
        }
    }

    const busy = gate.busy;
    if (busy && busy.peekMin > 0 && busy.date === fmtDate(now)) {
        const win = busy.windows.find(w => cur >= w.from && cur < w.to);
        if (win) {
            const end = atHM(now, win.to);
            const until = Math.min(nowMs + jitterMin(busy.peekMin) * 60 * 1000, end + 60 * 1000);
            const what = win.title ? `正在${win.title}` : "正忙着";
            return { kind: "delay", until, reason: "busy", note: `你${what}，是偷空看了一眼手机才回的：回得简短，可能提一句现在不方便多聊。` };
        }
    }
    return { kind: "now" };
}

export function readDeferredReply(sessionId: string): DeferredReply | null {
    try {
        const raw = kvGet(DEFER_PREFIX + sessionId);
        const parsed = raw ? JSON.parse(raw) as DeferredReply : null;
        return parsed && typeof parsed.until === "number" ? parsed : null;
    } catch {
        return null;
    }
}

export function writeDeferredReply(sessionId: string, record: DeferredReply | null): void {
    if (record) kvSet(DEFER_PREFIX + sessionId, JSON.stringify(record));
    else kvRemove(DEFER_PREFIX + sessionId);
}

/** 到点的押后记录：标记已触发并返回会话 id，由桌面壳统一发回复请求（聊天室开着就它接，没开就后台生成） */
export function takeDueDeferredReplies(nowMs = Date.now()): string[] {
    const due: string[] = [];
    for (const key of kvKeysWithPrefix(DEFER_PREFIX)) {
        const sessionId = key.slice(DEFER_PREFIX.length);
        const rec = readDeferredReply(sessionId);
        if (!rec || rec.firedAt || rec.until > nowMs) continue;
        writeDeferredReply(sessionId, { ...rec, firedAt: nowMs });
        due.push(sessionId);
    }
    return due;
}

/** 押后 / 吵醒的那次回复，提示词里补一句为什么现在才回、该是什么状态 */
export function formatReplyGateNoteForPrompt(sessionId: string, nowMs = Date.now()): string {
    const rec = readDeferredReply(sessionId);
    if (!rec?.firedAt || !rec.note || nowMs - rec.firedAt > NOTE_TTL_MS) return "";
    return `<reply_timing>\n${rec.note}\n不要提这段说明本身。\n</reply_timing>`;
}
