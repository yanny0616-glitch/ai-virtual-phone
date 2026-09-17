// 挂念的大脑：每分钟给每个角色跑一轮。
//   1. 生活面：今天还没有就到点生成（影子模式读云端已生成的那份）
//   2. 不调模型的账：朋友圈骰子、回音账、约定定时器
//   3. 门禁 → 由头 → 分量；拦下的原因只在变化时记一条
//   4. 判断：调模型（影子模式只记「这会儿会去判」）→ 改念头、记账本、挂定时器
//   5. 到点的定时器：发送前复核 → 生成 → 写 push_outbox → Web Push
// 规则与文案逐段搬自 push-recheck / push-generate，删掉了模板借用、预约、乐观锁、租约这些云函数专属的东西。

import { acquireGenerationLease, GenerationBusy, type GenerationLease } from "./generation-lease.ts";
import type { GeneratedDraft } from "./store.ts";
import { importPendingCloudFeedback } from "./importer.ts";
import { applyChatState } from "./chat-state.ts";
import {
  CALL_INVITE_WINDOW_MS, createShortcutCommand, deliverShortcutCommand, extractCall, extractShortcut, extractWeixin, fillCallInvite,
  replaceMarker, sendWeixin, SHORTCUT_VISION_OFF_NOTE, writeShortcutDiagnostic, type CloudCtx,
} from "./delivery.ts";
import type { Cloud } from "./supabase.ts";
import { randomUUID } from "node:crypto";

import { matterBlock, matterFields, matterKey, matterPrompt, prepareMatters } from "./vendor/matters.mjs";
import { ordinaryQuota, promiseIntent, promiseNeedsTask, recheckEvidence } from "./vendor/promises.mjs";
import { buildDayInstruction, parseDayResult, recentDaysBrief, type FixedItem, type Routine } from "./day.ts";
import { routineFor } from "./routine.ts";
import { historyText, lastProactiveAt, outputSentAt, readHistory, unansweredRounds, type CloudHistory, type CloudOutput } from "./history.ts";
import {
  busyUntil, forkDay, guanianAsleep, guanianNow, hhmm, hmMins, inWindow, localDate, nextLocalHM, roll, stateNote, waitingChance,
} from "./life.ts";
import {
  buildChatRequest, buildTaskRequest, callModel, generateJson, parseModelJson, splitPreview, usageAdd, usageBudget, usageExceeded,
  visibleResponse, type ModelFetch,
} from "./llm.ts";
import type { PushMessage, PushResult } from "./push.ts";
import {
  buildJudgePrompt, cnum, feedbackWindowEnd, fbMod, gate, impulseValue, LEAD_MS, lifeRoll, momentsBudget, parseJudgeJson,
  SELF_KIND, valueFloor,
} from "./rules.ts";
import type { CharacterRow, DayRow, Snapshot, Store, TimerRow } from "./store.ts";
import type { Rest } from "./supabase.ts";
import {
  applyThreads, liveThreads, settleByWords, shortThreadLines, threadDueMs, threadLines, threadNudge, threadsEnabled, type WordSettle,
} from "./threads.ts";
import { similarBlock, similarPromise } from "./similar.ts";
import { fillChatTemplate } from "./templates.ts";
import { STATE_KEYS, type Ctx, type GuanianDay, type PlanItem, type Thread } from "./types.ts";

export type Mode = "shadow" | "live";

export type EngineDeps = {
  store: Store;
  rest: Rest;
  userId: string;
  fetchModel: ModelFetch;
  push: (messages: PushMessage[]) => Promise<PushResult>;
  now: () => number;
  random: () => number;
  log: (line: string) => void;
  /** 手机发来的撤销 / 停用还在锁外排队：到发送边界先看一眼（Runner 提供） */
  halted?: (characterId: string, wakeId: string) => boolean;
  /** 个人云 functions / storage / realtime（快捷动作、微信、安卓壳通知）与管理员密钥；测试可不给 */
  cloud?: Cloud;
  cloudKey?: string;
};

export type Trace = { characterId: string; at: number; mode: Mode; steps: string[]; error?: string };

const HOUR = 3600_000;

type Turn = {
  deps: EngineDeps; mode: Mode; c: CharacterRow; ctx: Ctx; tz: number; nowMs: number; date: string;
  row: DayRow; steps: string[];
};

function emptyDay(characterId: string, date: string): DayRow {
  return {
    characterId, date, day: null, items: [], selfUsed: 0, recheckCount: 0, judgedAt: 0, judgedChatAt: 0,
    genTries: 0, genError: "", genLog: [], source: "", updatedAt: 0,
  };
}

export function characterTz(c: CharacterRow): number | null {
  const n = Number(c.settings.tzOffsetMin);
  return c.settings.tzOffsetMin != null && Number.isInteger(n) && n >= -840 && n <= 840 ? n : null;
}

function buildCtx(c: CharacterRow, row: DayRow, tz: number): Ctx {
  const ctx: Ctx = { ...c.settings, ...c.state, tzOffsetMin: tz, day: row.day ? { ...row.day, tz } : null, selfUsed: row.selfUsed };
  // 账本开着但还没有数组（新建角色、关过又打开）：从空账本开始记
  if (threadsEnabled(ctx) && !Array.isArray(ctx.threads)) ctx.threads = [];
  return ctx;
}

function saveTurn(t: Turn): void {
  for (const key of STATE_KEYS) {
    if (t.ctx[key] === undefined) delete t.c.state[key];
    else (t.c.state as Record<string, unknown>)[key] = t.ctx[key];
  }
  t.row.selfUsed = Number(t.ctx.selfUsed) || 0;
  t.deps.store.saveCharacter(t.c);
  t.deps.store.saveDay(t.row);
}

function decide(t: Turn, kind: string, note: string, data: Record<string, unknown> | null = null): void {
  t.deps.store.addDecision(t.c.characterId, kind, note, t.mode, data, t.deps.now());
  t.steps.push(`${kind}: ${note}`);
}

/** 近 40 天所有念头（约定定时器可能挂在前几天的行里） */
function recentRows(t: Turn): DayRow[] {
  return t.deps.store.listDays(t.c.characterId, 40).map(r => r.date === t.row.date ? t.row : r);
}

function findItem(t: Turn, wakeId: string): { row: DayRow; item: PlanItem } | null {
  for (const r of recentRows(t)) {
    const item = r.items.find(i => i.wakeId === wakeId);
    if (item) return { row: r, item };
  }
  return null;
}

function snapshotFor(t: Turn, purpose: "chat" | "judge" | "daily"): Snapshot | null {
  return t.deps.store.getSnapshot(t.c.characterId, purpose) || (purpose === "chat" ? null : t.deps.store.getSnapshot(t.c.characterId, "chat"));
}

export async function tickCharacter(deps: EngineDeps, mode: Mode, characterId: string): Promise<Trace> {
  const nowMs = deps.now();
  const trace: Trace = { characterId, at: nowMs, mode, steps: [] };
  const c = deps.store.getCharacter(characterId);
  if (!c) { trace.error = "没有这个角色"; return trace; }
  if (!c.enabled || Number(c.settings.recheckEnabled) === 0) { trace.steps.push("挂念对这个角色关着"); return trace; }
  if (deps.halted?.(characterId, "")) { trace.steps.push("停用正在排队，这轮不跑"); return trace; }
  const tz = characterTz(c);
  if (tz === null) { trace.error = "时区缺失"; return trace; }
  const date = localDate(nowMs, tz);
  const row = deps.store.getDay(characterId, date) || emptyDay(characterId, date);
  const t: Turn = { deps, mode, c, ctx: buildCtx(c, row, tz), tz, nowMs, date, row, steps: trace.steps };
  try {
    if (mode === "live" && deps.store.getMeta("handoff:" + characterId) === "done") {
      // 补迁旧回音账失败只少学一次，不能拖停这一轮的判断和发送；没标完成，下轮再试
      try { await importPendingCloudFeedback(deps.rest, deps.store, deps.userId, characterId, nowMs); }
      catch (e) { trace.steps.push("回音账补迁失败，下轮再试：" + errText(e)); }
    }
    await ensureDay(t);
    t.ctx.day = t.row.day ? { ...t.row.day, tz } : null;
    let history: CloudHistory;
    try { history = await readHistory(deps.rest, deps.userId, c.sessionId, t.ctx); }
    catch (e) { trace.error = "聊天历史读取失败：" + errText(e); saveTurn(t); return trace; }
    markGenerated(t, history);
    moments(t);
    await feedback(t);
    reconcilePromises(t);
    await judgeTurn(t, history);
    saveTurn(t);
    for (const timer of deps.store.dueTimers(deps.now(), characterId)) {
      try { await fireTimer(t, timer, history); }
      catch (e) {
        const tries = (Number(/tries:(\d+)/.exec(timer.note)?.[1]) || 0) + 1;
        const note = `tries:${tries} ${errText(e)}`;
        if (tries >= 3) deps.store.updateTimer(timer.id, { status: "failed", note });
        else deps.store.updateTimer(timer.id, { status: "pending", fireAt: deps.now() + 5 * 60_000, note });
        decide(t, "error", `到点发送失败（第 ${tries} 次）：${errText(e)}`, { wakeId: timer.id });
      }
      saveTurn(t);
    }
  } catch (e) {
    trace.error = errText(e);
    deps.log(`[companion] ${characterId} 这一轮失败：${trace.error}`);
    saveTurn(t);
  }
  return trace;
}

const SENTINEL_INTENT = "挂念后台复核模板，仅供后台调用，不生成聊天消息";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

// ─── 1. 生活面
const shadowRefreshAt = new Map<string, number>();
async function ensureDay(t: Turn): Promise<void> {
  const { deps, c, row } = t;
  if (t.mode === "shadow") {
    // 影子模式不调模型：拿云端这一天已经生成好的，保证和云端比的是同一份输入
    if (row.day && !row.source.startsWith("cloud")) return;
    const key = c.characterId + "|" + t.date;
    if (row.day && t.nowMs - (shadowRefreshAt.get(key) || 0) < 10 * 60_000) return;
    shadowRefreshAt.set(key, t.nowMs);
    const res = await deps.rest(`push_recheck_plans?user_id=eq.${encodeURIComponent(deps.userId)}&character_id=eq.${encodeURIComponent(c.characterId)}`
      + `&plan_date=eq.${t.date}&select=context->day,context->dayFull&limit=1`);
    if (!res.ok) return;
    const [plan] = await res.json() as { day?: GuanianDay | null; dayFull?: GuanianDay | null }[];
    const day = plan?.day ? { ...(plan.dayFull || {}), ...plan.day, tz: t.tz } : null;
    if (day && JSON.stringify(day) !== JSON.stringify(row.day)) {
      row.day = day;
      row.source = "cloud-shadow";
      t.steps.push("影子模式：读入云端今天的生活面");
    }
    return;
  }
  if (row.day) return;
  if (Number(c.settings.genEnabled) === 0) { t.steps.push("自动生成关着"); return; }
  const at = String(c.settings.autoGenAt || "07:30");
  if (hhmm(t.nowMs, t.tz) < at) return;
  if (row.genTries >= 3) return;
  if (row.genError && t.nowMs - (row.genAt || 0) < 10 * 60_000) return;
  const over = usageExceeded(await usageBudget(deps.rest, deps.userId, t.nowMs));
  if (over) { t.steps.push("生成一天：" + over); return; }
  await generateDay(t);
}

export async function generateDay(t: Turn): Promise<void> {
  const { deps, c, row } = t;
  const log = (line: string) => { row.genLog.push(line); };
  row.genTries += 1;
  row.genAt = deps.now();
  row.genLog = [];
  const snap = snapshotFor(t, "daily");
  if (!snap) {
    row.genError = "没有提示词快照，生成不了（打开一次 Float 聊天让手机寄一份）";
    decide(t, "gen", row.genError);
    deps.store.saveDay(row);
    return;
  }
  try {
    const cal = fixedFor(t, t.date);
    // 生成模板里只有一条任务占位，没有聊天：补上最新聊天，说定的安排、刚取消的事才进得了日程
    const history = await readHistory(deps.rest, deps.userId, c.sessionId, t.ctx);
    const chat = historyText(history, t.tz, 60, t.ctx);
    const past = recentDaysBrief(deps.store.listDays(c.characterId, 10).filter(r => r.day).map(r => ({ date: r.date, day: r.day!, characterId: c.characterId })), t.date);
    const instruction = buildDayInstruction({
      date: t.date, nowHM: hhmm(t.nowMs, t.tz), dayPrompt: c.settings.dayPrompt, forkLevel: c.settings.forkLevel,
      past, existing: cal.items, threads: threadsEnabled(t.ctx) ? threadLines(t.ctx, t.nowMs, t.tz) : [], routine: cal.routine,
    });
    const budget = await usageBudget(deps.rest, deps.userId, t.nowMs);
    const facts = chat ? `\n[最新云端聊天事实，非用户消息；当前当地时间 ${new Date(t.nowMs + t.tz * 60_000).toISOString().slice(0, 16)}。说定的安排、取消的事以这里为准]\n${chat}` : "";
    const raw = await generateJson(snap.request, instruction + facts, deps.fetchModel,
      (kind, data) => usageAdd(deps.rest, deps.userId, budget.tz, "cloud-gen", kind, data), log);
    const full = parseDayResult(raw, cal.items, c.settings, t.nowMs);
    if (cal.routine.wake) full.wake = cal.routine.wake;
    if (cal.routine.bed) full.bed = cal.routine.bed;
    row.day = { ...full, tz: t.tz, forkSeed: t.date + "|" + c.characterId, forkBurst: Number(c.settings.forkBurst) === 0 ? 0 : 1 };
    row.genError = "";
    row.source = "server";
    decide(t, "gen", `生成今日生活面：${full.schedule.length} 条日程，作息 ${full.wake} 起 ${full.bed} 睡，心情「${full.mood}」`
      + (full.sleep ? "，昨晚" + full.sleep : "") + (full.conds.length ? "，身上：" + full.conds.map(x => x.cause).join("、") : "")
      + (full.forks.length ? `，埋了 ${full.forks.length} 个岔子` : ""));
  } catch (e) {
    row.genError = errText(e);
    decide(t, "gen", `生成失败（第 ${row.genTries} 次）：${row.genError}`);
  }
  deps.store.saveDay(row);
}

/** 那天的已定安排：宿主寄来的（今明两天）优先；更远的日子用存下的固定作息原件自己展开 */
function fixedFor(t: Turn, date: string): { items: FixedItem[]; routine: Routine } {
  const cal = t.deps.store.getCalendar(t.c.characterId, date);
  if (cal) return cal;
  const raw = t.deps.store.getRoutine(t.c.characterId);
  if (!raw?.routineOn) return { items: [], routine: {} };
  const r = routineFor(raw.routine, raw.exceptions, date, t.tz, t.nowMs);
  return { items: r.items, routine: { ...(r.wake ? { wake: r.wake } : {}), ...(r.bed ? { bed: r.bed } : {}) } };
}

/** 今天还没生成（零点到自动生成之间）：按昨天的作息判断睡没睡、忙不忙，和 App 的 nightBridge 一个意思 */
function bridgeDay(t: Turn): GuanianDay {
  const [y, m, d] = t.date.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const yesterday = t.deps.store.getDay(t.c.characterId, prev)?.day;
  const fixed = fixedFor(t, prev).routine;
  return {
    tz: t.tz, schedule: [], conds: yesterday?.conds || [], mood: yesterday?.mood || "",
    wake: yesterday?.wake || fixed.wake || "", bed: yesterday?.bed || fixed.bed || "",
  } as GuanianDay;
}

// 发出去的消息回写念头和账本（话头了结、约定标提过了）
function markGenerated(t: Turn, history: CloudHistory): void {
  const rows = recentRows(t);
  for (const o of history.outputs) {
    if (!o.trigger_key?.startsWith("timedwake:")) continue;
    const at = Date.parse(o.created_at);
    for (const r of rows) {
      const w = r.items.find(w => o.trigger_key === "timedwake:" + w.wakeId);
      if (!w || !Number.isFinite(at) || w.generatedAt === at) continue;
      w.generatedAt = at;
      const th = (t.ctx.threads || []).find(x => x.id === w.from);
      if (th && !th.done && (th.kind !== "promise" || Number(th.revision || 1) === Number(w.promiseRevision || 1))) {
        th.mentionedAt = at; th.at = at;
        if (th.kind === "topic") th.done = true;
        else th.nudge = (String(th.nudge || "") + " said:" + w.time).trim().slice(-200);
      }
      if (r !== t.row) t.deps.store.saveDay(r);
    }
  }
}

// ─── 2. 不调模型的账
function moments(t: Turn): void {
  const life = lifeRoll(t.ctx, t.nowMs, t.deps.random);
  if (!life) return;
  Object.assign(t.ctx, life.patch);
  if (life.post) decide(t, "post", `想发条朋友圈——${life.post.hint}`, { roll: life.note });
}

// 回音账：发出后有效 3 小时内用户接没接话，只做正反馈；凭据是后端自己的发送记录
async function feedback(t: Turn): Promise<void> {
  const { deps, c } = t;
  const fb: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(t.ctx.fb || {})) if (Array.isArray(v)) fb[k] = [Number(v[0]) || 0, Number(v[1]) || 0];
  let changed = false;
  for (const send of deps.store.pendingFeedback(c.characterId).slice(0, 6)) {
    const windowEnd = feedbackWindowEnd(send.sentAt, t.ctx, t.nowMs);
    if (windowEnd === null) continue;
    const res = await deps.rest(`push_chat_mirror?user_id=eq.${encodeURIComponent(deps.userId)}&character_id=eq.${encodeURIComponent(c.characterId)}`
      + `&role=eq.user&message_at=gt.${encodeURIComponent(new Date(send.sentAt).toISOString())}`
      + `&message_at=lte.${encodeURIComponent(new Date(windowEnd).toISOString())}&select=message_at&limit=1`);
    if (!res.ok) continue; // 读不到不等于没回，下一轮再看
    const replied = (await res.json() as unknown[]).length > 0;
    const rec = fb[send.kind] || [0, 0];
    fb[send.kind] = [rec[0] + 1, rec[1] + (replied ? 1 : 0)];
    changed = true;
    if (t.mode === "live") Object.assign(fb, deps.store.settleFeedback(send.wakeId, c.characterId, send.kind, replied));
    t.steps.push(`回音账：${send.kind} ${replied ? "接话了" : "没接话"}`);
  }
  if (changed && t.mode === "live") t.ctx.fb = fb;
}

// 约定：明确说定的事到点核对，独立定时器，不占普通额度；改期 / 了结就撤掉旧的
function reconcilePromises(t: Turn): void {
  const { deps, c } = t;
  const threads = Array.isArray(t.ctx.threads) ? t.ctx.threads : [];
  const rows = recentRows(t);
  for (const r of rows) {
    let dirty = false;
    for (const item of r.items) {
      if (item.kind !== "promise" || !item.act || item.generatedAt) continue;
      const timer = deps.store.getTimer(item.wakeId);
      if (!timer || timer.status !== "pending") continue;
      const th = threads.find(x => x.id === item.from);
      const stale = !th || th.done || th.status === "completed" || th.status === "cancelled"
        || Number(th.revision || 1) !== Number(item.promiseRevision || 1);
      if (!stale) continue;
      item.act = false; item.why = "约定已改期或了结"; dirty = true;
      deps.store.updateTimer(timer.id, { status: "cancelled", note: item.why });
      decide(t, "promise", `撤掉约定「${th?.text || item.source}」——${item.why}`, { wakeId: item.wakeId });
    }
    if (dirty && r !== t.row) deps.store.saveDay(r);
  }
  if (!threadsEnabled(t.ctx)) return; // 账本关着：已挂的照旧核对，不再挂新约定
  const allItems = rows.flatMap(r => r.items);
  const end = t.nowMs + 31 * 86_400_000;
  for (const th of threads.filter(x => promiseNeedsTask(x, allItems, t.nowMs, end))) {
    const due = Number(th.due);
    const fireAt = Math.max(due, t.nowMs + 15_000);
    const localDue = new Date(due + t.tz * 60_000).toISOString().slice(0, 16);
    const intent = promiseIntent(th, localDue) as string;
    const wakeId = `srv_promise_${th.id}_${Number(th.revision) || 1}`;
    const item: PlanItem = {
      ...matterFields(th), matterId: th.matterId || "thread:" + th.id, time: hhmm(fireAt, t.tz), fireAt, origFireAt: due,
      kind: "promise", from: th.id, promiseRevision: Number(th.revision) || 1, source: "约定·" + th.text,
      intent, why: th.why || "按明确约定到点核对", act: true, sem: "约定", topic: "", wakeId,
    };
    t.row.items.push(item);
    deps.store.addTimer({ id: wakeId, characterId: c.characterId, date: t.date, fireAt, kind: "promise", status: "pending", note: "" });
    decide(t, "promise", `挂上约定「${th.text}」，${localDue.replace("T", " ")} 到点核对`, { wakeId });
  }
}

// ─── 3–4. 门禁、由头、判断
type GateResult = {
  blocked: string; selfKind: string; selfReason: string; selfCurve: number;
  threadNudged: { id: string; mark: string; reason: string } | null; echoRows: { role: string; content: string; message_at: string }[];
  marks: Partial<Ctx>; wordSettled: WordSettle[];
};

async function gates(t: Turn, history: CloudHistory, evidence: any, canJudge: boolean, canImpulse: boolean, pending: PlanItem[], litCount: number): Promise<GateResult> {
  const { deps, ctx, row, nowMs, c } = t;
  const r: GateResult = { blocked: "", selfKind: "", selfReason: "", selfCurve: 1, threadNudged: null, echoRows: [], marks: {}, wordSettled: [] };
  const lastJudge = row.judgedAt || NaN;
  const promiseUpdate = evidence.promiseUpdate as boolean;
  const block = (why: string): GateResult => { r.blocked = why; return r; };

  if (Number.isFinite(lastJudge) && nowMs - lastJudge < (promiseUpdate ? Math.min(1, gate(ctx, "gateGapMin")) : gate(ctx, "gateGapMin")) * 60_000) return block("离上次判断还不够久");
  const over = usageExceeded(await usageBudget(deps.rest, deps.userId, nowMs));
  if (over) return block(over);
  if (row.recheckCount >= gate(ctx, "gateDailyCap")) return block("今天的判断次数用完了");
  if (!canJudge && !canImpulse && !promiseUpdate) {
    if (pending.length === 0) return block("今天没有还没到点的时刻，今日额度也满了");
    return block(`最近的时刻还在 ${Math.round((Math.min(...pending.map(i => i.fireAt)) - nowMs) / 60_000)} 分钟以外，今日额度也满了`);
  }
  // 没新消息就没有新信息；用户一句「好了 / 算了」直接了结账本
  const freshRows = evidence.updates as { role: string; content?: string; message_at: string }[];
  if (threadsEnabled(ctx) && Array.isArray(ctx.threads) && freshRows.length) {
    r.wordSettled = settleByWords(ctx.threads, freshRows.filter(m => m.role === "user").map(m => String(m.content || "")), nowMs);
  }
  if (!promiseUpdate && freshRows.length < Math.max(1, gate(ctx, "gateMinMsgs"))) {
    const quiet = "上次判断之后你没说几句";
    const day = ctx.day ? forkDay(ctx.day, nowMs, ctx.affection) : null;
    if (!canImpulse || !day || gate(ctx, "selfImpulseCap") <= 0) return block(quiet);
    if ((Number(ctx.selfUsed) || 0) >= gate(ctx, "selfImpulseCap")) return block(`${quiet}，今天的自发起念也用完了`);
    const qs = String(ctx.quietStart || ""), qe = String(ctx.quietEnd || "");
    const now = guanianNow(day, nowMs, qs, qe);
    if (inWindow(now.hm, qs, qe)) return block(`${quiet}，现在是免打扰时段`);
    if (now.asleep) return block(`${quiet}，TA在睡觉`);
    const silenceMs = Math.max(30, Number(ctx.selfSilenceMin ?? 180)) * 60_000;
    // 配速：允许用掉的额度 = 今天醒着的时间已过去的比例 × quota，至少 1 个
    const localNow = new Date(nowMs + t.tz * 60_000);
    const midnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - t.tz * 60_000;
    const hmMs = (hm: string) => /^\d{1,2}:\d{2}$/.test(hm) ? midnight + hmMins(hm.padStart(5, "0")) * 60_000 : 0;
    const dayStart = hmMs(String(day.wake || ctx.quietEnd || "07:00"));
    let dayEnd = hmMs(String(day.bed || ctx.quietStart || "23:00"));
    if (dayEnd <= dayStart) dayEnd += 86_400_000;
    if (dayEnd > dayStart) {
      const frac = Math.max(0, Math.min(1, (nowMs - dayStart) / (dayEnd - dayStart)));
      const allowed = Math.max(1, Math.ceil((ctx.quota ?? 3) * frac));
      if (litCount >= allowed) return block(`按今天的节奏，这会儿最多起 ${allowed} 个念头，已经有 ${litCount} 个了`);
    }
    // 由头：到日子了
    const nudge = threadNudge(ctx, nowMs, t.tz);
    if (nudge) {
      r.selfReason = nudge.reason; r.threadNudged = nudge; r.selfKind = "thread";
      const th = liveThreads(ctx, nowMs).find(x => x.id === nudge.id);
      const due = th ? threadDueMs(th, nowMs, t.tz) : 0;
      r.selfCurve = !due ? 1 : th?.kind === "date" ? (Math.abs(due - nowMs) <= 12 * HOUR ? 1 : 0.5)
        : due > nowMs ? 0.6 + 0.4 * (1 - Math.min(1, (due - nowMs) / (3 * HOUR))) : Math.max(0.3, 1 - (nowMs - due) / (3 * HOUR) * 0.7);
      return r;
    }
    // TA自己起的念头发出去没人回，一律不追
    const tail = [...history.messages].reverse();
    const lastAnyMs = Date.parse(tail[0]?.message_at || "");
    const lastUserMs = Date.parse(tail.find(m => m.role === "user")?.message_at || "");
    const lastMineMs = Date.parse(tail.find(m => m.role !== "user")?.message_at || "");
    const items = recentRows(t).slice(0, 2).flatMap(x => x.items);
    const hanging = Number.isFinite(lastMineMs) && (!Number.isFinite(lastUserMs) || lastMineMs > lastUserMs)
      && (!Number.isFinite(lastUserMs) || lastMineMs - lastUserMs > 30 * 60_000
        || items.some(it => it.act && it.fireAt <= nowMs && it.fireAt > lastUserMs));
    if (hanging) return block(`${quiet}，上一个念头发出去还没回音`);
    const daytime = now.hm >= "10:00" && now.hm < "21:30";
    const absentDays = Number.isFinite(lastUserMs) ? (nowMs - lastUserMs) / 86_400_000 : 0;
    // 由头：断了好几天。每段断联只掷一次骰子
    const missDays = Number(ctx.missDays ?? 3);
    if (missDays > 0 && daytime && absentDays >= missDays && absentDays <= 21 && Number(ctx.missKey) !== lastUserMs) {
      r.marks.missKey = lastUserMs;
      if (deps.random() < Math.min(0.9, 0.56 * fbMod(ctx.fb, "miss"))) {
        r.selfKind = "miss"; r.selfReason = `已经 ${Math.floor(absentDays)} 天没联系了`;
        r.selfCurve = Math.min(1, 0.5 + absentDays / 14 * 0.5);
        return r;
      }
    }
    // 由头：刚碰上的变数，憋不住想说
    const sameDayAsJudge = Number.isFinite(lastJudge) && localDate(lastJudge, t.tz) === t.date;
    const sinceHM = sameDayAsJudge ? guanianNow(day, lastJudge, qs, qe).hm : "00:00";
    const burst = Number(day.forkBurst) === 1
      ? (day.forks || []).filter((f: any) => f && f.state === "hit" && f.say === "burst" && !f.wakeAt && String(f.at) > sinceHM && String(f.at) <= now.hm).pop()
      : null;
    const burstMin = burst ? hmMins(now.hm) - hmMins(String(burst.at)) : 0;
    if (burst && burstMin <= 90) {
      r.selfKind = "fork"; r.selfReason = `刚碰上一件事：${burst.what}，憋不住想跟用户说`;
      r.selfCurve = Math.max(0.3, 1 - burstMin / 90);
      return r;
    }
    // 由头：上次判断之后新开始了一条日程
    if (now.done && String(now.done.time) > sinceHM) {
      r.selfReason = `刚${now.done.title || "做完一件事"}`; r.selfKind = "done";
      const endHM = String(now.done.end || now.done.time), m = /^(\d{1,2}):(\d{2})$/.exec(endHM);
      const sinceMin = m ? hmMins(now.hm) - (+m[1] * 60 + +m[2]) : 0;
      r.selfCurve = Math.max(0, 1 - Math.max(0, sinceMin) / 180);
      return r;
    }
    if (!Number.isFinite(lastAnyMs)) return block(quiet);
    // 由头：昨天的余韵。每天只掷一次
    const localDay = Math.floor((nowMs + t.tz * 60_000) / 86_400_000);
    if (Number(ctx.echoOn ?? 1) === 1 && daytime && absentDays <= 7 && Number(ctx.echoKey) !== localDay
      && (!Number.isFinite(lastMineMs) || nowMs - lastMineMs >= 8 * HOUR)) {
      const dayStartMs = localDay * 86_400_000 - t.tz * 60_000;
      const res = await deps.rest(`push_chat_mirror?user_id=eq.${encodeURIComponent(deps.userId)}&character_id=eq.${encodeURIComponent(c.characterId)}`
        + `&message_at=gte.${encodeURIComponent(new Date(dayStartMs - 86_400_000).toISOString())}`
        + `&message_at=lt.${encodeURIComponent(new Date(dayStartMs).toISOString())}`
        + "&or=(media_type.is.null,media_type.neq.response_batch)&select=role,content,message_at&order=message_at.desc&limit=40");
      const rows = res.ok ? (await res.json() as GateResult["echoRows"]).reverse() : [];
      const userSaid = rows.filter(m => m.role === "user").map(m => String(m.content || ""));
      const heavy = /低落|焦虑|难受|压力|紧张|失眠|疲惫|不舒服|担心|烦躁|委屈|害怕|心情不好|生病|发烧|吵架|分手/;
      if (userSaid.length >= 3 && !userSaid.some(v => heavy.test(v))) {
        r.marks.echoKey = localDay;
        if (deps.random() < Math.min(0.6, 0.24 * fbMod(ctx.fb, "echo"))) { r.echoRows = rows; r.selfKind = "echo"; r.selfReason = "忽然想起昨天聊过的一件小事"; return r; }
      }
    }
    // 由头：双方都安静太久。断到「想念」那么久之后交给上面的骰子
    if (missDays > 0 && absentDays >= missDays) return block(`${quiet}，断了 ${Math.floor(absentDays)} 天，这段只想念一次`);
    const silentMs = nowMs - lastAnyMs;
    if (silentMs >= silenceMs) {
      const mins = Math.round(silentMs / 60_000);
      r.selfKind = "quiet";
      r.selfReason = mins >= 120 ? `已经 ${Math.round(mins / 60)} 小时没联系` : `已经 ${mins} 分钟没联系`;
      return r;
    }
    return block(quiet);
  }
  const freshMs = gate(ctx, "gateFreshMin") * 60_000;
  const lastMsgMs = Date.parse(freshRows[freshRows.length - 1]?.message_at || "");
  if (!promiseUpdate && freshMs > 0 && Number.isFinite(lastMsgMs) && nowMs - lastMsgMs < freshMs) return block("你才刚说完，等一下再判");
  return r;
}

async function judgeTurn(t: Turn, history: CloudHistory): Promise<void> {
  const { deps, ctx, row, nowMs, c } = t;
  const threads = threadsEnabled(ctx) && Array.isArray(ctx.threads) ? ctx.threads : [];
  const evidence = recheckEvidence(history.messages, threads, row.judgedChatAt || nowMs - 6 * HOUR);
  const ledgerOnly = evidence.ledgerOnly as boolean;
  const items = row.items;
  const pending = items.filter(i => i.kind !== "promise" && i.fireAt > nowMs + LEAD_MS);
  const litCount = ordinaryQuota(items) as number;
  const horizon = gate(ctx, "gateHorizonMin") * 60_000;
  const nearest = pending.length ? Math.min(...pending.map(i => i.fireAt)) - nowMs : Infinity;
  const canJudge = !ledgerOnly && pending.length > 0 && (horizon <= 0 || nearest <= horizon);
  const canImpulse = !ledgerOnly && ctx.chatCandidates !== "不允许临时起念" && litCount < Number(ctx.quota ?? 3);

  const g = await gates(t, history, evidence, canJudge, canImpulse, pending, litCount);
  if (!g.blocked && g.selfKind) {
    const remaining = Number(ctx.quota ?? 3) - litCount;
    const value = impulseValue(g.selfKind, g.selfCurve, ctx.fb);
    if (value < valueFloor(remaining)) {
      g.blocked = `额度只剩 ${remaining} 个，「${SELF_KIND[g.selfKind] || g.selfKind}」这种由头分量不够（${value.toFixed(2)}）`;
      g.selfKind = ""; g.selfReason = ""; g.threadNudged = null;
    }
  }
  if (g.wordSettled.length) {
    const ids = new Set(g.wordSettled.map(w => w.id));
    for (const it of items) {
      if (!it.from || !ids.has(it.from) || !it.act || it.fireAt <= nowMs + LEAD_MS) continue;
      it.act = false; it.why = "这件事你说了结了";
      cancelTimer(t, it.wakeId, it.why);
      decide(t, "recheck", `取消 ${it.time}——${it.why}`, { wakeId: it.wakeId });
    }
    for (const w of g.wordSettled) decide(t, "settle", `你说「${w.said}」，${w.how}了「${w.text}」`);
  }
  Object.assign(ctx, g.marks);

  if (g.blocked) {
    const prev = deps.store.lastDecision(c.characterId, "gate");
    if (prev?.note !== g.blocked) decide(t, "gate", g.blocked);
    else t.steps.push("gate: " + g.blocked);
    return;
  }

  const judge = canJudge && !g.selfReason;
  const moBudget = momentsBudget(ctx, nowMs, t.tz);
  const canPost = !ledgerOnly && moBudget.ok;
  const threadsOn = threadsEnabled(ctx);
  const chatLines = historyText(history, t.tz, Number(ctx.judgeLines) >= 1 && Number(ctx.judgeLines) <= 60 ? Number(ctx.judgeLines) : 24, ctx);
  const snap = snapshotFor(t, "judge");
  const characterName = String(snap?.notify.title || c.name || "TA");
  const prompt = buildJudgePrompt({
    ctx, nowMs, tz: t.tz, characterName, items, outputs: history.outputs, pending, litCount, chatLines,
    threadLinesNow: threadsOn ? threadLines(ctx, nowMs, t.tz) : [],
    echoLines: g.selfKind === "echo" ? g.echoRows.map(m => `${m.role === "user" ? "用户" : characterName}（${hhmm(Date.parse(m.message_at), t.tz)}）：${String(m.content || "").slice(0, 160)}`).join("\n") : "",
    ledgerOnly, judge, canJudge, canImpulse, canPost, selfKind: g.selfKind, selfReason: g.selfReason, momentsWeekN: moBudget.weekN, hm: hhmm(nowMs, t.tz),
  });
  const chatAt = g.selfReason ? 0 : history.messages.reduce((at, m) => Math.max(at, Date.parse(m.message_at) || 0), 0);
  const what = g.selfReason ? `自发起念（${SELF_KIND[g.selfKind] || g.selfKind}：${g.selfReason}）` : judge ? "聊过之后重判今天的念头" : ledgerOnly ? "核对新承诺" : "看聊天里有没有新念头";
  row.recheckCount += 1;
  row.judgedAt = nowMs;
  if (g.selfReason) ctx.selfUsed = (Number(ctx.selfUsed) || 0) + 1;

  if (t.mode === "shadow") {
    row.judgedChatAt = Math.max(row.judgedChatAt, chatAt);
    decide(t, "judge", `影子：这会儿会去判——${what}`, { promptChars: prompt.length, canJudge, canImpulse, canPost, ledgerOnly, value: g.selfKind ? impulseValue(g.selfKind, g.selfCurve, ctx.fb) : null });
    return;
  }
  if (!snap) { decide(t, "judge", `想判（${what}）但没有提示词快照`); return; }
  saveTurn(t); // 先记下这次判断，模型慢也不会被下一轮重复发起

  const result = await callModel(buildTaskRequest(snap.request, "【后台判断任务：本轮仅按下面要求输出 JSON，不生成聊天回复、不调用工具】\n" + prompt), deps.fetchModel, 120_000);
  const budget = await usageBudget(deps.rest, deps.userId, nowMs);
  await usageAdd(deps.rest, deps.userId, budget.tz, "cloud-recheck", snap.request.providerKind, result.data);
  parseModelJson(result.text); // 无效 JSON 直接抛错，这轮算没判成
  row.judgedChatAt = Math.max(row.judgedChatAt, chatAt);
  applyJudgment(t, history, parseJudgeJson(result.text), { judge, canImpulse, canPost, g, ledgerOnly, litCount, moBudget, what });
}

function cancelTimer(t: Turn, wakeId: string, note: string): void {
  const timer = wakeId ? t.deps.store.getTimer(wakeId) : null;
  if (timer && timer.status === "pending") t.deps.store.updateTimer(wakeId, { status: "cancelled", note });
}

function addWake(t: Turn, fireAt: number, kind: string): string {
  const wakeId = `srv_${t.nowMs.toString(36)}_${randomUUID().slice(0, 6)}`;
  t.deps.store.addTimer({ id: wakeId, characterId: t.c.characterId, date: t.date, fireAt, kind, status: "pending", note: "" });
  return wakeId;
}

function applyJudgment(t: Turn, history: CloudHistory, judged: ReturnType<typeof parseJudgeJson>, o: {
  judge: boolean; canImpulse: boolean; canPost: boolean; g: GateResult; ledgerOnly: boolean; litCount: number; moBudget: ReturnType<typeof momentsBudget>; what: string;
}): void {
  const { ctx, row, nowMs, tz } = t;
  if (row.day && !o.g.selfReason && !o.ledgerOnly) {
    const at = t.deps.now();
    const applied = applyChatState(forkDay(row.day, at, ctx.affection), judged.feel, judged.sched,
      { nowMs: at, tz, date: t.date, chatEditsDay: ctx.chatEditsDay !== false });
    if (applied.notes.length) {
      row.day = applied.day; ctx.day = { ...applied.day, tz };
      for (const note of applied.notes) decide(t, note.kind, note.note);
    }
  }
  const threads = Array.isArray(ctx.threads) ? ctx.threads : [];
  const matters = prepareMatters(row.items, threads, history.outputs, judged, nowMs);
  judged.keep = matters.keep;
  judged.extra = matters.extra;
  const decisions = o.judge ? judged.decisions : [];
  const extra = o.canImpulse ? judged.extra : [];
  const threadsOn = threadsEnabled(ctx);
  let threadsNext: Thread[] | null = threadsOn && !o.g.selfReason
    ? applyThreads({ ...ctx, threads: matters.threads }, judged.keep, judged.settle, nowMs, tz, s => decide(t, "ledger", s), history.messages)
    : null;
  if (!threadsNext && JSON.stringify(matters.threads) !== JSON.stringify(threads)) threadsNext = matters.threads;
  if (o.g.threadNudged) {
    const base = threadsNext || threads.map(x => ({ ...x }));
    const th = base.find(x => x.id === o.g.threadNudged!.id);
    if (th) { th.nudge = (String(th.nudge || "") + " " + o.g.threadNudged.mark).trim().slice(-200); th.at = nowMs; threadsNext = base; }
  }
  if (threadsNext) ctx.threads = threadsNext;
  if (o.canPost && judged.post) {
    const post = { id: "mo" + nowMs.toString(36), at: nowMs, hint: judged.post, by: "server" };
    ctx.outbox = [...(Array.isArray(ctx.outbox) ? ctx.outbox : []).slice(-4), post];
    ctx.momentsLast = nowMs;
    ctx.momentsWeekStart = o.moBudget.weekStart;
    ctx.momentsWeekN = o.moBudget.weekN + 1;
    decide(t, "post", `想发条朋友圈——${post.hint}`);
  }

  const nextItems: PlanItem[] = matters.items;
  const matterThreads = threadsNext || matters.threads;
  for (const item of nextItems) {
    if (!item.act || item.generatedAt || history.outputs.some(x => x.trigger_key === "timedwake:" + item.wakeId)) continue;
    const reason = matterBlock(item, nextItems, matterThreads, history.outputs, history.messages);
    if (!reason) continue;
    item.act = false; item.matterSuppressed = true; item.why = reason;
    cancelTimer(t, item.wakeId, reason);
    decide(t, "dedupe", `${item.time} ${reason}`, { wakeId: item.wakeId });
  }
  let lit = ordinaryQuota(nextItems) as number;
  const quota = Number(ctx.quota ?? 3);
  const localMs = (hm: string): number => {
    const local = new Date(nowMs + tz * 60_000);
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - tz * 60_000 + hmMins(hm) * 60_000;
  };
  const day = ctx.day ? forkDay(ctx.day, nowMs, ctx.affection) : null;
  const inQuiet = (hm: string) => (day && guanianAsleep(day, hm, ctx.quietStart, ctx.quietEnd)) || inWindow(hm, ctx.quietStart, ctx.quietEnd);
  const gap = Number(ctx.minGapMin || 0) * 60_000;
  const lastPro = lastProactiveAt(history);
  const tooClose = (fireAt: number, self?: PlanItem) => !!gap && ((lastPro > 0 && Math.abs(fireAt - lastPro) < gap)
    || nextItems.some(other => other.kind !== "promise" && other.act && other !== self && Math.abs((other.generatedAt || other.fireAt) - fireAt) < gap));

  for (const d of decisions) {
    const time = typeof d.time === "string" ? d.time.trim() : "";
    const item = nextItems.find(i => i.kind !== "promise" && i.time === time && i.fireAt > nowMs + LEAD_MS);
    if (!item) continue;
    const why = String(d.why || "").slice(0, 200);
    if (d.act === false && item.act) {
      const deferHM = typeof d.defer === "string" && /^\d{1,2}:\d{2}$/.test(d.defer.trim()) ? d.defer.trim().padStart(5, "0") : "";
      const deferAt = deferHM ? localMs(deferHM) : 0;
      if (deferAt > nowMs + LEAD_MS && !inQuiet(deferHM)
        && !nextItems.some(other => other.kind !== "promise" && other !== item && other.time === deferHM) && !tooClose(deferAt, item)) {
        const from = item.time;
        item.origFireAt = Number(item.origFireAt) || item.fireAt;
        item.time = deferHM; item.fireAt = deferAt; item.why = why || "这个点不合适";
        t.deps.store.updateTimer(item.wakeId, { fireAt: deferAt, note: `改约 ${from}→${deferHM}` });
        decide(t, "defer", `${from} 改约到 ${deferHM}——${item.why}`, { wakeId: item.wakeId });
        continue;
      }
      item.act = false; item.why = why || "聊过之后TA改了主意";
      cancelTimer(t, item.wakeId, item.why);
      lit -= 1;
      decide(t, "recheck", `取消 ${time}——${item.why}`, { wakeId: item.wakeId });
      continue;
    }
    if (d.act === true && !item.act) {
      if (matterBlock(item, nextItems, matterThreads, history.outputs, history.messages)) continue;
      if (lit >= quota || inQuiet(item.time) || tooClose(item.fireAt, item)) continue;
      item.act = true;
      item.intent = String(d.intent || `刚${item.source}，想到用户`).slice(0, 200);
      item.why = why;
      item.sem = String(d.sem || item.sem).slice(0, 40);
      item.topic = String(d.topic || item.topic).slice(0, 200);
      item.wakeId = addWake(t, item.fireAt, item.kind || "plan");
      lit += 1;
      decide(t, "lit", `点亮 ${time}——${item.intent}`, { wakeId: item.wakeId });
    }
  }

  for (const one of extra.slice(0, 1)) {
    if (threads.some(x => x.kind === "promise" && x.id === String(one.from || "").replace(/[\[\]\s]/g, ""))) continue;
    if (lit >= quota) break;
    const raw = typeof one.time === "string" ? one.time.trim() : "";
    if (!/^\d{1,2}:\d{2}$/.test(raw)) continue;
    const time = raw.padStart(5, "0");
    if (inQuiet(time)) { decide(t, "extra", `${time} 落在免打扰或睡着的时段，不起`); continue; }
    const fireAt = localMs(time);
    if (fireAt <= nowMs + LEAD_MS) continue;
    if (nextItems.some(i => i.kind !== "promise" && i.time === time)) continue;
    if (tooClose(fireAt)) { decide(t, "extra", `${time} 离上一次主动太近，不起`); continue; }
    const candidate = { ...matterFields(one), kind: "extra", from: one.from || "", act: true, fireAt, intent: String(one.intent || one.about || "") };
    const duplicate = matterBlock(candidate, nextItems, matterThreads, history.outputs, history.messages);
    if (duplicate) { decide(t, "dedupe", `${time} ${duplicate}`); continue; }
    const intent = String(one.intent || one.about || "").slice(0, 200);
    if (!intent) continue;
    const same = similarBlock(intent, nextItems, matterThreads, history.messages);
    if (same) { decide(t, "dedupe", `${time} ${same}`); continue; }
    const kind = o.g.selfReason ? o.g.selfKind : "extra";
    const untilHM = typeof one.until === "string" && /^\d{1,2}:\d{2}$/.test(one.until.trim()) ? one.until.trim().padStart(5, "0") : "";
    const untilMs = untilHM ? localMs(untilHM) : 0;
    const fromId = String(one.from || "").replace(/[\[\]\s]/g, "");
    const wakeId = addWake(t, fireAt, kind);
    nextItems.push({
      ...matterFields(one), time, fireAt, until: untilMs > fireAt ? Math.min(untilMs, fireAt + 6 * HOUR) : 0,
      source: `${o.g.selfReason ? "自发" : "临时"}·${String(one.about || (o.g.selfReason ? (SELF_KIND[o.g.selfKind] || "想起你") : "未完话题")).slice(0, 10)}`,
      act: true, kind, intent, why: String(one.why || "").slice(0, 200), sem: "", topic: "",
      wakeId,
      from: o.g.threadNudged ? o.g.threadNudged.id : fromId && threads.some(x => x.id === fromId) ? fromId : "",
    });
    lit += 1;
    decide(t, "extra", `起念 ${time}——${intent}`, { wakeId });
  }
  nextItems.sort((a, b) => a.fireAt - b.fireAt);
  row.items = nextItems;
  decide(t, "judge", `${o.what}——${lit > o.litCount ? "起了一个念头" : decisions.length ? "改了念头" : "想了想，没找你"}`);
}

// 同轮后续任务也必须看到刚交付的正文、事项编号和主动发送时间。
function rememberOutput(history: CloudHistory, output: CloudOutput): void {
  if (!history.outputs.some(o => o.id === output.id)) history.outputs.push(output);
  const id = `push-outbox:${output.id}`;
  if (!history.messages.some(m => m.id === id)) history.messages.push({ id, role: "assistant", content: output.raw_text, message_at: output.created_at });
  history.messages.sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at));
  history.lastGeneratedAt = Math.max(history.lastGeneratedAt, Date.parse(output.created_at));
}

// ─── 5. 到点：发送前复核 → 生成 → 写 outbox → 推送
async function fireTimer(t: Turn, timer: TimerRow, history: CloudHistory): Promise<void> {
  if (t.mode === "shadow") return fireTimerLocked(t, timer, history, null);
  let lease: GenerationLease;
  try { lease = await acquireGenerationLease(t.deps.rest, t.deps.userId, t.c.sessionId, timer.id); }
  catch (err) {
    if (!(err instanceof GenerationBusy)) throw err;
    // 保留原重试次数；会话繁忙不算生成失败。
    t.deps.store.updateTimer(timer.id, { fireAt: t.deps.now() + 60_000 });
    decide(t, "hold", err.message, { wakeId: timer.id });
    return;
  }
  try {
    // 等待期间其他执行器可能刚发过回复，门禁和模型都必须看到最新事实。
    Object.assign(history, await readHistory(t.deps.rest, t.deps.userId, t.c.sessionId, t.ctx));
    await fireTimerLocked(t, timer, history, lease);
  } finally { await lease.release(); }
}

async function fireTimerLocked(t: Turn, timer: TimerRow, history: CloudHistory, lease: GenerationLease | null): Promise<void> {
  const { deps, ctx, c } = t;
  const nowMs = deps.now();
  const found = findItem(t, timer.id);
  const done = (note: string, kind = "skip") => {
    deps.store.updateTimer(timer.id, { status: t.mode === "shadow" ? "shadow" : "done", note });
    decide(t, kind, note, { wakeId: timer.id, time: found?.item.time });
  };
  if (!found) { done("找不到这条念头，作废"); return; }
  const { item, row } = found;
  // 上次 POST 可能已经提交但响应丢失。按完整任务键查凭据，再决定是否重新生成。
  if (t.mode === "live") {
    const response = await deps.rest(`push_outbox?user_id=eq.${encodeURIComponent(deps.userId)}&session_id=eq.${encodeURIComponent(c.sessionId)}&trigger_key=eq.${encodeURIComponent("timedwake:" + timer.id)}&select=id,trigger_key,raw_text,created_at,meta&limit=1`);
    if (!response.ok) throw new Error(`发送凭据读取失败 HTTP ${response.status}`);
    const outputs = await response.json() as CloudOutput[];
    if (!Array.isArray(outputs)) throw new Error("发送凭据格式错误");
    const output = outputs[0];
    if (output) {
      const sentAt = outputSentAt(output);
      if (!Number.isFinite(sentAt) || !output.id || typeof output.raw_text !== "string") throw new Error("发送凭据不完整");
      rememberOutput(history, output);
      markGenerated(t, history);
      item.generatedAt = Date.parse(output.created_at);
      deps.store.saveDay(row);
      deps.store.addSend({ wakeId: timer.id, characterId: c.characterId, date: row.date, kind: item.kind || "plan", fromId: item.from || "", sentAt, outboxId: output.id });
      done("已发送", "send");
      deps.store.deleteDraft(timer.id);
      return;
    }
  }
  if (!item.act) { done(`${item.time} 这条念头已经作罢`); return; }
  if (deps.halted?.(c.characterId, timer.id)) { t.steps.push(`${item.time} 撤销正在排队，不发`); return; }
  const threads = Array.isArray(ctx.threads) ? ctx.threads : [];
  const isPromise = item.kind === "promise";
  if (isPromise) {
    const th = threads.find(x => x.id === item.from);
    const current = !!th && !th.done && !["completed", "cancelled"].includes(String(th.status)) && Number(th.revision || 1) === Number(item.promiseRevision || 1)
      && !(Number(th.mentionedAt) > 0) && !/said:/.test(String(th.nudge || ""))
      && !history.outputs.some(x => {
        const event = x.meta?.guanianContext as { eventId?: string; revision?: number } | undefined;
        return event?.eventId === item.from && Number(event?.revision || 1) === Number(item.promiseRevision || 1);
      });
    if (!current) { done("约定已改期、完成或取消"); return; }
  }
  const draft = t.mode === "live" ? deps.store.getDraft(timer.id) : null;
  if (draft) {
    // 成文后只重试交付，不再受生成预算/念头淡去等门禁影响；取消和约定版本仍须有效。
    await deliverDraft(t, timer, history, draft, lease!);
    return;
  }
  if (!isPromise) {
    const nextAt = lastProactiveAt(history) + Math.max(0, Number(ctx.minGapMin) || 0) * 60_000;
    if (nowMs < nextAt) {
      deps.store.updateTimer(timer.id, { fireAt: nextAt, note: "等主动消息间隔" });
      decide(t, "hold", `${item.time} 主动消息间隔未到，等到 ${hhmm(nextAt, t.tz)}`, { wakeId: timer.id });
      return;
    }
    // 不合时宜度：未回应轮数 / 你正聊着 / 离上次主动多近
    const coolTarget = Math.max(0, Number(ctx.maxUnanswered) || 0);
    const rounds = unansweredRounds(history, nowMs);
    const lastUser = [...history.messages].reverse().find(m => m.role === "user");
    const lastUserAt = lastUser ? Date.parse(lastUser.message_at) : NaN;
    const closeness = (elapsed: number, windowMin: number) => {
      const span = windowMin * 60_000;
      return !(span > 0) || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= span ? 0 : Math.round((1 - elapsed / span) * 100);
    };
    const pr = coolTarget > 0 ? Math.min(100, Math.round(rounds / coolTarget * 100)) : 0;
    const pt = Number.isFinite(lastUserAt) ? closeness(nowMs - lastUserAt, cnum(ctx, "presendTalkingMin", 15)) : 0;
    const lp = lastProactiveAt(history);
    const pg = lp ? closeness(nowMs - lp, cnum(ctx, "presendGapMin", 60)) : 0;
    const press = Math.round(pr * 0.4 + pt * 0.4 + pg * 0.2);
    const maxPress = cnum(ctx, "presendMax", 70);
    const blocked = coolTarget > 0 && rounds >= coolTarget ? `连续 ${rounds} 轮没等到你回` : press >= maxPress ? `此刻不合时宜（${press}%）` : "";
    decide(t, "presend", blocked || `${item.time} 到点复核通过（不合时宜度 ${press}%）`, { wakeId: timer.id, pr, pt, pg, press, rounds, max: maxPress });
    if (blocked) { deps.store.updateTimer(timer.id, { status: t.mode === "shadow" ? "shadow" : "done", note: blocked }); return; }
  }

  const notes: string[] = [];
  const bridged = !ctx.day;
  const dayRaw = ctx.day || bridgeDay(t);
  {
    const day = bridged ? dayRaw : forkDay(dayRaw, nowMs, ctx.affection);
    const qs = ctx.quietStart, qe = ctx.quietEnd;
    const localHM = hhmm(nowMs, t.tz);
    const bufferMs = cnum(ctx, "busyBufferMin", 10) * 60_000 * (0.6 + roll(timer.id + ":buffer") / 100 * 0.8);
    const hold = (untilMs: number, note: string) => {
      deps.store.updateTimer(timer.id, { fireAt: untilMs, note });
      decide(t, "hold", note, { wakeId: timer.id, until: untilMs });
    };
    let sleepy = false;
    if (guanianAsleep(day, localHM, qs, qe)) {
      const mode = isPromise ? 1 : cnum(ctx, "sleepMode", 0);
      if (mode === 1) {
        const wakeHM = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(qe || "");
        const untilMs = nextLocalHM(wakeHM, t.tz, nowMs) + bufferMs;
        if (untilMs > nowMs) hold(untilMs, `TA睡着了，押到起床后（${wakeHM}）再发`);
        else done("TA睡着了，算不出起床时刻");
        return;
      }
      if (mode === 2) {
        const r = roll(timer.id), prob = cnum(ctx, "sleepWakeProb", 18);
        if (r >= prob) { done(`TA睡着了（掷 ${r} ≥ ${prob}，没醒）`); return; }
        sleepy = true;
      } else { done("TA睡着了，不发"); return; }
    }
    if (!sleepy && cnum(ctx, "busyHold", 0) > 0) {
      const end = busyUntil(day, localHM);
      if (end) { hold(nextLocalHM(end, t.tz, nowMs) + bufferMs, `TA正忙着顾不上，等 ${end} 忙完后再判断`); return; }
    }
    if (!isPromise) {
      const orig = Number(item.origFireAt) || item.fireAt || nowMs;
      const chance = waitingChance(nowMs, orig, cnum(ctx, "busyMaxHoldMin", 180));
      const cooled = roll(timer.id + ":waiting") / 100 >= chance;
      decide(t, "freshness", `等待 ${Math.max(0, Math.round((nowMs - orig) / 60000))} 分钟，保留发送概率 ${Math.round(chance * 100)}%${cooled ? "，这次念头淡去了" : "，继续核对事实"}`, { wakeId: timer.id });
      if (cooled) { deps.store.updateTimer(timer.id, { status: t.mode === "shadow" ? "shadow" : "done", note: "念头淡去了" }); return; }
    }
    let note = bridged
      ? `[系统备忘：这不是对方发来的消息。这是你此刻（本地时间 ${localHM}）的状态：今天的日程还没排，先按昨天的作息过${day.mood ? "，昨天最后的心情「" + day.mood + "」" : ""}。自然带出来就行，别提这段文字。]`
      : stateNote(day, nowMs, qs, qe, ctx.affection, shortThreadLines(threads, nowMs, t.tz));
    if (sleepy) note += "\n（TA本来睡着了，半夜迷迷糊糊醒了一下想起你：只说一两句、带着困意、说完就要接着睡。）";
    notes.push(note);
  }
  const duplicate = matterBlock(item, row.items, threads, history.outputs, history.messages);
  if (duplicate) { done(`${item.time} ${duplicate}`, "dedupe"); return; }
  if (item.from && threads.some(x => x.id === item.from && x.done === true) && !isPromise) { done("挂着的这件事已经了结"); return; }
  const promised = isPromise ? null : similarPromise(item.intent || "", threads);
  if (promised) { done(`${item.time} 和约定「${promised.text}」是同一件事，交给约定`, "dedupe"); return; }
  const sendBudget = await usageBudget(deps.rest, deps.userId, nowMs);
  const over = usageExceeded(sendBudget);
  if (over) { done(`用量上限：${over}`); return; }

  if (t.mode === "shadow") {
    done(`影子：${item.time} 会生成并推送——${item.intent}`, "send");
    return;
  }
  const snap = snapshotFor(t, "chat");
  if (!snap) { done("没有聊天快照，发不了（打开一次 Float 聊天让手机寄一份）"); return; }

  // 新式聊天模板（宿主随聊天自动重冻）：聊天记录已在模板里，只补冻结之后的新消息；意图和时间到点填空
  const fresh = !!snap.merge.intentPlaceholder;
  const since = history.messages.filter(m => Date.parse(m.message_at) > snap.capturedAt);
  const decidedAt = parseInt(/^srv_([0-9a-z]+)_/.exec(timer.id)?.[1] || "", 36);
  const elapsedMin = decidedAt > nowMs - 7 * 86_400_000 && decidedAt <= nowMs ? (nowMs - decidedAt) / 60_000 : 30;
  const localNow = new Date(nowMs + t.tz * 60000).toISOString().slice(0, 16);
  const facts = fresh
    ? since.length ? `[模板冻结之后的新聊天，非用户消息；当前当地时间 ${localNow}。以下时间是生成时间，不代表用户已读。]\n` + historyText({ ...history, messages: since, uncertainLegacy: [] }, t.tz, 80) : ""
    : `[最新云端聊天事实，非用户消息；统一时区 UTC${t.tz >= 0 ? "+" : ""}${t.tz / 60}，当前当地时间 ${new Date(nowMs + t.tz * 60000).toISOString().slice(0, 16)}。以下时间是生成时间，不代表用户已读；与旧快照冲突时以这里为准。]\n`
    + historyText(history, t.tz, 80, ctx);
  const intentNote = fresh && !isPromise ? "" : isPromise
    ? `[系统约定任务，非用户消息] ${item.intent}`
    : `[系统备忘：这不是对方发来的消息。到点了，你现在想主动跟对方说的是——${item.intent}。顺着你们刚才聊的往下说，别重复已经说过的话，也别提起这条备忘。]`;
  const factCheck = `[挂念发送前的事实核对，不是用户消息]\n当前当地时间：${new Date(nowMs + t.tz * 60000).toISOString().slice(0, 16)}\n原念头：${item.intent || "按上文意图"}\n${fresh ? "最新聊天以上方聊天记录为准" + (since.length ? "，模板之后的新消息见「模板冻结之后的新聊天」" : "") : "最新聊天见上方唯一一份「最新云端聊天事实」"}，不可编造。\n`
    + "事项编号：" + matterKey(item, threads) + "。必须逐项核对本次意图与已发送正文：问过而未获回复不构成新进展，不可换说法再问；已经完整交代的内容不再补发。早前只约定稍后回答而尚未回答，不等于回答已经完成。\n"
    + "用户已拒绝或取消的事情，不因角色坚持而继续提醒、劝说或跟进；角色替用户安排不等于用户同意。最新聊天中没有用户重新明确答应，就按事情已发生变化作罢。\n"
    + "先核对这个念头是否仍有必要：如果你已经在聊天里问过、说过这件事，用户已经回答或事情已经解决，就不要再发，也不要换个话题凑消息。仅仅出现相关词不等于已经说过，按实际问答与语义判断。具体约定或事件是否过时也按事实判断，不因单纯经过多少分钟而认定失效。\n"
    + "无需再发时，只输出 [挂念作罢：聊天已提过] 或 [挂念作罢：事情已解决或发生变化]，不要输出台词、独白或其他标签；仍有未说过且符合当前事实的内容时，按原格式自然成文。双方最新事实优先于旧预约意图。角色说过到了就是已交代的事实，后续不能无故退回尚未到家；再次外出必须有明确依据。约定到点并不证明已完成；不能替用户宣布完成。";
  if (!deps.store.claimTimer(timer.id)) { t.steps.push(`${item.time} 已被撤销或不在待发，不生成`); return; }
  // 旧哨兵快照里烤着「挂念后台复核模板…」这句假意图和冻结时的时间，也一并换掉
  const base = fillChatTemplate(snap.request, fresh ? snap.merge : { tzOffsetMin: snap.merge.tzOffsetMin, intentPlaceholder: SENTINEL_INTENT },
    { intent: item.intent, elapsedMin, nowMs });
  // 来电能力：模板里留了占位，同一角色 20 小时内只放一次说明（与原离线预约的频控一致）
  const invite = fillCallInvite(base, nowMs - (Number(ctx.callInviteAt) || 0) >= CALL_INVITE_WINDOW_MS);
  if (invite.present && nowMs - (Number(ctx.callInviteAt) || 0) >= CALL_INVITE_WINDOW_MS) ctx.callInviteAt = nowMs;
  const request = buildChatRequest(invite.request, [facts, ...notes, intentNote, factCheck]);
  await lease!.check();
  let result;
  try { result = await callModel(request, deps.fetchModel, 300_000); }
  catch (e) { deps.store.updateTimer(timer.id, { status: "pending" }); throw e; }
  let generated: GeneratedDraft;
  try {
    let rawText = result.text.trim();
    let reasoning: string | undefined;
    try { const parsed = visibleResponse(rawText, snap.merge.onlineThinking); rawText = parsed.text; reasoning = parsed.reasoningText; }
    catch { done("回复里的思考块不完整，没发", "error"); return; }
    if (!rawText) { done("回复是空的，没发", "error"); return; }
    const abandoned = /^\[挂念作罢[：:]([^\]\r\n]{1,120})\]$/.exec(rawText);
    if (abandoned) { done(`核对后作罢：${abandoned[1]}`, "factcheck"); return; }
    // 发送分流：来电 → 快捷动作 → 发到微信，标记都从正文剥掉（顺序与 push-generate 一致）
    const called = extractCall(rawText);
    const shortcut = extractShortcut(called.text);
    const weixin = extractWeixin(shortcut.text, shortcut.marker);
    rawText = weixin.text;
    const botId = weixin.weixin ? String(snap.weixin?.botId || "") : "";
    if (weixin.weixin && !botId) decide(t, "error", `${item.time} 模型想发到微信，但这个角色没绑定微信 bot，照常发到聊天`, { wakeId: timer.id });
    let continuation: GeneratedDraft["continuation"];
    if (shortcut.marker && snap.shortcutContinuation) {
      const cont = snap.shortcutContinuation;
      const filled = fillChatTemplate(cont.request, fresh ? snap.merge : { tzOffsetMin: snap.merge.tzOffsetMin, intentPlaceholder: SENTINEL_INTENT }, { intent: item.intent, elapsedMin, nowMs });
      continuation = { ...cont, request: fillCallInvite(filled, false).request };
    }
    // 成文期间可能被撤销
    const latest = findItem(t, timer.id);
    if (!latest || !latest.item.act) { done("成文期间这条念头被撤销了"); return; }
    // 成文期间手机点了撤销 / 停用：放回待发，让排队的撤销落地，不发
    if (deps.halted?.(c.characterId, timer.id)) { deps.store.updateTimer(timer.id, { status: "pending", note: "成文期间收到撤销" }); t.steps.push(`${item.time} 成文期间收到撤销，不发`); return; }

    const createdAt = new Date(deps.now()).toISOString();
    const outboxId = `out_${randomUUID()}`;
    const { snapshotAt: _s, armAt: _a, prevCount: _p, template: _tpl, intentPlaceholder: _ip, elapsedMark: _em, ...merge } = snap.merge;
    const meta: Record<string, unknown> = {
      ...merge,
      sessionId: c.sessionId,
      pushGenerated: true,
      companionServer: true,
      ...(reasoning ? { reasoningText: reasoning } : {}),
      ...(isPromise ? { guanianPromise: { id: item.from, revision: item.promiseRevision || 1 } } : {}),
      guanianContext: {
        messageIds: history.messages.slice(-80).map(m => m.id), checkedAt: createdAt,
        matterId: matterKey(item, threads), eventId: item.from || null, revision: isPromise ? item.promiseRevision || 1 : null,
      },
    };
    generated = {
      wakeId: timer.id, userId: deps.userId, sessionId: c.sessionId, outboxId, createdAt, rawText, meta,
      notify: { title: String(snap.notify.title || c.name || "小手机"), url: snap.notify.url || "/" },
      ...(called.call ? { deliverAsCall: true } : {}),
      ...(botId ? { weixinBotId: botId } : {}),
      ...(shortcut.marker ? { shortcut: shortcut.marker, ...(continuation ? { continuation } : {}) } : {}),
    };
    // 第一次异步网络操作之前落盘，之后即使失去租约/投递失败/重启，也不重新调用模型。
    deps.store.saveDraft(generated);
  } finally {
    await usageAdd(deps.rest, deps.userId, sendBudget.tz, "cloud-wake", snap.request.providerKind, result.data);
  }
  await deliverDraft(t, timer, history, generated, lease!);
}

async function deliverDraft(t: Turn, timer: TimerRow, history: CloudHistory, draft: GeneratedDraft, lease: GenerationLease): Promise<void> {
  const { deps, c, ctx } = t;
  if (draft.userId !== deps.userId || draft.sessionId !== c.sessionId) throw new Error("已成文消息的账号或会话已变更，保留正文待核对");
  const latest = findItem(t, timer.id);
  // 已经发到微信的收不回来，只补记录
  if (!latest && draft.weixinDone) { deps.store.updateTimer(timer.id, { status: "done", note: "已发到微信" }); deps.store.deleteDraft(timer.id); return; }
  if (!latest || !latest.item.act && !draft.weixinDone) { deps.store.updateTimer(timer.id, { status: "cancelled", note: "已成文念头被撤销" }); deps.store.deleteDraft(timer.id); return; }
  if (deps.halted?.(c.characterId, timer.id) && !draft.weixinDone) { deps.store.updateTimer(timer.id, { status: "pending", note: "成文期间收到撤销" }); return; }
  await lease.check();
  // 续租等待期间也可能收到取消。
  if (deps.halted?.(c.characterId, timer.id) && !draft.weixinDone) { deps.store.updateTimer(timer.id, { status: "pending", note: "投递前收到撤销" }); return; }
  const cc: CloudCtx | null = deps.cloud ? { rest: deps.rest, cloud: deps.cloud, key: deps.cloudKey || "", userId: deps.userId } : null;
  const { outboxId, rawText, createdAt } = draft;

  // 1. 快捷动作：先建命令（有续跑的延后投递）。建之前记 tried，重启后看到 tried 没结果就不重复执行
  if (draft.shortcut && !draft.shortcutTried) {
    draft.shortcutTried = true;
    deps.store.updateDraft(draft);
    if (!cc) {
      draft.shortcutCommand = null;
      draft.deliveryError = `快捷动作「${draft.shortcut.name}」没执行：后端没接个人云函数`;
    } else {
      const created = await createShortcutCommand(cc, draft.shortcut, !!draft.continuation).catch(e => ({ command: null, note: `快捷动作「${draft.shortcut!.name}」没建成：${errText(e)}` }));
      draft.shortcutCommand = created.command;
      if (!created.command) draft.deliveryError = created.note;
      else if (created.command.deliveryMode === "email" && !created.command.continued) {
        draft.deliveryError = await deliverShortcutCommand(cc, created.command) || undefined;
        draft.shortcutDelivered = true;
      }
    }
    deps.store.updateDraft(draft);
  } else if (draft.shortcut && draft.shortcutCommand === undefined) {
    draft.shortcutCommand = null;
    draft.deliveryError = `快捷动作「${draft.shortcut.name}」执行结果未确认，没有重复执行`;
    deps.store.updateDraft(draft);
  }
  const command = draft.shortcutCommand || null;
  // 2. 会回传结果的：挂上续跑，把刚说的这句代入回复占位（按命令 ID 幂等）
  if (command?.continued && draft.continuation) {
    const cont = structuredClone(draft.continuation);
    replaceMarker(cont.request.body, cont.replyMarker, rawText);
    const canSendImage = command.resultMode === "image" && cont.visionEnabled !== false;
    if (!canSendImage && cont.imageMarker) replaceMarker(cont.request.body, cont.imageMarker, command.resultMode === "image" ? SHORTCUT_VISION_OFF_NOTE : "（该动作没有图片回传）");
    const { guanianContext: _g, guanianPromise: _p, companionDeliveredAt: _d, reasoningText: _r, ...merge } = draft.meta;
    deps.store.saveResume({
      commandId: command.id, characterId: c.characterId, sessionId: c.sessionId, dueAt: deps.now() + 15_000, tries: 0,
      outboxId: `out_${randomUUID()}`, request: cont.request, resultMarker: cont.resultMarker, ...(canSendImage && cont.imageMarker ? { imageMarker: cont.imageMarker } : {}),
      actionName: command.actionName, notify: draft.notify, merge: { ...merge, shortcutCommandId: command.id },
    });
  }

  // 3. 改送真实微信：送成了就不进聊天 outbox（微信云助手自己记），送不成照常发到聊天
  if (draft.weixinBotId && !draft.weixinDone) {
    const failed = cc ? await sendWeixin(cc, draft.weixinBotId, rawText) : "后端没接个人云函数";
    if (!failed) { draft.weixinDone = true; deps.store.updateDraft(draft); }
    else decide(t, "error", `${latest.item.time} 发到微信失败，改发到聊天：${failed}`, { wakeId: timer.id });
  }
  const item = latest.item;
  const deliveredAt = deps.now();
  const markSent = (sentOutboxId: string) => {
    item.generatedAt = Date.parse(createdAt);
    deps.store.saveDay(latest.row);
    deps.store.addSend({ wakeId: timer.id, characterId: c.characterId, date: latest.row.date, kind: item.kind || "plan", fromId: item.from || "", sentAt: deliveredAt, outboxId: sentOutboxId });
    deps.store.updateTimer(timer.id, { status: "done", note: draft.weixinDone ? "已发到微信" : "已发送" });
    const th = (ctx.threads || []).find(x => x.id === item.from);
    if (th && !th.done) {
      th.mentionedAt = deliveredAt; th.at = deliveredAt;
      if (th.kind === "topic") th.done = true;
      else th.nudge = (String(th.nudge || "") + " said:" + item.time).trim().slice(-200);
    }
  };
  const afterDelivery = async () => {
    // 角色先说话 → 再弹「运行快捷指令」
    if (cc && command && !draft.shortcutDelivered) {
      const failed = await deliverShortcutCommand(cc, command);
      if (failed) draft.deliveryError = failed;
    }
    if (cc && draft.deliveryError) await writeShortcutDiagnostic(cc, c.sessionId, draft.deliveryError);
    deps.store.deleteDraft(timer.id);
  };
  if (draft.weixinDone) {
    markSent("");
    await afterDelivery();
    decide(t, "send", `${item.time} 发到微信了：${rawText.replace(/\s+/g, " ").slice(0, 60)}`, { wakeId: timer.id, weixin: true, shortcut: command?.actionName });
    return;
  }

  // 4. 聊天 outbox + 推送（来电是单条通知，点开直达振铃）
  // 保留生成时间供补收排序；回音窗口和主动间隔从本次成功投递开始。
  const meta = {
    ...draft.meta, companionDeliveredAt: new Date(deliveredAt).toISOString(),
    ...(command && draft.shortcut ? { shortcutMarker: { text: draft.shortcut.text, insertAt: draft.shortcut.insertAt, name: draft.shortcut.name } } : {}),
  };
  const saved = await deps.rest("push_outbox", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{ id: outboxId, user_id: deps.userId, job_id: null, session_id: c.sessionId, trigger_key: `timedwake:${timer.id}`, raw_text: rawText, created_at: createdAt, meta }]),
  });
  if (!saved.ok) throw new Error(`outbox 写入失败 HTTP ${saved.status}: ${(await saved.text().catch(() => "")).slice(0, 160)}`);
  rememberOutput(history, { id: outboxId, trigger_key: `timedwake:${timer.id}`, raw_text: rawText, created_at: createdAt, meta });
  markSent(outboxId);
  const parts = splitPreview(rawText).slice(0, 6);
  const messages: PushMessage[] = draft.deliverAsCall
    ? [{ type: "incoming_call", title: `📞 ${draft.notify.title}`, body: "来电话了…", tag: `${timer.id}-0`, url: `/?ring=${encodeURIComponent(c.sessionId)}&rt=${deliveredAt}`, characterId: c.characterId, sessionId: c.sessionId, callTs: deliveredAt }]
    : (parts.length ? parts : ["发来一条消息"]).map((body, index) => ({
      type: "chat_outbox", title: draft.notify.title, body: body.slice(0, 80), tag: `${timer.id}-${index}`, url: draft.notify.url, characterId: c.characterId,
    }));
  const pushed = await deps.push(messages).catch(e => ({ sent: 0, total: 0, removed: 0, skippedShell: 0, errors: [errText(e)] }));
  await afterDelivery();
  decide(t, "send", `${item.time} ${draft.deliverAsCall ? "打来电话" : "发出去了"}：${rawText.replace(/\s+/g, " ").slice(0, 60)}`,
    { wakeId: timer.id, outboxId, pushed: pushed.sent, pushErrors: pushed.errors, ...(command ? { shortcut: command.actionName } : {}), ...(draft.deliveryError ? { deliveryError: draft.deliveryError } : {}) });
}

/** 手动重新生成今天（App「重新生成」） */
export async function generateDayNow(deps: EngineDeps, characterId: string, date: string): Promise<string> {
  const c = deps.store.getCharacter(characterId);
  const tz = c ? characterTz(c) : null;
  if (!c || tz === null) return "角色不存在或时区缺失";
  const row = deps.store.getDay(characterId, date) || emptyDay(characterId, date);
  row.genTries = 0;
  const t: Turn = { deps, mode: "live", c, ctx: buildCtx(c, row, tz), tz, nowMs: deps.now(), date, row, steps: [] };
  await generateDay(t);
  return row.genError || "已生成";
}

export async function tickAll(deps: EngineDeps, mode: Mode): Promise<Trace[]> {
  const traces: Trace[] = [];
  for (const c of deps.store.listCharacters()) traces.push(await tickCharacter(deps, mode, c.characterId));
  return traces;
}
