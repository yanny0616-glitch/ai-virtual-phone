// 挂念直连用的接口（/app/…）：挂念 App 和小手机宿主经 https://<站点>/companion 直接读写后端。
//   GET  /app/state?ids=a,b                  挂念界面：生活面、念头（带状态和轨迹）、账本、判断记录
//   GET  /app/archive?id=a&limit=30          记录页：最近几天
//   GET  /app/host?ids=a,b                   宿主：在线状态用的日子、注入聊天的文字、待发的朋友圈
//   POST /app/characters/:id/handoff         停旧云调度、确认待发任务已撤销，暂不启用 VPS
//   POST /app/characters/:id                 新挂念一个角色 / 更新名字和会话 { name, sessionId, settings, enabled }
//   PUT  /app/characters/:id/settings        设置（只收设置键）
//   PUT  /app/characters/:id/inputs          { affection, days: [{ date, calendar, routine, exceptions }], routineOn }
//   PUT  /app/characters/:id/day             改今天的日程 { date, schedule, forks, conds }
//   POST /app/characters/:id/threads         账本 { op: add|done|undone|drop, id, thread }
//   POST /app/characters/:id/items/cancel    撤掉一个还没发的念头 { wakeId }
//   POST /app/characters/:id/moments/ack     朋友圈发没发 { id, status, postId, note }
//   POST /app/characters/:id/regenerate      重新生成今天
//   POST /app/characters/:id/tick               立刻跑一轮
//   PUT  /app/wake/templates/:sourceId          唤醒后端：手机寄来的来源底稿（见 wake.ts）
//   POST /app/wake/templates/:sourceId/delete   来源不再交给后端
//   GET  /app/wake/status?source=x              唤醒后端：底稿概况（不含密钥）、网关来源状态、最近处理记录
//   POST /app/jobs                              离线任务（回复兜底/追问/定时消息/经期关怀）：同键覆盖；正在生成的回 409（见 jobs.ts）
//   POST /app/jobs/cancel                       撤销 { triggerKey | triggerPrefix, excludeKey }：没开始的删，正在生成的挂撤销 → { deleted, running }
//   POST /app/jobs/deferred                     忙碌回复 { action: get|put|cancel, key, payload }：回执同个人云 deferred-reply；不带 key 的 get 报能力
//   POST /app/jobs/delay                        心跳 { triggerKey, runNow }：没开始的推到 90 秒后（runNow 立即）
//   GET  /app/jobs?limit=30                     最近的离线任务（不含请求本体）
//   GET  /app/weixin                            微信助手后端轮询 { enabled, heartbeat }（见 weixin.ts）
//   POST /app/weixin                            开关 { enabled }；POST /app/weixin/run 立刻轮询一次（测试用，不看开关）
// 改状态的都在 Runner 的锁里做：正在跑的一轮调模型时改了，会被那轮结束时的保存盖掉。

import { importFromCloud, importMissingCloudTasks, importPendingCloudFeedback } from "./importer.ts";
import { stopLegacyScheduler } from "./handoff.ts";
import type { EngineDeps } from "./engine.ts";
import { characterTz, generateDayNow } from "./engine.ts";
import { chatContextText } from "./context.ts";
import { forkDay, hhmm, localDate, localHMOn, normHM } from "./life.ts";
import { fixedForDay } from "./routine.ts";
import type { Runner } from "./runner.ts";
import type { CharacterRow, DayRow, DecisionRow, Store, TimerRow } from "./store.ts";
import { threadAlive, threadsEnabled } from "./threads.ts";
import { validateWakeTemplate, type WakeService, type WakeTemplate } from "./wake.ts";
import type { WeixinService } from "./weixin.ts";
import { DEFERRED_KEY, deferredReceipt, putDeferred, validateJob, type JobPayload } from "./jobs.ts";
import { SETTING_KEYS, type GuanianDay, type GuanianSched, type PlanItem, type Thread } from "./types.ts";

export type AppDeps = { store: Store; runner: Runner; engine: EngineDeps; wake?: WakeService; weixin?: WeixinService };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const DAY = 86_400_000;
/** 改动排在一轮判断后面时，最多等这么久再回话；没做完就告诉手机「排上了」 */
const WAIT_MS = 20_000;

async function settle<T>(p: Promise<T>, waitMs: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), waitMs); });
  const done = p.then(value => ({ done: true as const, value }));
  done.catch(() => undefined); // 回过话之后才失败的，别变成未处理的拒绝
  try { return await Promise.race([done, late]); }
  finally { clearTimeout(timer); }
}

function ids(query: URLSearchParams, key = "ids"): string[] {
  return [...new Set(String(query.get(key) || "").split(",").map(s => s.trim()).filter(Boolean))].slice(0, 12);
}

function mustCharacter(store: Store, id: string): CharacterRow {
  const c = store.getCharacter(id);
  if (!c) throw new HttpError(404, "后端还没有这个角色");
  return c;
}

function tzOf(c: CharacterRow): number {
  const tz = characterTz(c);
  if (tz === null) throw new HttpError(409, "这个角色缺时区");
  return tz;
}

const prevDate = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

// ─── 念头给界面看的样子：状态、押后、发送前复核、轨迹

type ViewItem = PlanItem & {
  delivery: string; adj: string; held?: boolean;
  hist: { at: number; kind: string; note: string; by: string }[];
  serverStatus: { status: string; note: string; at: number };
  presend?: Record<string, unknown>;
};

const SELF_KINDS = new Set(["extra", "thread", "done", "miss", "echo", "quiet"]);

function itemStatus(item: PlanItem, timer: TimerRow | null, nowMs: number): ViewItem["serverStatus"] {
  if (item.generatedAt) return { status: "sent", note: "后端已生成并推送", at: item.generatedAt };
  if (!item.act) return { status: "skipped", note: item.why || "没有起念", at: 0 };
  if (!timer) return item.fireAt > nowMs ? { status: "pending", note: "", at: item.fireAt } : { status: "unknown", note: "后端没有这条的定时器记录", at: 0 };
  switch (timer.status) {
    case "pending": return { status: "pending", note: timer.note, at: timer.fireAt };
    case "running": return { status: "running", note: "正在生成", at: timer.updatedAt };
    case "done": return timer.note === "已发送" ? { status: "sent", note: "后端已生成并推送", at: timer.updatedAt } : { status: "skipped", note: timer.note, at: timer.updatedAt };
    case "cancelled": return { status: "cancelled", note: timer.note, at: timer.updatedAt };
    case "failed": return { status: "failed", note: timer.note, at: timer.updatedAt };
    case "shadow": return { status: "skipped", note: "影子模式：" + timer.note, at: timer.updatedAt };
    default: return { status: "unknown", note: timer.note, at: timer.updatedAt };
  }
}

function viewItem(store: Store, item: PlanItem, byWake: Map<string, DecisionRow[]>, nowMs: number): ViewItem {
  const timer = item.wakeId ? store.getTimer(item.wakeId) : null;
  const decisions = byWake.get(item.wakeId) || [];
  const status = itemStatus(item, timer, nowMs);
  const view: ViewItem = {
    ...item,
    delivery: item.act && item.wakeId ? "push" : "",
    adj: item.kind === "fork" ? "fork" : SELF_KINDS.has(String(item.kind)) ? "extra" : "",
    hist: decisions.map(d => ({ at: d.at, kind: d.kind, note: d.note, by: "server" })),
    serverStatus: status,
  };
  // 押后：定时器挪了时间，界面按新时间显示，原时刻留在 origFireAt
  if (timer && timer.status === "pending" && item.act && Math.abs(timer.fireAt - item.fireAt) >= 60_000) {
    view.origFireAt = Number(item.origFireAt) || item.fireAt;
    view.fireAt = timer.fireAt;
    view.held = true;
  }
  const presend = [...decisions].reverse().find(d => d.kind === "presend");
  if (presend) {
    const data = presend.data || {};
    view.presend = { ...data, at: presend.at, note: presend.note, blocked: !/复核通过/.test(presend.note) };
  }
  return view;
}

function decisionsByWake(store: Store, characterId: string, sinceMs: number): Map<string, DecisionRow[]> {
  const out = new Map<string, DecisionRow[]>();
  for (const d of store.listDecisionsSince(characterId, sinceMs)) {
    const wakeId = d.data && typeof d.data.wakeId === "string" ? d.data.wakeId : "";
    if (!wakeId) continue;
    const list = out.get(wakeId) || [];
    list.push(d);
    out.set(wakeId, list);
  }
  return out;
}

function dayView(row: DayRow | null, tz: number, nowMs: number, affection: unknown): (GuanianDay & { date: string; characterId: string; by: string }) | null {
  if (!row?.day) return null;
  const base = { ...row.day, tz };
  // 今天按此刻揭晓变数；过去的日子按那天结束时揭晓，和当天看到的一样
  const at = row.date === localDate(nowMs, tz) ? nowMs : (localHMOn(row.date, "23:59", tz) ?? nowMs);
  return { ...forkDay(base, at, affection), date: row.date, characterId: row.characterId, by: row.source || "server" };
}

function planView(store: Store, c: CharacterRow, row: DayRow | null, date: string, tz: number, nowMs: number, byWake: Map<string, DecisionRow[]>) {
  const start = localHMOn(date, "00:00", tz) ?? nowMs;
  // 约定的念头可能挂在别的日子那行里：按到点时刻落在这一天的都算进来
  const others = store.listDays(c.characterId, 40).filter(r => r.date !== date)
    .flatMap(r => r.items.filter(i => i.fireAt >= start && i.fireAt < start + DAY));
  const items = [...(row?.items || []), ...others].map(i => viewItem(store, i, byWake, nowMs)).sort((a, b) => a.fireAt - b.fireAt);
  return {
    date, characterId: c.characterId, items,
    recheckAt: row?.judgedAt || 0, plannedAt: row?.judgedAt || 0, recheckCount: row?.recheckCount || 0, selfUsed: row?.selfUsed || 0,
    genError: row?.genError || "", genLog: row?.genLog || [], genTries: row?.genTries || 0, by: row?.source || "", updatedAt: row?.updatedAt || 0,
  };
}

function contextFor(store: Store, c: CharacterRow, tz: number, nowMs: number): string {
  const date = localDate(nowMs, tz);
  const row = store.getDay(c.characterId, date);
  const prev = store.getDay(c.characterId, prevDate(date));
  return chatContextText({ day: row?.day || null, prev: prev?.day ? { ...prev.day, tz } : null, settings: c.settings, threads: c.state.threads, nowMs, tz, threadsOn: threadsEnabled({ ...c.settings, ...c.state }) });
}

export function appState(deps: AppDeps, characterIds: string[], nowMs = deps.engine.now()) {
  const { store, runner } = deps;
  return {
    mode: runner.mode, running: runner.running, lastTickAt: runner.lastTickAt, now: nowMs,
    characters: characterIds.map(id => {
      const c = store.getCharacter(id);
      if (!c) return { characterId: id, exists: false };
      const tz = characterTz(c);
      if (tz === null) return { characterId: id, exists: true, name: c.name, enabled: c.enabled, error: "这个角色缺时区" };
      const date = localDate(nowMs, tz);
      const row = store.getDay(id, date);
      const byWake = decisionsByWake(store, id, nowMs - 3 * DAY);
      const snapshots = store.listSnapshots().filter(s => s.characterId === id).map(s => ({ purpose: s.purpose, capturedAt: s.capturedAt, receivedAt: s.receivedAt }));
      const decisions = store.listDecisions(id, 120).map(d => ({ at: d.at, kind: d.kind, note: d.note, mode: d.mode, wakeId: d.data && typeof d.data.wakeId === "string" ? d.data.wakeId : "" }));
      return {
        characterId: id, exists: true, legacyStopped: store.getMeta("handoff:" + id) === "done" && store.getMeta("handoff-tasks:" + id) === "done", name: c.name, enabled: c.enabled, sessionId: c.sessionId, tz, date,
        settings: c.settings,
        day: dayView(row, tz, nowMs, c.settings.affection),
        prev: dayView(store.getDay(id, prevDate(date)), tz, nowMs, c.settings.affection),
        plan: planView(store, c, row, date, tz, nowMs, byWake),
        threads: Array.isArray(c.state.threads) ? c.state.threads : [],
        moments: { outbox: Array.isArray(c.state.outbox) ? c.state.outbox : [], history: Array.isArray(c.state.momentHistory) ? c.state.momentHistory : [],
          last: Number(c.state.momentsLast) || 0, weekN: Number(c.state.momentsWeekN) || 0, weekStart: Number(c.state.momentsWeekStart) || 0 },
        decisions, snapshots,
        pendingTimers: store.listTimers(id, nowMs).filter(t => t.status === "pending").length,
        lastError: runner.lastTraces.get(id)?.error || "",
        chatContext: contextFor(store, c, tz, nowMs),
      };
    }),
  };
}

export function appArchive(deps: AppDeps, characterId: string, limit: number, nowMs = deps.engine.now()) {
  const { store } = deps;
  const c = mustCharacter(store, characterId);
  const tz = tzOf(c);
  const rows = store.listDays(characterId, Math.max(1, Math.min(60, limit)));
  const oldest = rows.length ? localHMOn(rows[rows.length - 1].date, "00:00", tz) ?? nowMs - 60 * DAY : nowMs;
  const byWake = decisionsByWake(store, characterId, oldest - DAY);
  return {
    characterId,
    days: rows.map(r => ({
      date: r.date,
      day: dayView(r, tz, nowMs, c.settings.affection),
      plan: { date: r.date, characterId, items: r.items.map(i => viewItem(store, i, byWake, nowMs)).sort((a, b) => a.fireAt - b.fireAt), recheckAt: r.judgedAt, by: r.source },
    })),
    moments: Array.isArray(c.state.momentHistory) ? c.state.momentHistory : [],
  };
}

export function appHost(deps: AppDeps, characterIds: string[], nowMs = deps.engine.now()) {
  const { store } = deps;
  return {
    now: nowMs,
    characters: characterIds.map(id => {
      const c = store.getCharacter(id);
      if (!c || !c.enabled) return { characterId: id, exists: !!c, enabled: false };
      const tz = characterTz(c);
      if (tz === null) return { characterId: id, exists: true, enabled: c.enabled, error: "这个角色缺时区" };
      const date = localDate(nowMs, tz);
      const row = store.getDay(id, date);
      const day = dayView(row, tz, nowMs, c.settings.affection);
      return {
        characterId: id, exists: true, enabled: true, tz, date,
        day, prev: dayView(store.getDay(id, prevDate(date)), tz, nowMs, c.settings.affection),
        settings: {
          quietStart: c.settings.quietStart, quietEnd: c.settings.quietEnd, momentsOn: c.settings.momentsOn, momentsWeekly: c.settings.momentsWeekly, momentsGapH: c.settings.momentsGapH,
          momentsLast: Number(c.state.momentsLast) || 0, momentsWeekN: Number(c.state.momentsWeekN) || 0, momentsWeekStart: Number(c.state.momentsWeekStart) || 0,
        },
        context: contextFor(store, c, tz, nowMs),
        contextAt: hhmm(nowMs, tz),
        moments: (Array.isArray(c.state.outbox) ? c.state.outbox : []).filter(o => o && o.id && o.hint),
      };
    }),
  };
}

// ─── 改状态

/** 这次改动会停掉角色：排队期间就让引擎看到，不在锁外先发 */
const stopKeys = (id: string, body: Record<string, unknown>, settings: Record<string, unknown>): string[] =>
  body.enabled === false || ("recheckEnabled" in settings && Number(settings.recheckEnabled) === 0) ? ["char:" + id] : [];

/** 账本里这件事挂着的、还没发的念头 */
function threadWakeKeys(store: Store, characterId: string, threadId: string): string[] {
  return store.listDays(characterId, 40).flatMap(r => r.items).filter(i => i.from === threadId && i.wakeId && !i.generatedAt).map(i => "wake:" + i.wakeId);
}

function pickSettings(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) if (key in body) out[key] = body[key];
  return out;
}

export async function upsertCharacter(deps: AppDeps, id: string, body: Record<string, unknown>) {
  const rawSettings = body.settings && typeof body.settings === "object" ? body.settings as Record<string, unknown> : {};
  return deps.runner.exclusive(() => {
    const { store } = deps;
    const nowMs = deps.engine.now();
    const existing = store.getCharacter(id);
    const settings = pickSettings(body.settings && typeof body.settings === "object" ? body.settings as Record<string, unknown> : {});
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim().slice(0, 200) : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!existing) {
      const tz = Number(settings.tzOffsetMin);
      if (!sessionId) throw new HttpError(400, "新角色要带 sessionId（打开一次和TA的聊天）");
      if (!Number.isInteger(tz) || tz < -840 || tz > 840) throw new HttpError(400, "新角色要带时区 tzOffsetMin");
      const c: CharacterRow = { characterId: id, sessionId, name, enabled: body.enabled !== false, settings, state: { threads: [] }, importedAt: nowMs, updatedAt: nowMs };
      store.saveCharacter(c);
      store.addDecision(id, "setup", `开始挂念${name ? "「" + name + "」" : ""}`, deps.runner.mode, null, nowMs);
      return { created: true, character: c };
    }
    Object.assign(existing.settings, settings);
    if (name) existing.name = name;
    if (sessionId) existing.sessionId = sessionId;
    if ("enabled" in body) existing.enabled = body.enabled !== false;
    store.saveCharacter(existing);
    return { created: false, character: existing };
  }, stopKeys(id, body, rawSettings));
}

export async function saveSettings(deps: AppDeps, id: string, body: Record<string, unknown>) {
  return deps.runner.exclusive(() => {
    const c = mustCharacter(deps.store, id);
    Object.assign(c.settings, pickSettings(body));
    if ("enabled" in body) c.enabled = body.enabled !== false;
    deps.store.saveCharacter(c);
    return { settings: c.settings, enabled: c.enabled };
  }, stopKeys(id, body, body));
}

export async function saveInputs(deps: AppDeps, id: string, body: Record<string, unknown>) {
  return deps.runner.exclusive(() => {
    const { store } = deps;
    const c = mustCharacter(store, id);
    const tz = tzOf(c);
    const nowMs = deps.engine.now();
    const saved: string[] = [];
    // 固定作息原件存一份：宿主只寄今明两天，手机一直不开时后端按原件往后展开
    const firstDay = Array.isArray(body.days) ? body.days[0] as Record<string, unknown> | undefined : undefined;
    if (firstDay && typeof firstDay === "object") {
      const list = (v: unknown) => (Array.isArray(v) ? v : []).filter(x => x && typeof x === "object").slice(0, 60);
      store.saveRoutine(id, list(firstDay.routine), list(firstDay.exceptions), body.routineOn !== false);
    }
    if ("affection" in body) {
      const a = body.affection as Record<string, unknown> | null;
      const next = a && typeof a === "object" && (a.tier || a.relation) ? { score: Number(a.score) || 0, tier: String(a.tier || "").slice(0, 20), relation: String(a.relation || "").slice(0, 20) } : null;
      if (JSON.stringify(next) !== JSON.stringify(c.settings.affection ?? null)) { c.settings.affection = next; store.saveCharacter(c); saved.push("affection"); }
    }
    for (const d of Array.isArray(body.days) ? body.days.slice(0, 3) as Record<string, unknown>[] : []) {
      const date = String(d?.date || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const fixed = fixedForDay(d.calendar, d.routine, d.exceptions, date, tz, nowMs, body.routineOn !== false);
      const old = store.getCalendar(id, date);
      if (!old || JSON.stringify(old) !== JSON.stringify(fixed)) { store.saveCalendar(id, date, fixed.items, fixed.routine); saved.push(date); }
    }
    return { saved };
  });
}

const cleanSched = (raw: unknown): GuanianSched[] => (Array.isArray(raw) ? raw : []).slice(0, 16)
  .filter(it => it && typeof it === "object" && normHM((it as GuanianSched).time) && String((it as GuanianSched).title || "").trim())
  .map(raw => {
    const it = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {
      time: normHM(it.time), end: normHM(it.end), title: String(it.title).slice(0, 40), place: String(it.place || "").slice(0, 16),
      note: String(it.note || "").slice(0, 200), mood: String(it.mood || "").slice(0, 24), cost: Math.max(-15, Math.min(15, Math.round(Number(it.cost) || 0))),
    };
    if (typeof it.busy === "boolean") out.busy = it.busy;
    if (Array.isArray(it.steps)) out.steps = it.steps.slice(0, 8).map(x => ({ time: normHM((x as { time?: unknown }).time), what: String((x as { what?: unknown }).what || "").slice(0, 30) })).filter(x => x.time && x.what);
    for (const k of ["detail", "from", "why", "fork"]) if (typeof it[k] === "string" && it[k]) out[k] = String(it[k]).slice(0, 200);
    if (it.moved) out.moved = true;
    if (out.end && String(out.end) <= String(out.time)) out.end = "";
    return out as GuanianSched;
  })
  .sort((a, b) => String(a.time).localeCompare(String(b.time)));

export async function saveDaySchedule(deps: AppDeps, id: string, body: Record<string, unknown>) {
  return deps.runner.exclusive(() => {
    const { store } = deps;
    const c = mustCharacter(store, id);
    const tz = tzOf(c);
    const nowMs = deps.engine.now();
    const date = String(body.date || localDate(nowMs, tz));
    const row = store.getDay(id, date);
    if (!row?.day) throw new HttpError(404, "这天还没有生活面");
    const schedule = cleanSched(body.schedule);
    if (!schedule.length) throw new HttpError(400, "日程不能是空的");
    // 界面上的日程已经揭晓过变数：连同变数结算结果一起存，免得再揭晓一遍插重复的事
    const day: GuanianDay = { ...row.day, schedule };
    if (Array.isArray(body.forks)) day.forks = body.forks.slice(0, 6);
    if (Array.isArray(body.conds)) day.conds = (body.conds as GuanianDay["conds"])!.slice(-8);
    row.day = day;
    store.saveDay(row);
    store.addDecision(id, "schedule", String(body.note || "你改了今天的日程").slice(0, 200), deps.runner.mode, null, nowMs);
    return { day: dayView(row, tz, nowMs, c.settings.affection) };
  });
}

function dropThreadItems(deps: AppDeps, c: CharacterRow, threadId: string, why: string, nowMs: number): number {
  const { store } = deps;
  let n = 0;
  for (const row of store.listDays(c.characterId, 40)) {
    let dirty = false;
    for (const item of row.items) {
      if (item.from !== threadId || !item.act || item.generatedAt) continue;
      const timer = item.wakeId ? store.getTimer(item.wakeId) : null;
      if (timer && timer.status === "running") continue; // 正在生成的拦不住，交给成文后复核
      if (timer && timer.status !== "pending") continue;
      if (timer) store.updateTimer(timer.id, { status: "cancelled", note: why });
      item.act = false; item.why = why; dirty = true; n += 1;
      store.addDecision(c.characterId, "recheck", `取消 ${item.time}——${why}`, deps.runner.mode, { wakeId: item.wakeId }, nowMs);
    }
    if (dirty) store.saveDay(row);
  }
  return n;
}

export async function editThreads(deps: AppDeps, id: string, body: Record<string, unknown>) {
  const halts = ["done", "drop"].includes(String(body.op)) ? threadWakeKeys(deps.store, id, String(body.id || "")) : [];
  return deps.runner.exclusive(() => {
    const { store } = deps;
    const c = mustCharacter(store, id);
    const tz = tzOf(c);
    const nowMs = deps.engine.now();
    const days = Number(c.settings.threadDays) || 3;
    const list: Thread[] = (Array.isArray(c.state.threads) ? c.state.threads : []).map(t => ({ ...t }));
    const op = String(body.op || "");
    let note = "";
    let dropped = 0;
    if (op === "add") {
      const raw = (body.thread && typeof body.thread === "object" ? body.thread : {}) as Record<string, unknown>;
      const text = String(raw.text || "").trim().slice(0, 60);
      const kind = ["topic", "promise", "date"].includes(String(raw.kind)) ? String(raw.kind) : "topic";
      const due = Number(raw.due) || 0;
      if (!text) throw new HttpError(400, "要记的事是空的");
      if (kind !== "topic" && !due) throw new HttpError(400, "约定和日子要有时间");
      const t: Thread = { id: "t" + Math.random().toString(36).slice(2, 6), kind, text, due, yearly: kind === "date" && /生日|纪念/.test(text), since: nowMs, at: nowMs, by: "user", done: false, why: "你手动记的" };
      if (kind === "promise") Object.assign(t, { subject: ["user", "character", "both"].includes(String(raw.subject)) ? String(raw.subject) : "user", revision: 1, status: "pending" });
      list.push(t);
      note = `记下「${text}」`;
    } else {
      const t = list.find(x => x.id === String(body.id || ""));
      if (!t) throw new HttpError(404, "账本里没有这件事");
      if (op === "done") {
        t.done = true; t.at = nowMs; t.by = "user";
        if (t.kind === "promise") t.status = "completed";
        dropped = dropThreadItems(deps, c, t.id, "你把这件事了结了", nowMs);
        note = `了结「${t.text}」`;
      } else if (op === "undone") {
        t.done = false; t.at = nowMs; t.since = nowMs; t.by = "user";
        if (t.kind === "promise") { t.status = "pending"; t.revision = (Number(t.revision) || 1) + 1; t.nudge = ""; t.mentionedAt = 0; }
        // 过了点的约定 / 日子放回去会立刻判死，降成话头
        if (!threadAlive(t, nowMs, days)) { t.kind = "topic"; t.due = 0; t.yearly = false; note = `「${t.text}」的时间已经过了，放回去当话头挂着`; }
        else note = `放回「${t.text}」`;
      } else if (op === "drop") {
        dropped = dropThreadItems(deps, c, t.id, "你删掉了这条惦记", nowMs);
        if (t.kind === "promise") { t.done = true; t.status = "cancelled"; t.at = nowMs; }
        else list.splice(list.indexOf(t), 1);
        note = `删掉「${t.text}」`;
      } else throw new HttpError(400, "op 只能是 add / done / undone / drop");
    }
    c.state.threads = list;
    store.saveCharacter(c);
    store.addDecision(id, "ledger", "你在挂念里" + note + (dropped ? `，撤掉 ${dropped} 个念头` : ""), deps.runner.mode, null, nowMs);
    void tz;
    return { threads: list, note, dropped };
  }, halts);
}

export async function cancelItem(deps: AppDeps, id: string, body: Record<string, unknown>) {
  return deps.runner.exclusive(() => {
    const { store } = deps;
    const c = mustCharacter(store, id);
    const nowMs = deps.engine.now();
    const wakeId = String(body.wakeId || "");
    for (const row of store.listDays(c.characterId, 40)) {
      const item = row.items.find(i => i.wakeId === wakeId);
      if (!item) continue;
      if (item.generatedAt) throw new HttpError(409, "这条已经发出去了");
      const timer = store.getTimer(wakeId);
      if (timer?.status === "running") throw new HttpError(409, "这条正在生成，撤不了");
      if (!item.act) return { cancelled: false };
      if (timer && timer.status === "pending") store.updateTimer(wakeId, { status: "cancelled", note: "你手动撤掉了" });
      item.act = false; item.why = "你手动撤掉了";
      store.saveDay(row);
      store.addDecision(id, "recheck", `取消 ${item.time}——你手动撤掉了`, deps.runner.mode, { wakeId }, nowMs);
      return { cancelled: true };
    }
    throw new HttpError(404, "找不到这个念头");
  }, body.wakeId ? ["wake:" + String(body.wakeId)] : []);
}

export async function ackMoment(deps: AppDeps, id: string, body: Record<string, unknown>) {
  return deps.runner.exclusive(() => {
    const { store } = deps;
    const c = mustCharacter(store, id);
    const nowMs = deps.engine.now();
    const postKey = String(body.id || "");
    const status = ["sent", "skipped", "failed", "pending"].includes(String(body.status)) ? String(body.status) : "failed";
    const outbox = Array.isArray(c.state.outbox) ? c.state.outbox : [];
    const o = outbox.find(x => x.id === postKey);
    const history = (Array.isArray(c.state.momentHistory) ? c.state.momentHistory : []) as Record<string, unknown>[];
    const previous = history.find(h => h.id === postKey);
    if (previous && (previous.status === "sent" || previous.status === "skipped")) return { status: previous.status, duplicate: true };
    const tries = (Number(previous?.tries) || 0) + (status === "failed" ? 1 : 0);
    const record = {
      id: postKey, hint: String(o?.hint || previous?.hint || body.hint || "").slice(0, 120), by: "server",
      intendedAt: Number(o?.at || previous?.intendedAt) || 0, at: nowMs, status, tries,
      postId: String(body.postId || ""), note: String(body.note || "").slice(0, 200),
    };
    c.state.momentHistory = [...history.filter(h => h.id !== postKey), record].slice(-60);
    // 发了、跳过了，或者连着失败 3 次，就从待发里拿掉
    if (status === "sent" || status === "skipped" || tries >= 3) c.state.outbox = outbox.filter(x => x.id !== postKey);
    store.saveCharacter(c);
    if (status === "sent") store.addDecision(id, "post", `朋友圈发出去了：${record.hint}`, deps.runner.mode, null, nowMs);
    return { status, tries };
  });
}

export async function regenerate(deps: AppDeps, id: string) {
  if (deps.runner.mode !== "live") throw new HttpError(409, "影子模式不调模型，切到 live 才能生成");
  const c = mustCharacter(deps.store, id);
  const tz = tzOf(c);
  return deps.runner.exclusive(async () => ({ note: await generateDayNow(deps.engine, id, localDate(deps.engine.now(), tz)) }));
}

/** 路由；返回 undefined 表示不是 /app 的路径 */
export async function handleApp(deps: AppDeps, method: string, path: string, query: URLSearchParams, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown } | undefined> {
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "app") return undefined;
  const ok = (body: Record<string, unknown>) => ({ status: 200, body: { ok: true, ...body } });
  const change = async (p: Promise<Record<string, unknown>>, waitMs = WAIT_MS) => {
    p.catch(e => deps.engine.log(`[companion] ${method} ${path} 失败：${e instanceof Error ? e.message : String(e)}`));
    const r = await settle(p, waitMs);
    return r.done ? ok(r.value) : { status: 202, body: { ok: true, queued: true, message: "后端正在判断，改动排在这一轮之后" } };
  };
  if (method === "GET" && parts[1] === "state") return ok(appState(deps, ids(query)));
  if (method === "GET" && parts[1] === "host") return ok(appHost(deps, ids(query)));
  if (method === "GET" && parts[1] === "archive") return ok(appArchive(deps, String(query.get("id") || ""), Number(query.get("limit")) || 30));
  if (parts[1] === "wake") return appWake(deps, method, parts, query, readBody);
  if (parts[1] === "jobs") return appJobs(deps, method, parts, query, readBody);
  if (parts[1] === "weixin") return appWeixin(deps, method, parts, readBody);
  if (parts[1] !== "characters" || !parts[2]) return { status: 404, body: { ok: false, error: "not_found" } };
  const id = parts[2];
  const body = async () => { const b = await readBody(); return (b && typeof b === "object" ? b : {}) as Record<string, unknown>; };
  if (method === "POST" && parts[3] === "handoff") {
    const input = await body();
    return change(deps.runner.exclusive(async () => {
      const c = deps.store.getCharacter(id);
      if (c) { c.enabled = false; deps.store.saveCharacter(c); }
      deps.store.setMeta("handoff:" + id, "pending");
      await stopLegacyScheduler(deps.engine.rest, deps.engine.userId, id, String(input.owner || ""));
      if (!c) {
        await importFromCloud(deps.engine.rest, deps.store, deps.engine.userId, { characterId: id });
        const imported = deps.store.getCharacter(id);
        if (imported) { imported.enabled = false; deps.store.saveCharacter(imported); }
      }
      const migrated = await importMissingCloudTasks(deps.engine.rest, deps.store, deps.engine.userId, id, deps.engine.now());
      if (migrated.skipped?.length) deps.store.addDecision(id, "setup", `交接：${migrated.skipped.length} 条旧约定找不到对应账本，没有迁入`, deps.runner.mode, { wakeIds: migrated.skipped }, deps.engine.now());
      await importPendingCloudFeedback(deps.engine.rest, deps.store, deps.engine.userId, id, deps.engine.now());
      deps.store.setMeta("handoff-tasks:" + id, "done");
      deps.store.setMeta("handoff:" + id, "done");
      return { stopped: true, migrated };
    }, ["char:" + id]));
  }
  if (method === "POST" && parts.length === 3) return change(upsertCharacter(deps, id, await body()));
  if (method === "PUT" && parts[3] === "settings") return change(saveSettings(deps, id, await body()));
  if (method === "PUT" && parts[3] === "inputs") return change(saveInputs(deps, id, await body()));
  if (method === "PUT" && parts[3] === "day") return change(saveDaySchedule(deps, id, await body()));
  if (method === "POST" && parts[3] === "threads") return change(editThreads(deps, id, await body()));
  if (method === "POST" && parts[3] === "items" && parts[4] === "cancel") return change(cancelItem(deps, id, await body()));
  if (method === "POST" && parts[3] === "moments" && parts[4] === "ack") return change(ackMoment(deps, id, await body()));
  if (method === "POST" && parts[3] === "regenerate") return change(regenerate(deps, id), 170_000);
  if (method === "POST" && parts[3] === "tick") {
    mustCharacter(deps.store, id);
    const traces = await deps.runner.tick(id);
    if (!traces.length) return { status: 409, body: { ok: false, error: "后端正在跑一轮，稍后再试" } };
    return ok({ trace: traces[0] });
  }
  return { status: 404, body: { ok: false, error: "not_found" } };
}

async function appWeixin(deps: AppDeps, method: string, parts: string[], readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const weixin = deps.weixin;
  if (!weixin) return { status: 404, body: { ok: false, error: "后端没开微信助手" } };
  if (method === "GET" && parts.length === 2) return { status: 200, body: { ok: true, enabled: weixin.enabled(), heartbeat: weixin.heartbeat() } };
  if (method === "POST" && parts.length === 2) {
    const body = await readBody() as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") return { status: 400, body: { ok: false, error: "缺少 enabled" } };
    weixin.setEnabled(body.enabled);
    return { status: 200, body: { ok: true, enabled: weixin.enabled(), heartbeat: weixin.heartbeat() } };
  }
  if (method === "POST" && parts[2] === "run") return { status: 200, body: { ok: true, enabled: weixin.enabled(), heartbeat: await weixin.tick(true) } };
  return { status: 404, body: { ok: false, error: "not_found" } };
}

// ─── 唤醒后端

async function appJobs(deps: AppDeps, method: string, parts: string[], query: URLSearchParams, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const { store } = deps;
  const nowMs = deps.engine.now();
  const input = async () => { const b = await readBody(); return (b && typeof b === "object" ? b : {}) as Record<string, unknown>; };
  const key = (v: unknown) => typeof v === "string" ? v.trim().slice(0, 200) : "";
  if (method === "GET" && parts.length === 2) {
    const jobs = store.listJobs(Math.min(100, Number(query.get("limit")) || 30)).map(j => ({
      triggerKey: j.triggerKey, kind: j.kind, executeAt: new Date(j.executeAt).toISOString(), status: j.status, note: j.note, tries: j.tries,
      updatedAt: new Date(j.updatedAt).toISOString(), sessionId: j.payload?.merge?.sessionId || "", characterName: j.payload?.notify?.title || "",
    }));
    return { status: 200, body: { ok: true, jobs } };
  }
  if (method !== "POST") return { status: 404, body: { ok: false, error: "not_found" } };
  const body = await input();
  if (parts.length === 2) {
    const error = validateJob(body);
    if (error) return { status: error === "快照过大" ? 413 : 400, body: { ok: false, error } };
    const saved = store.putJob({ id: `job_${crypto.randomUUID()}`, triggerKey: key(body.triggerKey), kind: String(body.kind),
      executeAt: Date.parse(String(body.executeAt)), payload: body.payload as Record<string, any>, createdAt: nowMs }, nowMs);
    return saved ? { status: 200, body: { ok: true } } : { status: 409, body: { ok: false, running: true, error: "同名任务正在生成" } };
  }
  if (parts[2] === "deferred") {
    // 忙碌回复：{ action: "get" | "put" | "cancel", key, payload }，回执格式同个人云网关 deferred-reply
    const action = String(body.action || "get"), deferredKey = key(body.key);
    if (!deferredKey && action === "get") return { status: 200, body: { ok: true, supported: true, policySupported: true, silenceSupported: true } };
    if (!DEFERRED_KEY.test(deferredKey)) return { status: 400, body: { ok: false, error: "Invalid deferred key" } };
    if (action === "get") return { status: 200, body: deferredReceipt(store.getJob(deferredKey)) };
    if (action === "cancel") return { status: 200, body: deferredReceipt(store.cancelDeferredJob(deferredKey, nowMs)) };
    if (action === "put") return putDeferred(store, deferredKey, body.payload as JobPayload, nowMs);
    return { status: 400, body: { ok: false, error: "action 无效" } };
  }
  if (parts[2] === "cancel") {
    const triggerKey = key(body.triggerKey), triggerPrefix = key(body.triggerPrefix);
    if (!triggerKey && !triggerPrefix) return { status: 400, body: { ok: false, error: "缺少预约键" } };
    return { status: 200, body: { ok: true, ...store.cancelJobs({ triggerKey, triggerPrefix, excludeKey: key(body.excludeKey) }, nowMs) } };
  }
  if (parts[2] === "delay") {
    const triggerKey = key(body.triggerKey);
    if (!triggerKey) return { status: 400, body: { ok: false, error: "缺少 triggerKey" } };
    return { status: 200, body: { ok: true, delayed: store.delayJob(triggerKey, nowMs + (body.runNow === true ? 0 : 90_000), nowMs) } };
  }
  return { status: 404, body: { ok: false, error: "not_found" } };
}

async function appWake(deps: AppDeps, method: string, parts: string[], query: URLSearchParams, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const sourceId = parts[3] || "";
  if (method === "PUT" && parts[2] === "templates" && sourceId && parts.length === 4) {
    const body = await readBody() as WakeTemplate;
    if (body && typeof body === "object" && body.sourceId !== sourceId) return { status: 400, body: { ok: false, error: "sourceId 与地址不一致" } };
    const error = validateWakeTemplate(body);
    if (error) return { status: 400, body: { ok: false, error } };
    const old = deps.store.getWakeTemplate(sourceId);
    if (old && old.capturedAt > body.capturedAt) return { status: 200, body: { ok: true, kept: true } };
    deps.store.saveWakeTemplate(body);
    return { status: 200, body: { ok: true } };
  }
  if (method === "POST" && parts[2] === "templates" && sourceId && parts[4] === "delete") {
    return { status: 200, body: { ok: true, deleted: deps.store.deleteWakeTemplate(sourceId) } };
  }
  if (method === "GET" && parts[2] === "status") {
    const source = String(query.get("source") || "");
    const templates = deps.store.listWakeTemplates().filter(r => !source || r.template.sourceId === source).map(({ template: t, receivedAt }) => ({
      sourceId: t.sourceId, characterId: t.characterId, characterName: String(t.merge.characterName || ""), capturedAt: t.capturedAt, receivedAt,
      protocol: t.protocol, mcpUrl: t.mcp?.url || "", tools: Object.values(t.toolNames).length || Object.keys(t.schemaText).length,
    }));
    const w = deps.wake;
    return {
      status: 200,
      body: {
        ok: true, templates,
        gateway: w ? { lastPollAt: w.lastPollAt, error: w.lastError, sources: w.sources.filter(s => !source || s.serverId === source) } : null,
        runs: deps.store.listWakeRuns(Math.min(100, Number(query.get("limit")) || 30), source),
      },
    };
  }
  return { status: 404, body: { ok: false, error: "not_found" } };
}
