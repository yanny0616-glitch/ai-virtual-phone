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

export type ReplyGateBusyWindow = {
    from: string;
    to: string;
    title: string;
    /** 日程细排明确给出的休息时段，不从会议时长虚构课间。 */
    breaks?: { from: string; to: string }[];
};

export type ReplyGate = {
    /** 每天都生效的睡眠窗；bed > wake 视为跨夜 */
    sleep?: { bed: string; wake: string; mode: 0 | 1 | 2; wakeProb: number; bufferMin: number };
    /** 只对 date 这天生效的忙时段；peekMin=0 表示忙着也照常回 */
    busy?: { date: string; windows: ReplyGateBusyWindow[]; peekMin: number; adaptive?: boolean; focusedPeekProb?: number };
    updatedAt: number;
};

export type ReplyGateDecision =
    | { kind: "now"; note?: string }
    | { kind: "delay"; until: number; note: string; reason: "sleep" | "busy"; busyWindowKey?: string; busyUntil?: number; busyAvailableUntil?: number; busyCheck?: boolean };

export type DeferredReply = {
    cloud?: { key: string; projectUrl: string; revision: number; syncedRevision: number; attempted: boolean; cancelRequested?: boolean; state: "syncing" | "active" | "running" | "error" | "done" | "failed" | "cancelled" };
    until: number; note: string; firedAt?: number;
    characterId?: string; reason?: "sleep" | "busy";
    busyWindowKey?: string; busyUntil?: number; busyAvailableUntil?: number; busyCheck?: boolean;
};

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
                if (!from || !to || to <= from) return null;
                const breaks = (Array.isArray(r.breaks) ? r.breaks : []).flatMap(value => {
                    const pause = value && typeof value === "object" ? value as Record<string, unknown> : {};
                    const start = hm(pause.from), end = hm(pause.to);
                    return start && end && start >= from && end <= to && end > start ? [{ from: start, to: end }] : [];
                }).sort((a, b) => a.from.localeCompare(b.from)).slice(0, 20);
                return {
                    from, to, title: typeof r.title === "string" ? r.title.trim().slice(0, 40) : "",
                    ...(breaks.length ? { breaks } : {}),
                };
            })
            .filter((w): w is ReplyGateBusyWindow => !!w)
            .slice(0, 40);
        if (windows.length) gate.busy = {
            date: String(busy.date), windows, peekMin: clampInt(busy.peekMin, 0, 60, 0),
            ...(busy.adaptive === true ? { adaptive: true } : {}),
            ...(busy.focusedPeekProb != null ? { focusedPeekProb: clampInt(busy.focusedPeekProb, 0, 100, 0) } : {}),
        };
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
    if (typeof window !== "undefined") window.dispatchEvent(new Event("reply-gate-updated"));
}

export function clearCustomAppReplyGate(appId: string): void {
    const store = readStore();
    if (!store[appId]) return;
    delete store[appId];
    kvSet(GATE_KEY, JSON.stringify(store));
    if (typeof window !== "undefined") window.dispatchEvent(new Event("reply-gate-updated"));
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

const FOCUSED_BUSY_RE = /开会|会议|例会|晨会|周会|月会|上课|课堂|考试|测验|开车|驾驶|手术|面试|汇报|训练|排练|实验|演出|上台/;

function currentBusyWindow(gate: ReplyGate | null, now: Date): ReplyGateBusyWindow | undefined {
    const busy = gate?.busy;
    if (!busy || busy.peekMin <= 0 || busy.date !== fmtDate(now)) return undefined;
    const cur = fmtHM(now);
    return busy.windows.find(win => cur >= win.from && cur < win.to);
}

function busyWindowKey(gate: ReplyGate, win: ReplyGateBusyWindow): string {
    return JSON.stringify([gate.busy?.date, gate.busy?.adaptive === true, gate.busy?.peekMin, gate.busy?.focusedPeekProb ?? 0, win]);
}

function nextFocusedCheckAt(win: ReplyGateBusyWindow, nowMs: number, waitMs: number): number {
    const now = new Date(nowMs);
    const nextBreak = win.breaks?.find(pause => atHM(now, pause.from) > nowMs);
    return Math.min(nowMs + waitMs, nextBreak ? atHM(now, nextBreak.from) : atHM(now, win.to));
}

function isGateAsleep(gate: ReplyGate, now: Date): boolean {
    const sleep = gate.sleep, cur = fmtHM(now);
    return !!sleep && (sleep.bed > sleep.wake
        ? cur >= sleep.bed || cur < sleep.wake
        : cur >= sleep.bed && cur < sleep.wake);
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

    const busy = gate.busy, win = currentBusyWindow(gate, now);
    if (busy && win) {
        const end = atHM(now, win.to);
        const waitMs = jitterMin(busy.peekMin) * 60_000;
        let until = Math.min(nowMs + waitMs, end + 60_000);
        let busyAvailableUntil: number | undefined;
        let busyCheck: boolean | undefined;
        const what = win.title ? `正在${win.title}` : "正忙着";
        let note = `你${what}，是偷空看了一眼手机才回的：回得简短，可能提一句现在不方便多聊。`;
        if (busy.adaptive && FOCUSED_BUSY_RE.test(win.title)) {
            const pause = win.breaks?.find(item => atHM(now, item.to) > nowMs);
            const inBreak = pause && atHM(now, pause.from) <= nowMs;
            if (!inBreak && (busy.focusedPeekProb ?? 0) > 0) {
                until = nextFocusedCheckAt(win, nowMs, waitMs);
                busyCheck = true;
                note = `你还在${win.title}，刚抽出一点空看手机。把等待期间对方的消息合起来简短回复，之后还要继续忙；不要声称活动已经结束，也不要虚构正式休息。`;
            } else if (pause) {
                const start = Math.max(nowMs, atHM(now, pause.from)), stop = atHM(now, pause.to);
                until = start + Math.min(waitMs, (stop - start) / 2);
                busyAvailableUntil = stop;
                note = `你刚在${win.title}的休息间隙看了一眼手机。把等待期间对方发来的几条消息合起来回复，不必逐条点名；回复后还要继续忙，别反复解释自己在忙。`;
            } else {
                until = end + Math.min(waitMs, 5 * 60_000);
                note = `你刚忙完${win.title}，现在才有空看手机。把等待期间对方发来的消息合起来回复，不必逐条点名；不要再说自己正在这件事里偷空。`;
            }
        } else if (busy.adaptive) {
            note += "把等待期间对方发来的几条消息合起来回复，不必逐条点名，也别每次都重复解释自己在忙。";
        }
        return { kind: "delay", until, reason: "busy", note, busyWindowKey: busyWindowKey(gate, win), busyUntil: end, busyAvailableUntil, busyCheck };
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

export function listDeferredReplySessions(): string[] {
    return kvKeysWithPrefix(DEFER_PREFIX).map(key => key.slice(DEFER_PREFIX.length));
}

/** 到点的押后记录：标记已触发并返回会话 id，由桌面壳统一发回复请求（聊天室开着就它接，没开就后台生成） */
export function takeDueDeferredReplies(nowMs = Date.now()): string[] {
    const due: string[] = [];
    for (const key of kvKeysWithPrefix(DEFER_PREFIX)) {
        const sessionId = key.slice(DEFER_PREFIX.length);
        let rec = readDeferredReply(sessionId);
        if (!rec || rec.firedAt || rec.cloud || rec.until > nowMs) continue;
        // 新版等待记录到点重读日程：活动延长/换场/转为睡眠时改约；相同活动不重复掷等待时间。
        if (rec.characterId && rec.reason) {
            const gate = readReplyGate(rec.characterId);
            const win = currentBusyWindow(gate, new Date(nowMs));
            const sameWindow = gate && win && !isGateAsleep(gate, new Date(nowMs))
                && rec.busyWindowKey === busyWindowKey(gate, win)
                && (!rec.busyAvailableUntil || nowMs < rec.busyAvailableUntil);
            if (!sameWindow) {
                const decision = evaluateReplyGate(gate, "", nowMs);
                if (decision.kind === "delay") {
                    writeDeferredReply(sessionId, {
                        until: decision.until, note: decision.note, characterId: rec.characterId,
                        reason: decision.reason, busyWindowKey: decision.busyWindowKey, busyUntil: decision.busyUntil,
                        busyAvailableUntil: decision.busyAvailableUntil,
                        busyCheck: decision.busyCheck,
                    });
                    continue;
                }
                const finishedBusy = gate && rec.reason === "busy" && rec.busyUntil && rec.busyUntil <= nowMs;
                rec = { ...rec, note: decision.note || (finishedBusy
                    ? "你之前正忙，现在才有空看手机。把等待期间对方发来的消息合起来回复，不要再说正在先前的活动里偷空。"
                    : rec.reason === "sleep" && gate ? rec.note : "") };
            }
            if (sameWindow && rec.busyCheck && gate?.busy && win) {
                const now = new Date(nowMs);
                const pause = win.breaks?.find(item => atHM(now, item.from) <= nowMs && nowMs < atHM(now, item.to));
                // 一次到点检查只抽一次；不中就更新同一条等待，不按新消息或点击次数加抽。
                if (!pause && Math.random() * 100 >= (gate.busy.focusedPeekProb ?? 0)) {
                    writeDeferredReply(sessionId, {
                        ...rec, until: nextFocusedCheckAt(win, nowMs, jitterMin(gate.busy.peekMin) * 60_000),
                    });
                    continue;
                }
                rec = { ...rec, busyCheck: false, ...(pause ? {
                    busyAvailableUntil: atHM(now, pause.to),
                    note: `你正在${win.title}的休息间隙，把等待期间对方发来的消息合起来简短回复，之后还要继续忙。`,
                } : {}) };
            }
        }
        writeDeferredReply(sessionId, { ...rec, firedAt: nowMs });
        due.push(sessionId);
    }
    return due;
}

/** 忙碌拒绝不是执行完成；只退回本次领取，避免覆盖期间新增的等待或紧急回复。 */
export function retryBusyDeferredReply(sessionId: string, firedAt: number, nowMs = Date.now()): void {
    const rec = readDeferredReply(sessionId);
    if (!rec || rec.firedAt !== firedAt) return;
    const waiting = { ...rec };
    delete waiting.firedAt;
    writeDeferredReply(sessionId, { ...waiting, until: nowMs + 20_000 });
}

/** 押后 / 吵醒的那次回复，提示词里补一句为什么现在才回、该是什么状态 */
export function formatReplyGateNoteForPrompt(sessionId: string, nowMs = Date.now()): string {
    const rec = readDeferredReply(sessionId);
    if (!rec?.firedAt || !rec.note || nowMs - rec.firedAt > NOTE_TTL_MS) return "";
    return `<reply_timing>\n${rec.note}\n不要提这段说明本身。\n</reply_timing>`;
}
