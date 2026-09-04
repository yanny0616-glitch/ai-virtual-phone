// 云端动态复核（Supabase Edge Function 版）
// 部署：Dashboard → Edge Functions → 新建函数 push-recheck → 粘贴本文件 →
//      关闭 JWT 校验（Enforce JWT verification = off，本函数用 cron_secret 自校验）
// 职责：cron 每 30 分钟派一份计划过来 → 只在聊天镜像出现新的用户消息时才动 →
//      借待发预约里冻结的 LLM 凭据发一次裁决 → 撤销/点亮/临时起念直接改 push_jobs →
//      裁决同时留在 push_recheck_plans.decisions，等挂念 App 下次打开合并进本地轨迹。
// 注意：本函数不重建角色提示词——点亮和临时起念是克隆同一天某条预约的快照再追加
//      一句新意图，所以人设/世界书跟着那条快照走，不会比 App 现排的更旧。

type ProviderKind = "openai-compatible" | "anthropic" | "gemini";
type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

type JobRow = { id: string; trigger_key: string; status: string; execute_at: string; payload: EncryptedPayload };
type JobPayload = {
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  notify?: { title?: string; url?: string; characterId?: string };
  merge?: Record<string, unknown> & { sessionId?: string };
  [key: string]: unknown;
};

type PlanItem = {
  time: string;
  fireAt: number;
  source: string;
  act: boolean;
  intent: string;
  why: string;
  sem: string;
  topic: string;
  wakeId: string;
  origFireAt?: number;
  /** 这个念头的保质期：过了就不新鲜了，改约只能挪到它之前 */
  until?: number;
};
type PlanContext = {
  mood?: string;
  energy?: string;
  quota?: number;
  quietStart?: string;
  quietEnd?: string;
  minGapMin?: number;
  maxUnanswered?: number;
  chatCandidates?: string;
  bias?: string;
  wakePrefix?: string;
  gateDailyCap?: number;
  gateGapMin?: number;
  gateHorizonMin?: number;
  gateFreshMin?: number;
  gateMinMsgs?: number;
  selfImpulseCap?: number;
  /** 0=早上一把定完（旧）  1=随用随判：编排不排念头，白天由云端随时起 */
  impulseMode?: number;
  /** 多久没联系算「安静太久」（分钟） */
  selfSilenceMin?: number;
  /** 改约的总上限，和「忙就押后」共用同一个设置 */
  busyMaxHoldMin?: number;
  selfUsed?: number;
  /** 聊天插件「好感与关系」算出来的分寸，App 编排时寄来；没装插件就没有 */
  affection?: { score?: number; tier?: string; relation?: string } | null;
  day?: GuanianDay;
  genKit?: GenKit | null;
  /** 惦记账本：App 从聊天里记下的话头 / 约定 / 日子，跨天带着；云端复核也往里记、往外销 */
  threads?: Thread[];
  threadDays?: number;
  /** 发朋友圈：云端发不了帖，起意写进 outbox，App 下次打开按 at 那个时间点补发。
   *  配速（一周几条、至少隔几小时）和发圈账（上一条时间、本周条数）App 与云端共用一套，合并取大 */
  momentsOn?: number;
  momentsWeekly?: number;
  momentsGapH?: number;
  momentsLast?: number;
  momentsWeekStart?: number;
  momentsWeekN?: number;
  momentsRollHour?: number;
  outbox?: Outbox[];
  generatedBy?: string;
  genTries?: number;
  [key: string]: unknown;
};
// 挂念寄存的当天原料：日程带 cost/情绪，conds 是还在起作用的聊天情绪。算法与挂念 index.html
// 的 energyAt / moodNow 一致，改一处要同步另一处（push-generate 里也有一份）。
type GuanianSched = { time?: string; end?: string; title?: string; cost?: number; mood?: string; busy?: boolean; steps?: { time?: string; what?: string }[] };
type GuanianCond = { startAt?: number; halfLifeMin?: number; intensity?: number; energyDelta?: number; mood?: string; cause?: string };
type GuanianDay = {
  tz?: number; mood?: string; energy?: number; location?: string; doing?: string;
  wake?: string; bed?: string; schedule?: GuanianSched[]; conds?: GuanianCond[];
};
// 睡眠窗：bed 起到 wake 止，允许过零点；老版本 App 没寄 wake/bed 时退回免打扰时段。与 App 端 asleepAt 同步。
function guanianAsleep(day: GuanianDay, hm: string, quietStart?: string, quietEnd?: string): boolean {
  const bed = /^\d{2}:\d{2}$/.test(String(day.bed || "")) ? String(day.bed) : String(quietStart || "");
  const wake = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(quietEnd || "");
  if (!bed || !wake || bed === wake) return false;
  return bed < wake ? (hm >= bed && hm < wake) : (hm >= bed || hm < wake);
}
function affectionLine(aff: { tier?: string; relation?: string } | null | undefined): string {
  if (!aff || (!aff.tier && !aff.relation)) return "";
  return `你对用户：${aff.tier || "说不上"}；两人现在的关系：${aff.relation || "没定"}。想不想找TA、找了说什么，都按这个分寸来。`;
}
// ── 惦记账本（App index.html 同名函数的 tz 算术版；改一处要同步另一处）
const THREAD_KIND: Record<string, string> = { topic: "话头", promise: "约定", date: "日子" };
function threadAlive(t: Thread, nowMs: number, days: number): boolean {
  if (!t || !t.text) return false;
  if (t.done) return nowMs - (Number(t.at) || 0) < 86_400_000;
  const due = Number(t.due) || 0;
  if (t.kind === "date") return t.yearly ? true : (due ? nowMs < due + 86_400_000 : false);
  if (t.kind === "promise") return due ? nowMs < due + 86_400_000 : nowMs - (Number(t.since) || 0) < 7 * 86_400_000;
  return nowMs - (Number(t.at) || Number(t.since) || 0) < (days || 3) * 86_400_000;
}
function threadDueMs(t: Thread, nowMs: number, tz: number): number {
  const due = Number(t.due) || 0;
  if (!due || !t.yearly) return due;
  const d = new Date(due + tz * 60_000), n = new Date(nowMs + tz * 60_000);
  d.setUTCFullYear(n.getUTCFullYear());
  if (d.getTime() - tz * 60_000 < nowMs - 86_400_000) d.setUTCFullYear(n.getUTCFullYear() + 1);
  return d.getTime() - tz * 60_000;
}
function threadWhen(t: Thread, nowMs: number, tz: number): string {
  const due = threadDueMs(t, nowMs, tz);
  if (!due) return "";
  const diff = due - nowMs, d = new Date(due + tz * 60_000), n = new Date(nowMs + tz * 60_000);
  const hm = t.kind === "date" ? "" : " " + hhmm(due, tz);
  const sameDay = (a: Date, b: Date) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
  if (t.kind !== "date" && Math.abs(diff) < 3_600_000) return "就在这会儿";
  if (sameDay(d, n)) return "今天" + hm;
  if (diff < 0) return diff > -86_400_000 * 1.5 ? "昨天" + hm : Math.round(-diff / 86_400_000) + " 天前";
  if (sameDay(d, new Date(nowMs + tz * 60_000 + 86_400_000))) return "明天" + hm;
  return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + hm + " · " + Math.round(diff / 86_400_000) + " 天后";
}
function liveThreads(context: PlanContext, nowMs: number): Thread[] {
  const days = Number(context.threadDays) || 3;
  return (Array.isArray(context.threads) ? context.threads : []).filter(t => t && !t.done && threadAlive(t, nowMs, days));
}
function threadLines(context: PlanContext, nowMs: number, tz: number): string[] {
  return liveThreads(context, nowMs).slice(0, 12).map(t => `[${t.id}] ${THREAD_KIND[t.kind] || "话头"}·${t.text}${threadWhen(t, nowMs, tz) ? "（" + threadWhen(t, nowMs, tz) + "）" : ""}`);
}
const THREAD_TASK = "惦记账本：上面带 [id] 的是你心里还挂着的事。keep 里写这次聊天里新冒出来、值得跨天记住的：没聊完的话头（topic）、约好或答应了的事（promise，when 给时间）、重要的日子（date，when 给日期）。只写用户明确说过的，随口一提的不算，账本里已有的不要重复写；一次最多 2 条。settle 写已经了结、过时或说开了的 id。都没有就给空数组。";
// 模型给的时间：2026-09-10 15:00 / 09-10 / 9月10日 / 15:00 / 明天 15:00，按 tz 折成 UTC ms
function parseWhen(when: unknown, nowMs: number, tz: number): number {
  const w = String(when || "").trim();
  const local = new Date(nowMs + tz * 60_000);
  const mk = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo, d, h, mi) - tz * 60_000;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(w);
  if (m) return mk(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
  m = /^(\d{1,2})[-/月](\d{1,2})日?$/.exec(w);
  if (m) { let ms = mk(local.getUTCFullYear(), +m[1] - 1, +m[2], 12, 0); if (ms < nowMs - 86_400_000) ms = mk(local.getUTCFullYear() + 1, +m[1] - 1, +m[2], 12, 0); return ms; }
  m = /^(?:(今天|明天|后天)\s*)?(\d{1,2}):(\d{2})$/.exec(w);
  if (m) {
    const add = m[1] === "明天" ? 1 : m[1] === "后天" ? 2 : 0;
    let ms = mk(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + add, +m[2], +m[3]);
    if (!m[1] && ms < nowMs - 3_600_000) ms += 86_400_000;
    return ms;
  }
  return 0;
}
// 复核回来的 keep / settle 并进账本；返回 null 表示没动
function applyThreads(context: PlanContext, keep: Keep[], settle: string[], nowMs: number, tz: number, log: (s: string) => void): Thread[] | null {
  const list: Thread[] = (Array.isArray(context.threads) ? context.threads : []).map(t => ({ ...t }));
  const notes: string[] = [];
  for (const id of settle.slice(0, 6)) {
    const t = list.find(x => x.id === String(id).replace(/[\[\]]/g, "").trim());
    if (t && !t.done) { t.done = true; t.at = nowMs; t.by = "cloud"; notes.push(`了结「${t.text}」`); }
  }
  for (const k of keep.slice(0, 2)) {
    const text = String(k?.text || "").trim().slice(0, 60);
    if (!text) continue;
    const kind = THREAD_KIND[String(k?.kind)] ? String(k?.kind) : "topic";
    const dup = list.find(x => !x.done && (x.text === text || x.text.includes(text) || text.includes(x.text)));
    if (dup) { dup.at = nowMs; continue; }
    const due = parseWhen(k?.when, nowMs, tz);
    if (kind !== "topic" && !due) continue;
    list.push({ id: "t" + Math.random().toString(36).slice(2, 6), kind, text, due, yearly: kind === "date" && /生日|纪念/.test(text), since: nowMs, at: nowMs, by: "cloud", done: false });
    notes.push(`记下${THREAD_KIND[kind]}「${text}」`);
  }
  if (!notes.length) return null;
  log("惦记账本：" + notes.join("，"));
  return list.filter(t => threadAlive(t, nowMs, Number(context.threadDays) || 3)).slice(-30);
}
// 自发起念的由头三：约定快到点（前 30–90 分钟）、刚过点（1–3 小时后）、到日子了。每个阶段只提一次，记在 nudge 里
function threadNudge(context: PlanContext, nowMs: number, tz: number): { id: string; mark: string; reason: string } | null {
  for (const t of liveThreads(context, nowMs)) {
    const due = threadDueMs(t, nowMs, tz);
    if (!due) continue;
    const d = due - nowMs, marks = String(t.nudge || "");
    const mark = (phase: string) => `${phase}:${due}`;
    if (t.kind === "promise") {
      if (d > 30 * 60_000 && d <= 90 * 60_000 && !marks.includes(mark("pre"))) return { id: t.id, mark: mark("pre"), reason: `用户 ${hhmm(due, tz)} 要${t.text}，快到了` };
      if (d < -60 * 60_000 && d >= -180 * 60_000 && !marks.includes(mark("post"))) return { id: t.id, mark: mark("post"), reason: `用户 ${hhmm(due, tz)} 的「${t.text}」该有结果了` };
    } else if (t.kind === "date" && Math.abs(d) <= 12 * 3_600_000 && !marks.includes(mark("day"))) {
      return { id: t.id, mark: mark("day"), reason: `今天是${t.text}` };
    }
  }
  return null;
}
type GuanianNow = { hm: string; doing: string; step: string; mood: string; energy: number; next: string; done: GuanianSched | null; asleep: boolean };

function guanianNow(day: GuanianDay, nowMs: number, quietStart?: string, quietEnd?: string): GuanianNow {
  const tz = Number.isFinite(Number(day.tz)) ? Number(day.tz) : 0;
  const local = new Date(nowMs + tz * 60_000);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  const hm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const sched = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");
  const conds = (Array.isArray(day.conds) ? day.conds : [])
    .map(c => ({ c, w: Math.pow(0.5, Math.max(0, nowMs - (Number(c.startAt) || 0)) / (Math.max(10, Number(c.halfLifeMin) || 180) * 60_000)) }))
    .filter(x => x.w > 0.08 && (Number(x.c.startAt) || 0) <= nowMs)
    .sort((a, b) => (b.w * (Number(b.c.intensity) || 50)) - (a.w * (Number(a.c.intensity) || 50)));
  let done: GuanianSched | null = null;
  for (const it of sched) if (String(it.time) <= hm) done = it;
  const next = sched.find(it => String(it.time) > hm) || null;
  const asleep = guanianAsleep(day, hm, quietStart, quietEnd);
  // 与 App 端 phaseAt 同步：睡着 / 正做着 / 做完了在空档 / 最后一件做完在等睡（过零点还没睡也算）
  const bedHM = /^\d{2}:\d{2}$/.test(String(day.bed || "")) ? String(day.bed) : String(quietStart || "");
  const wakeHM = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(quietEnd || "");
  const lateNight = !done && !!bedHM && !!wakeHM && bedHM < wakeHM && hm < bedHM;
  const over = lateNight || !!(done && done.end && done.end > String(done.time) && hm >= done.end);
  const doing = asleep ? "睡觉"
    : lateNight ? "睡前自己待着，准备睡了"
    : !done ? (day.doing || "起床后的时间")
    : !over ? String(done.title || "")
    : next ? `歇着（刚忙完${done.title || ""}）` : "睡前自己待着，准备睡了";
  let step = "";
  if (done && !over && !asleep && Array.isArray(done.steps)) {
    for (const x of done.steps) if (x && typeof x.time === "string" && x.time <= hm) step = String(x.what || "");
  }
  const hh = h < 5 ? h + 24 : h;
  let energy = Number.isFinite(Number(day.energy)) ? Number(day.energy) : 60;
  const hmNum = (v: unknown): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
    return m ? Number(m[1]) + Number(m[2]) / 60 : null;
  };
  // 与面板 energyAt 同步：cost 按进度记账、状况负向合计封顶 -25、缓降从起床时刻起算
  for (const it of sched) {
    if (h >= 5 && String(it.time) > hm) continue;
    const a = hmNum(it.time), b = hmNum(it.end);
    const prog = a != null && b != null && b > a ? Math.max(0, Math.min(1, (h - a) / (b - a))) : 1;
    energy += (Number(it.cost) || 0) * prog;
  }
  let cd = 0;
  for (const x of conds) cd += (Number(x.c.energyDelta) || 0) * x.w;
  energy += Math.max(-25, cd);
  const wakeH = hmNum(day.wake) ?? 7;
  energy -= Math.max(0, Math.min(hh, 22) - wakeH) * 1.2 + Math.max(0, hh - 22) * 8;
  energy = Math.max(0, Math.min(100, Math.round(energy)));
  const cand: { text: string; w: number }[] = [];
  const top = conds[0];
  if (top && top.c.mood) cand.push({ text: `${top.c.mood}（因为${top.c.cause || "刚才聊的"}）`, w: top.w * (Number(top.c.intensity) || 50) / 100 });
  if (done && done.mood) {
    const [dh, dm] = String(done.time).split(":").map(Number);
    cand.push({ text: `${done.mood}（${done.title || ""}之后）`, w: Math.pow(0.5, Math.max(0, (h * 60 - (dh * 60 + dm)) * 60_000) / (90 * 60_000)) * 0.6 });
  }
  cand.sort((a, b) => b.w - a.w);
  const hit = cand.find(x => x.w > 0.15);
  return {
    hm, done, step, energy, doing, asleep,
    mood: hit ? hit.text : `${day.mood || "说不上来"}（今天的底色）`,
    next: asleep ? `${day.wake || quietEnd || ""} 起床`.trim() : next ? `${next.time} ${next.title || ""}` : (over && day.bed ? `${day.bed} 睡觉` : ""),
  };
}
type PlanRow = {
  session_id: string;
  context: PlanContext;
  items: PlanItem[];
  decisions: unknown[];
  last_recheck_at: string | null;
  recheck_count: number;
  updated_at: string | null;
};

type Impulse = { time?: string; until?: string; about?: string; sem?: string; topic?: string; intent?: string; why?: string };
// ─── 生活轮：TA自己想不想发朋友圈，和用户无关，不调模型 ───
// 与 chat-plugins/moments-rhythm.js 同一套骰子：每小时掷一次，概率 = 周目标/7 × 时段权重 × 精力 × 刚做完一件事的加成。
// 装了挂念的话插件让位，所以这是唯一在掷的骰子；一周条数和最小间隔是硬上限。
const MO_HOUR_W = [0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.6, 0.6, 0.6, 0.9, 0.9, 0.6, 0.6, 0.6, 0.7, 1.0, 1.2, 1.3, 1.3, 1.2, 0.8];
const MO_W_SUM = MO_HOUR_W.reduce((a, b) => a + b, 0);
function momentsWeekStart(nowMs: number, tzMin: number): number {
  const local = new Date(nowMs + tzMin * 60_000);
  const dow = (local.getUTCDay() + 6) % 7;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow) - tzMin * 60_000;
}
function momentsBudget(context: PlanContext, nowMs: number, tzMin: number): { weekStart: number; weekN: number; ok: boolean } {
  const weekStart = momentsWeekStart(nowMs, tzMin);
  const weekN = Number(context.momentsWeekStart) === weekStart ? Number(context.momentsWeekN) || 0 : 0;
  const ok = Number(context.momentsOn) === 1
    && weekN < Math.max(0, Number(context.momentsWeekly ?? 3))
    && nowMs - (Number(context.momentsLast) || 0) >= Math.max(0, Number(context.momentsGapH ?? 6)) * 3600_000;
  return { weekStart, weekN, ok };
}
function lifeRoll(context: PlanContext, nowMs: number): { patch: Record<string, unknown>; post: Outbox | null } | null {
  const day = context.day && typeof context.day === "object" ? context.day : null;
  if (Number(context.momentsOn) !== 1 || !day) return null;
  const tz = Number(day.tz) || 0;
  const hourKey = Math.floor((nowMs + tz * 60_000) / 3600_000);
  if (Number(context.momentsRollHour) === hourKey) return null;
  const budget = momentsBudget(context, nowMs, tz);
  const patch: Record<string, unknown> = { momentsRollHour: hourKey, momentsWeekStart: budget.weekStart, momentsWeekN: budget.weekN };
  const skip = (why: string) => { console.log("[push-recheck] 生活轮不发圈：" + why); return { patch, post: null }; };
  if (!budget.ok) return skip("本周条数或间隔");
  const now = guanianNow(day, nowMs, context.quietStart, context.quietEnd);
  if (now.asleep) return skip("睡着");
  const local = new Date(nowMs + tz * 60_000);
  const cur = now.done && now.doing === String(now.done.title || "") ? now.done : null;
  const slotW = cur && cur.busy ? 0.2 : Math.max(MO_HOUR_W[local.getUTCHours()], 0.4);
  let boost = 0.5 + (Math.max(0, Math.min(100, now.energy)) / 100) * 0.8;
  const hints: string[] = [];
  if (now.done && now.doing.startsWith("歇着")) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(now.done.end || now.done.time || ""));
    const endMs = m ? Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(m[1]), Number(m[2])) - tz * 60_000 : 0;
    if (endMs && nowMs - endMs < 45 * 60_000) { boost *= 1.5; hints.push("刚做完：" + String(now.done.title || "") + (now.done.mood ? "，" + now.done.mood : "")); }
  } else if (cur) hints.push("此刻在：" + String(cur.title || ""));
  if (now.mood) hints.push("此刻情绪：" + now.mood);
  if (day.location) hints.push("在：" + String(day.location));
  const p = Math.min(0.9, (Number(context.momentsWeekly ?? 3) / 7) * (slotW / MO_W_SUM) * boost);
  const roll = Math.random();
  console.log(`[push-recheck] 生活轮 ${local.getUTCHours()}点 p=${p.toFixed(3)} roll=${roll.toFixed(3)} → ${roll < p ? "发圈" : "不发"}`);
  if (roll >= p) return { patch, post: null };
  const post: Outbox = { id: "mo" + nowMs.toString(36), at: nowMs, hint: ("可以顺着这些来，不用全提：" + hints.join("；")).slice(0, 120), by: "cloud" };
  patch.momentsLast = nowMs;
  patch.momentsWeekN = budget.weekN + 1;
  patch.outbox = [...(Array.isArray(context.outbox) ? context.outbox : []).slice(-4), post];
  return { patch, post };
}

type Decision = { time?: string; act?: boolean; sem?: string; topic?: string; why?: string; intent?: string; defer?: string };
type Extra = { time?: string; until?: string; about?: string; intent?: string; why?: string };
type Thread = { id: string; kind: string; text: string; due?: number; yearly?: boolean; since?: number; at?: number; by?: string; done?: boolean; nudge?: string };
type Keep = { kind?: string; text?: string; when?: string };
type Outbox = { id: string; at: number; hint: string; by?: string };

// 门禁默认值，可被 App 上传的 context 里的同名字段覆盖（改设置不用重新部署云函数）。
// 这一层每一道都只读本地状态，一次模型都不调——判断得勤和花钱多是两件事。
const GATE_DEF = {
  gateDailyCap: 8,     // 每份计划每天最多几次裁决调用
  gateGapMin: 25,      // 两次裁决最小间隔（分钟）。cron 每 30 分钟派一次，留 5 分钟容抖动
  gateHorizonMin: 240, // 最近的待发时刻在这么久以外就不判（分钟，0=不限）
  gateFreshMin: 10,    // 最后一句话说完还不到这么久就先不判，等话说完（分钟，0=不等）
  gateMinMsgs: 1,      // 上次裁决之后用户至少说这么多句才判
  selfImpulseCap: 0,   // 没有新聊天时，每天最多几次「自发起念」裁决（0=关）
};
// 自发起念的第二种由头：双方都这么久没说话了
// 还有不到 2 分钟就到点的时刻不再改动，免得和 push-generate 抢同一条预约。
const LEAD_MS = 2 * 60_000;
const SELF_SILENCE_MS = 3 * 3600_000;

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

async function encryptPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plain) as unknown as BufferSource,
  ));
  return {
    v: 1,
    iv: bytesToBase64(iv),
    tag: bytesToBase64(combined.slice(combined.length - 16)),
    ct: bytesToBase64(combined.slice(0, combined.length - 16)),
  };
}

async function decryptPayload(payload: EncryptedPayload, secret: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const ct = base64ToBytes(payload.ct);
  const tag = base64ToBytes(payload.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) as unknown as BufferSource },
    key,
    combined as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

function textFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
      return typeof item.text === "string" ? item.text : "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

/* ─── 模型调用用量账本（push_api_usage / push_api_limits）：几个云函数各有一份同样的副本 ─── */
type UsageBudget = { day: string; tz: number; calls: number; tokens: number; dailyCalls: number; dailyTokens: number };
function usageLocalDay(nowMs: number, tz: number): string {
  const d = new Date(nowMs + tz * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function extractUsage(providerKind: ProviderKind, data: unknown): { prompt: number; completion: number } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  if (providerKind === "gemini") {
    const u = d.usageMetadata || {};
    return { prompt: n(u.promptTokenCount), completion: n(u.candidatesTokenCount) };
  }
  const u = d.usage || {};
  if (providerKind === "anthropic") {
    return { prompt: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens), completion: n(u.output_tokens) };
  }
  return { prompt: n(u.prompt_tokens), completion: n(u.completion_tokens) };
}
async function usageBudget(rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string): Promise<UsageBudget> {
  const limitsRes = await rest(`push_api_limits?user_id=eq.${encodeURIComponent(userId)}&select=daily_calls,daily_tokens,tz&limit=1`).catch(() => null);
  const limits = limitsRes && limitsRes.ok ? (await limitsRes.json().catch(() => []) as { daily_calls?: number; daily_tokens?: number; tz?: number }[])[0] : undefined;
  const tz = Number(limits?.tz) || 0;
  const day = usageLocalDay(Date.now(), tz);
  const rowsRes = await rest(`push_api_usage?user_id=eq.${encodeURIComponent(userId)}&day=eq.${encodeURIComponent(day)}&source=neq.cloud-chat&select=calls,prompt_tokens,completion_tokens`).catch(() => null);
  const rows = rowsRes && rowsRes.ok ? await rowsRes.json().catch(() => []) as { calls: number; prompt_tokens: number; completion_tokens: number }[] : [];
  let calls = 0, tokens = 0;
  for (const r of rows) { calls += Number(r.calls) || 0; tokens += (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0); }
  return { day, tz, calls, tokens, dailyCalls: Number(limits?.daily_calls) || 0, dailyTokens: Number(limits?.daily_tokens) || 0 };
}
function usageExceeded(b: UsageBudget): string {
  if (b.dailyCalls > 0 && b.calls >= b.dailyCalls) return `今天的模型调用次数用完了（${b.calls}/${b.dailyCalls}）`;
  if (b.dailyTokens > 0 && b.tokens >= b.dailyTokens) return `今天的 token 额度用完了（${b.tokens}/${b.dailyTokens}）`;
  return "";
}
async function usageAdd(rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string, tz: number, source: string,
  providerKind: ProviderKind, data: unknown): Promise<void> {
  const u = extractUsage(providerKind, data);
  await rest("rpc/ai_phone_usage_add", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ p_user_id: userId, p_day: usageLocalDay(Date.now(), tz), p_source: source, p_calls: 1, p_prompt: u.prompt, p_completion: u.completion }),
  }).catch(() => undefined);
}

function extractResponseText(providerKind: ProviderKind, data: unknown): string {
  if (providerKind === "anthropic") {
    const blocks = (data as { content?: unknown[] }).content;
    let text = "";
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const item = block as { type?: string; text?: string };
      if (item.type === "text") text += item.text ?? "";
    }
    return text;
  }
  if (providerKind === "gemini") {
    const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      const item = part as { text?: string; thought?: boolean; functionCall?: unknown };
      if (!item.functionCall && !item.thought) text += item.text ?? "";
    }
    return text;
  }
  const d = data as { choices?: Array<{ message?: { content?: unknown }; text?: string }>; response?: string };
  return textFromUnknownContent(d.choices?.[0]?.message?.content).trim()
    || (typeof d.choices?.[0]?.text === "string" ? d.choices[0].text.trim() : "")
    || (typeof d.response === "string" ? d.response.trim() : "");
}

/** 裁决只要一段 JSON：借快照的 url/headers/model，但不重放整份角色提示词。 */
function buildJudgeBody(template: JobPayload["request"], prompt: string): Record<string, unknown> {
  const model = template.body.model;
  if (template.providerKind === "anthropic") {
    return { model, max_tokens: 900, messages: [{ role: "user", content: prompt }] };
  }
  if (template.providerKind === "gemini") {
    return {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 900, temperature: 0.8 },
    };
  }
  return { model, messages: [{ role: "user", content: prompt }], temperature: 0.8, max_tokens: 900, stream: false };
}

/** 模型爱把 JSON 裹在解释或 ``` 里，取最外层的一对花括号。 */
function parseJudgeJson(text: string): { decisions: Decision[]; extra: Extra[]; keep: Keep[]; settle: string[]; post: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { decisions: [], extra: [], keep: [], settle: [], post: "" };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { decisions?: unknown; extra?: unknown; keep?: unknown; settle?: unknown; post?: unknown };
    const post = parsed.post && typeof parsed.post === "object" ? (parsed.post as { hint?: unknown }).hint : null;
    return {
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 12) as Decision[] : [],
      extra: Array.isArray(parsed.extra) ? parsed.extra.slice(0, 1) as Extra[] : [],
      keep: Array.isArray(parsed.keep) ? parsed.keep.slice(0, 2) as Keep[] : [],
      settle: Array.isArray(parsed.settle) ? parsed.settle.slice(0, 6).map(x => String(x)) : [],
      post: typeof post === "string" ? post.trim().slice(0, 120) : "",
    };
  } catch {
    return { decisions: [], extra: [], keep: [], settle: [], post: "" };
  }
}

/** 把新意图写进克隆出来的快照：追加一条用户视角的系统备忘，各家结构不同分别塞。 */
function appendIntentNote(body: Record<string, unknown>, providerKind: ProviderKind, note: string): boolean {
  if (providerKind === "gemini") {
    const contents = body.contents;
    if (!Array.isArray(contents)) return false;
    contents.push({ role: "user", parts: [{ text: note }] });
    return true;
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  messages.push({ role: "user", content: note });
  return true;
}

// 快照里烤着原时刻的「约 N 分钟前你这么决定的」和当时那句意图，克隆到新时刻就成了假话。
// 提示词是用户可改的，对不上就整段不动——追加的备忘里已经写明了真正的新意图。
function retuneWakeSnapshot(body: Record<string, unknown>, providerKind: ProviderKind, intent: string, minutes: number): void {
  const fix = (text: string) => text
    .replace(/（约\s*\d+\s*分钟前你这么决定的）/g, `（约 ${minutes} 分钟前你这么决定的）`)
    .replace(/你当时想着：“[^”]*”/g, `你当时想着：“${intent}”`);
  if (providerKind === "gemini") {
    for (const one of (Array.isArray(body.contents) ? body.contents : [])) {
      const parts = (one as Record<string, unknown>)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const p = part as Record<string, unknown>;
        if (typeof p?.text === "string") p.text = fix(p.text);
      }
    }
    return;
  }
  for (const one of (Array.isArray(body.messages) ? body.messages : [])) {
    const m = one as Record<string, unknown>;
    if (typeof m?.content === "string") m.content = fix(m.content);
  }
}

function hhmm(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/* ═══════════════ 云端生成TA的一天（挂念「浏览器关着也生成」） ═══════════════
 * App 每次打开为明天寄一份 genKit：生成指令（由 App 的 buildDayInstruction 拼好，云端不自己拼提示词）、
 * 两个 push.freeze 模板键（companion+daily / companion+impulse，与本地 ai.generate 同源）、到点时刻、时区、锚点开关。
 * 到点后：借 daily 模板换掉占位符 → 生成 JSON → 下面这些逐字对照 App index.html 的函数归一/编排 →
 * 借 impulse 模板判断起念 → 克隆哨兵聊天快照挂预约 → 整份写回计划行，App 打开时 adoptCloudDay 接管。
 * 以下带「App 同名」注释的函数改动要和 index.html 同步。 */
type GenKit = {
  date?: string; instruction?: string; autoGenAt?: string; tz?: number;
  existing?: { id?: string; startTime?: string; endTime?: string; title?: string; location?: string; lock?: string }[];
  tplDaily?: string; tplImpulse?: string;
  anchorMorning?: boolean; anchorSleep?: boolean; moodGate?: boolean; kitAt?: number;
};
type GenDay = {
  wake: string; bed: string; mood: string; moodEmoji: string; energy: number; doing: string; location: string; sleep: string;
  schedule: { time: string; end?: string; title: string; place?: string; note?: string; mood?: string; cost?: number; busy?: boolean }[];
  conds: { mood: string; cause: string; energyDelta: number; intensity: number; halfLifeMin: number; startAt: number }[];
};
const GEN_PLACEHOLDER = "__CUSTOM_APP_INSTRUCTION__";
const GEN_MAX_TRIES = 3;
const pad2 = (n: number): string => String(n).padStart(2, "0");

// App 同名 parseModelJson
function parseModelJson(text: unknown): any {
  let t = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  try { return JSON.parse(t); } catch (_e) { /* 继续尝试截取 */ }
  for (let a = t.indexOf("{"); a >= 0; a = t.indexOf("{", a + 1)) {
    let depth = 0, inStr = false, escaped = false;
    for (let i = a; i < t.length; i++) {
      const ch = t[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(t.slice(a, i + 1)); } catch (_e) { break; }
      }
    }
  }
  throw new Error("模型没回 JSON，它说的是：「" + t.slice(0, 100) + (t.length > 100 ? "…" : "") + "」");
}
// App 同名 pickField / isTrue / normHM / addMin
function pickField(o: any, keys: string[]): any {
  for (const k of keys) {
    if (o && o[k] != null && String(o[k]).trim() !== "") return o[k];
  }
  return "";
}
function isTrue(v: unknown): boolean { return v === true || /^(true|是|1)$/i.test(String(v || "").trim()); }
function normHM(v: unknown): string {
  const m = /(\d{1,2})\s*[:：点时.]\s*(\d{1,2})?/.exec(String(v || ""));
  if (!m) return "";
  return String(Math.min(23, +m[1])).padStart(2, "0") + ":" + String(Math.min(59, +(m[2] || 0))).padStart(2, "0");
}
function addMin(hm: string, n: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim()); if (!m) return hm;
  const t = Math.min(+m[1] * 60 + +m[2] + n, 23 * 60 + 59);
  return pad2(Math.floor(t / 60)) + ":" + pad2(t % 60);
}
// App 同名 parseDayResult
function parseDayResult(d: any, existing: NonNullable<GenKit["existing"]>, settings: { quietStart?: string; quietEnd?: string }, nowMs: number): GenDay {
  const schedRaw = pickField(d, ["schedule", "日程", "日程表"]);
  if (!Array.isArray(schedRaw)) throw new Error("日程缺失（模型返回的字段：" + Object.keys(d || {}).slice(0, 10).join("/") + "）");
  const sched: GenDay["schedule"] = schedRaw.slice(0, 10).map((it: any) => ({
    time: normHM(pickField(it, ["time", "时间", "at"])),
    end: normHM(pickField(it, ["end", "endTime", "结束", "到"])),
    title: String(pickField(it, ["title", "标题", "事项", "name"]) || ""),
    place: String(pickField(it, ["place", "地点", "位置", "在哪"]) || "").slice(0, 16),
    note: String(pickField(it, ["note", "备注", "细节", "desc"]) || ""),
    mood: String(pickField(it, ["mood", "情绪", "心情"]) || "").slice(0, 24),
    cost: Math.max(-40, Math.min(40, Math.round(+pickField(it, ["cost", "精力影响", "消耗"]) || 0))),
    busy: isTrue(pickField(it, ["busy", "顾不上", "忙"])),
  }));
  for (const it of existing) {
    const hit = sched.find((x) => x.time === it.startTime);
    if (!hit) sched.push({ time: String(it.startTime || ""), title: String(it.title || ""), place: it.location || "", note: it.location || "日程表上的安排", busy: it.lock === "busy" });
    else if (it.lock) hit.busy = it.lock === "busy";
  }
  sched.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  for (const it of sched) if (it.end && it.end <= it.time) it.end = "";
  const last = sched[sched.length - 1];
  const wake = normHM(pickField(d, ["wake", "起床", "wakeUp"])) || (sched[0] && sched[0].time) || String(settings.quietEnd || "");
  const bodyRaw = pickField(d, ["body", "身体", "状况"]);
  const bodyConds: GenDay["conds"] = (Array.isArray(bodyRaw) ? bodyRaw : []).slice(0, 2)
    .filter((b: any) => b && String(b.label || "").trim())
    .map((b: any) => ({
      mood: String(b.mood || b.label).trim().slice(0, 24),
      cause: String(b.label).trim().slice(0, 20),
      energyDelta: Math.max(-20, Math.min(20, Math.round(+b.energy || 0))),
      intensity: 60,
      halfLifeMin: Math.max(1, Math.min(12, Math.round(+b.hours || 4))) * 60,
      startAt: nowMs,
    }));
  const bed = normHM(pickField(d, ["bed", "睡觉", "bedtime"])) || (last ? addMin(last.end || last.time, last.end ? 30 : 90) : String(settings.quietStart || ""));
  return {
    wake: wake, bed: bed,
    mood: String(pickField(d, ["mood", "心情", "情绪"]) || ""),
    moodEmoji: String(pickField(d, ["moodEmoji", "emoji", "表情"]) || "🌙").slice(0, 4),
    energy: Math.max(0, Math.min(100, +pickField(d, ["energy", "精力", "体力"]) || 60)),
    doing: String(pickField(d, ["doing", "正在做", "当前"]) || ""),
    location: String(pickField(d, ["location", "位置", "地点"]) || ""),
    sleep: String(pickField(d, ["sleep", "睡眠", "昨晚"]) || "").slice(0, 40),
    schedule: sched,
    conds: bodyConds,
  };
}
// App 同名 buildImpulseInstruction
function buildImpulseInstruction(day: { mood: string; energy: number; schedule: unknown[] }, outlook: unknown[], nowHM: string, lines: string[],
  settings: { quota: number; quietStart: string; quietEnd: string; minGapMin: number; moodGate: boolean; anchorMorning: boolean; anchorSleep: boolean }, biasLine: string, threads: string[]): string {
  const anchors = [
    settings.anchorMorning ? "早上刚过免打扰那会儿，TA可能会想问一句早" : null,
    settings.anchorSleep ? "睡前那段，TA可能会想说句晚安或白天没说完的话" : null,
  ].filter(Boolean);
  return [
    "【后台系统任务，不是聊天：不要以角色口吻说话、不要直接写消息内容，只输出判断 JSON】",
    "你是当前角色的内心。现在是 " + nowHM + "。想一想：今天剩下的时间里，TA会在哪些时刻想给用户发消息？",
    "念头是TA自己冒出来的，不必挂在日程上——刚做完一件事想说、路上看见什么、忽然惦记、白天没聊完的话头、单纯想搭句话，都算；一件事也可以不产生任何念头。按TA的性格克制判断，宁可少也别硬凑。",
    '输出严格 JSON，第一个字符必须是 {，字段名一字不差：{"impulses":[{"time":"这个念头最想说出口的时刻HH:MM","until":"过了这个时刻这话就不新鲜了、不必再发HH:MM","about":"这个念头的由头（8字内，例：路过花店/刚开完会/昨晚那事没聊完）","sem":"接触类型：问候/关心/追话题/分享/惦记 选一","topic":"想聊的话题（8字内）","intent":"TA当时的第一人称心理动机（40字内，不写台词）","why":"为什么这会儿会想起（20字内）"}]}',
    "impulses 按时刻从早到晚排；一个也没有就给空数组，不要为了填满而编。",
    "until 是这个念头的保质期：接话头、约好的事可以短（半小时到一小时），单纯想分享的可以长（两三小时）。不写就按一个半小时算。",
    "TA今天的生活面（背景，不是候选时刻）：", JSON.stringify({ mood: day.mood, energy: day.energy, schedule: day.schedule }),
    "（energy 是TA刚醒时的基线，不是此刻的）",
    "", "今天剩下的时间长这样（按TA的日程逐段列出，end 是这段结束的时刻，空档也单列一行；精力越低越懒得开口，busy=true 那几段顾不上看手机，别把念头排在里面——排在它结束之后反而正好）：",
    JSON.stringify(outlook),
    lines.length ? "\n最近和用户的聊天（「我」=用户，「TA」=角色，从旧到新）：\n" + lines.join("\n") : null,
    lines.length ? "结合聊天氛围判断：正聊得火热就不必刻意再约时刻；有没接完的话头、刚闹过别扭、或很久没联系，都会真实影响TA想不想主动、以及动机的内容。动机要能接上最近聊的事，不要凭空另起炉灶。" : null,
    threads.length ? "\nTA心里还挂着这些事（约定快到点想打个气、过了点想问结果、到日子的想说一句、话头没接完想续上，都是很自然的由头）：\n" + threads.join("\n") : null,
    anchors.length ? "\n用户希望留意这几段：" + anchors.join("；") + "。想不起来就不用勉强。" : null,
    "", "约束：最多给 " + (settings.quota + 3) + " 个念头，今天最多真的发 " + settings.quota + " 条（多出来的会被记成「想过但没发」）；"
      + "时刻必须晚于 " + nowHM + "；免打扰时段 " + settings.quietStart + "–" + settings.quietEnd + " 内不要排"
      + (settings.minGapMin > 0 ? "；相邻两个念头至少隔 " + settings.minGapMin + " 分钟" : "") + "。",
    (settings.moodGate && day.energy < 30) ? "TA今天精力只有 " + day.energy + "%，很低。这种时候TA更想缩着，明显减少主动。" : null,
    biasLine || null,
  ].filter((s) => s !== null).join("\n");
}
// App 同名 chatExcerpt / unansweredStreak
function chatExcerpt(msgs: { role: string; c: string }[], maxLines: number): string[] {
  return msgs.slice(-(maxLines || 24)).map((m) =>
    (m.role === "user" ? "我：" : "TA：") + (m.c.length > 200 ? m.c.slice(0, 200) + "…" : m.c));
}
// 判断时回看几句：App 设置寄在 context.judgeLines，越界的值一律按默认算
function judgeLinesOf(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 24;
}
function unansweredStreak(msgs: { role: string; t: number }[], nowMs: number): number {
  let prevT: number | null = null, rounds = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") break;
    if (prevT === null || prevT - m.t > 3 * 60000) {
      if (nowMs - m.t >= 30 * 60000) rounds++;
    }
    prevT = m.t;
  }
  return rounds;
}
// App 同名 fitScore / calcScore（本地小时用 tz 换算）
function fitScore(fireAt: number, tz: number): number {
  const d = new Date(fireAt + tz * 60_000);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const g = (peak: number, sigma: number) => Math.exp(-Math.pow(h - peak, 2) / (2 * sigma * sigma));
  return Math.round(100 * Math.min(1, g(13, 3) * 0.75 + g(21, 2.5)));
}
function calcScore(fireAt: number, armedBefore: number, streak: number, lastArmedAt: number, tz: number,
  settings: { quota: number; maxUnanswered: number; minGapMin: number }) {
  const pq = Math.round(Math.min(100, armedBefore / Math.max(1, settings.quota) * 100));
  const mu = settings.maxUnanswered;
  const pr = Math.round(Math.min(100, mu > 0 ? streak / mu * 100 : streak * 25));
  let pg = 0;
  const gapMin = settings.minGapMin;
  if (gapMin > 0 && lastArmedAt) {
    const dist = (fireAt - lastArmedAt) / 60000;
    if (dist < gapMin * 2) pg = Math.round(Math.max(0, Math.min(100, (1 - dist / (gapMin * 2)) * 100)));
  }
  return { fit: fitScore(fireAt, tz), pq, pr, pg, press: Math.round(pq * 0.4 + pr * 0.4 + pg * 0.2) };
}
// App 同名 dayOutlook：本地 timeToMs/fmtHM 换成按 tz 的 UTC 算术。
// 念头不再挂日程节点，这里只给「今天剩下的时间长什么样」当模型自己挑时刻的依据。
// 按日程自己的边界走而不是固定网格采样——固定网格会漏掉夹在两点之间的短日程。
function dayOutlook(day: GenDay, planDate: string, tz: number, nowMs: number,
  settings: { quietStart: string; quietEnd: string }) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(planDate);
  const dayUtc = dm ? Date.UTC(+dm[1], +dm[2] - 1, +dm[3]) : NaN;
  const timeToMs = (hm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
    if (!m || !Number.isFinite(dayUtc)) return null;
    return dayUtc + (+m[1] * 60 + +m[2] - tz) * 60_000;
  };
  const inQuiet = (hm: string) => {
    const qs = settings.quietStart, qe = settings.quietEnd;
    if (!qs || !qe || qs === qe) return false;
    return qs < qe ? (hm >= qs && hm < qe) : (hm >= qs || hm < qe);
  };
  const bed = normHM(day.bed) || settings.quietStart || "";
  const wake = normHM(day.wake) || settings.quietEnd || "";
  const sw = bed && wake && bed !== wake ? { bed, wake, overnight: bed < wake } : null;
  const asleepAt = (hm: string) => !sw ? false : (sw.overnight ? (hm >= sw.bed && hm < sw.wake) : (hm >= sw.bed || hm < sw.wake));
  const endMs = (sw && timeToMs(sw.overnight ? "23:50" : sw.bed)) || timeToMs("23:00") || nowMs;
  const rows: { time: string; end: string; energy: number; doing: string; busy: boolean }[] = [];
  const push = (ms: number, doing: string, busy: boolean, end: string) => {
    const hm = hhmm(ms, tz);
    if (ms < nowMs || ms > endMs || inQuiet(hm) || asleepAt(hm)) return;
    rows.push({ time: hm, end: end || "", energy: guanianNow(day as GuanianDay, ms, settings.quietStart, settings.quietEnd).energy, doing, busy: !!busy });
  };
  let cursor = nowMs;
  for (const it of (day.schedule || [])) {
    const a = it && it.time ? timeToMs(String(it.time)) : null;
    if (!a) continue;
    const b = it.end ? timeToMs(String(it.end)) : null;
    if ((b || a) < nowMs) continue;
    if (a - cursor > 20 * 60_000) push(Math.round((Math.max(cursor, nowMs) + a) / 2), "空着", false, "");
    push(Math.max(a, nowMs), String(it.title || ""), !!it.busy, String(it.end || ""));
    cursor = Math.max(cursor, b || a);
  }
  if (endMs - cursor > 20 * 60_000) push(Math.round((Math.max(cursor, nowMs) + endMs) / 2), "睡前自己待着", false, "");
  return rows.slice(0, 16);
}

// 模板里最后一条用户消息是「[挂念] __CUSTOM_APP_INSTRUCTION__」，把占位符换成真正的指令。各家消息结构不同，逐段找字符串替换。
function fillTemplate(body: Record<string, unknown>, providerKind: ProviderKind, instruction: string): boolean {
  let hit = false;
  const fix = (text: string) => {
    if (!text.includes(GEN_PLACEHOLDER)) return text;
    hit = true;
    return text.split(GEN_PLACEHOLDER).join(instruction);
  };
  const walkParts = (parts: unknown) => {
    for (const part of (Array.isArray(parts) ? parts : [])) {
      const p = part as Record<string, unknown>;
      if (typeof p?.text === "string") p.text = fix(p.text);
    }
  };
  if (providerKind === "gemini") {
    for (const one of (Array.isArray(body.contents) ? body.contents : [])) walkParts((one as Record<string, unknown>)?.parts);
    return hit;
  }
  for (const one of (Array.isArray(body.messages) ? body.messages : [])) {
    const m = one as Record<string, unknown>;
    if (typeof m?.content === "string") m.content = fix(m.content);
    else walkParts(m?.content);
  }
  return hit;
}

// 与 App generateJson 一致：第一次没拿到 JSON 就追加严格指令再试一次
async function generateJsonWith(template: JobPayload, instruction: string, log: (line: string) => void,
  record?: (providerKind: ProviderKind, data: unknown) => Promise<void>): Promise<any> {
  const call = async (inst: string): Promise<string> => {
    const clone = JSON.parse(JSON.stringify(template.request)) as JobPayload["request"];
    if (!fillTemplate(clone.body, clone.providerKind, inst)) throw new Error("模板里找不到指令占位符");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
    try {
      const response = await fetch(clone.url, { method: "POST", headers: clone.headers, body: JSON.stringify(clone.body), signal: controller.signal });
      if (!response.ok) throw new Error(`模型 HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 160)}`);
      const data = await response.json();
      if (record) await record(clone.providerKind, data);
      return extractResponseText(clone.providerKind, data);
    } finally { clearTimeout(timeout); }
  };
  try { return parseModelJson(await call(instruction)); } catch (e) {
    log("首次生成未得到 JSON（" + (e instanceof Error ? e.message : String(e)) + "），追加严格指令重试");
    return parseModelJson(await call(instruction + "\n\n重要：只输出 JSON 本身，第一个字符必须是 {，最后一个字符必须是 }，不要任何解释、前言、思考过程或代码块标记。"));
  }
}

type GenDeps = {
  rest: (path: string, init?: RequestInit) => Promise<Response>;
  payloadKey: string; userId: string; characterId: string; planDate: string; planFilter: string;
  plan: PlanRow; context: PlanContext; kit: GenKit; nowMs: number;
};
// 到点生成 + 编排。失败只记 genTries/genError，cron 下一轮再来，最多 GEN_MAX_TRIES 次。
async function generateCloudDay(deps: GenDeps): Promise<void> {
  const { rest, payloadKey, userId, characterId, planDate, planFilter, plan, context, kit, nowMs } = deps;
  const tz = Number(kit.tz) || 0;
  const genLog: string[] = [];
  const log = (line: string) => { if (genLog.length < 40) genLog.push(line); };
  const tries = (Number(context.genTries) || 0) + 1;
  const patchPlan = (body: Record<string, unknown>, guard: boolean) => rest(
    guard && plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
    { method: "PATCH", headers: { Prefer: guard ? "return=representation" : "return=minimal" }, body: JSON.stringify(body) },
  ).catch(() => undefined);
  const armedKeys: string[] = [];
  try {
    // 借模板：daily / impulse 两份 push.freeze 冻的完整提示词，加上哨兵聊天快照（点亮预约要克隆它）
    const sentinelWakeId = typeof context.sentinelWakeId === "string" ? context.sentinelWakeId : "";
    const keys = [kit.tplDaily, kit.tplImpulse, sentinelWakeId ? `timedwake:${sentinelWakeId}` : ""].filter(Boolean) as string[];
    const jobsResponse = await rest(
      `push_jobs?user_id=eq.${encodeURIComponent(userId)}`
      + `&trigger_key=in.(${encodeURIComponent(keys.map(k => `"${k}"`).join(","))})`
      + "&select=id,trigger_key,status,execute_at,payload",
    );
    const jobRows = jobsResponse.ok ? await jobsResponse.json() as JobRow[] : [];
    jobRows.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
    const payloads = new Map<string, JobPayload>();
    for (const row of jobRows) {
      if (payloads.has(row.trigger_key)) continue;
      try { payloads.set(row.trigger_key, JSON.parse(await decryptPayload(row.payload, payloadKey)) as JobPayload); }
      catch { /* 单条解不开就算没有 */ }
    }
    const tplDaily = kit.tplDaily ? payloads.get(kit.tplDaily) : undefined;
    const tplImpulse = kit.tplImpulse ? payloads.get(kit.tplImpulse) : undefined;
    const tplChat = sentinelWakeId ? payloads.get(`timedwake:${sentinelWakeId}`) : undefined;
    if (!tplDaily || !tplImpulse) throw new Error("云端没有可借的提示词模板（App 打开一次会重新冻结）");
    const instruction = String(kit.instruction || "");
    if (!instruction) throw new Error("生成原料里没有指令");
    const existing = Array.isArray(kit.existing) ? kit.existing : [];
    const settings = {
      quota: Number(context.quota) || 3,
      quietStart: String(context.quietStart || ""), quietEnd: String(context.quietEnd || ""),
      minGapMin: Number(context.minGapMin) || 0, maxUnanswered: Number(context.maxUnanswered) || 0,
      moodGate: kit.moodGate !== false, anchorMorning: kit.anchorMorning === true, anchorSleep: kit.anchorSleep !== false,
    };

    // ── 生成TA的一天（与 App generateDay 同一份指令、同一套归一）
    const budgetTz = (await usageBudget(rest, userId)).tz;
    const record = (providerKind: ProviderKind, data: unknown) => usageAdd(rest, userId, budgetTz, "cloud-gen", providerKind, data);
    const raw = await generateJsonWith(tplDaily, instruction, log, record);
    const dayFull = parseDayResult(raw, existing, settings, nowMs);
    const day: GuanianDay & Record<string, unknown> = {
      tz, mood: dayFull.mood, energy: dayFull.energy, location: dayFull.location, doing: dayFull.doing,
      wake: dayFull.wake, bed: dayFull.bed,
      schedule: dayFull.schedule.map(it => ({ time: it.time, end: it.end || "", title: it.title, place: it.place || "", cost: +(it.cost || 0), mood: it.mood || "", busy: !!it.busy })),
      conds: dayFull.conds.map(c => ({ startAt: c.startAt, halfLifeMin: c.halfLifeMin, intensity: c.intensity, energyDelta: c.energyDelta, mood: c.mood, cause: c.cause })),
    };
    log("生成今日生活面：" + dayFull.schedule.length + " 条日程（日程表已定 " + existing.length + " 条），作息 " + dayFull.wake + " 起 " + dayFull.bed + " 睡，心情「" + dayFull.mood + "」"
      + (dayFull.sleep ? "，昨晚" + dayFull.sleep : "") + (dayFull.conds.length ? "，身上：" + dayFull.conds.map(c => c.cause).join("、") : "")
      + (dayFull.mood ? "" : "（心情为空，模型顶层字段：" + Object.keys(raw || {}).slice(0, 10).join("/") + "）"));

    // ── 编排心动时刻（与 App orchestrate 同一套候选、同一份判断指令、同一套数值约束）
    const outlook = dayOutlook(dayFull, planDate, tz, nowMs, settings);
    const items: Record<string, unknown>[] = [];
    let chatUsed = 0;
    if (!outlook.length) {
      log("编排：今天剩下的时间全在免打扰或睡眠里");
    } else {
      const mirrorResponse = await rest(
        `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
        + `&character_id=eq.${encodeURIComponent(characterId)}`
        + `&select=role,content,message_at&order=message_at.desc&limit=${judgeLinesOf(context.judgeLines) + 20}`,
      );
      const mirrorRows = mirrorResponse.ok ? (await mirrorResponse.json() as { role: string; content: string; message_at: string }[]).reverse() : [];
      const chat = mirrorRows
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role, t: Date.parse(m.message_at) || 0, c: String(m.content || "").replace(/\s+/g, " ").trim() }))
        .filter(m => m.c)
        .sort((a, b) => a.t - b.t);
      const streak0 = unansweredStreak(chat, nowMs);
      const lines = chatExcerpt(chat, judgeLinesOf(context.judgeLines));
      chatUsed = lines.length;
      if (lines.length) log("已读入最近 " + lines.length + " 句聊天作为判断上下文" + (streak0 ? "（当前连续 " + streak0 + " 轮未回）" : ""));
      const parsed = await generateJsonWith(tplImpulse, buildImpulseInstruction(dayFull, outlook, hhmm(nowMs, tz), lines, settings, String(context.bias || ""), threadLines(context, nowMs, tz)), log, record);
      const raw: Impulse[] = Array.isArray(parsed?.impulses) ? parsed.impulses : [];
      log("TA提了 " + raw.length + " 个念头：" + (raw.map(x => normHM(x?.time) + "·" + String(x?.about || "")).join("，") || "（一个都没有）"));

      const wakePrefix = String(context.wakePrefix || "");
      const armWake = async (fireAt: number, intent: string): Promise<{ id: string; reason: string }> => {
        if (!tplChat) return { id: "", reason: "云端没有可借的聊天模板（哨兵预约不在了）" };
        if (!wakePrefix) return { id: "", reason: "没有预约 id 前缀" };
        const wakeId = `${wakePrefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const clone = JSON.parse(JSON.stringify(tplChat)) as JobPayload;
        const note = `[系统备忘：这不是对方发来的消息。到点了，你现在想主动跟对方说的是——${intent}。`
          + "顺着你们刚才聊的往下说，别重复已经说过的话，也别提起这条备忘。]";
        if (!appendIntentNote(clone.request.body, clone.request.providerKind, note)) return { id: "", reason: "聊天模板结构不认识" };
        retuneWakeSnapshot(clone.request.body, clone.request.providerKind, intent, Math.max(1, Math.round((fireAt - Date.now()) / 60_000)));
        clone.merge = { ...(clone.merge || {}), ...(settings.maxUnanswered > 0 ? { cooldownRounds: settings.maxUnanswered } : {}) };
        const insert = await rest("push_jobs", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify([{
            id: `job_${crypto.randomUUID()}`, user_id: userId, trigger_key: `timedwake:${wakeId}`, kind: "timed_task",
            execute_at: new Date(fireAt + 15_000).toISOString(), status: "pending",
            payload: await encryptPayload(JSON.stringify(clone), payloadKey),
          }]),
        });
        if (!insert.ok) return { id: "", reason: `预约写入失败 HTTP ${insert.status}` };
        armedKeys.push(`"timedwake:${wakeId}"`);
        return { id: wakeId, reason: "" };
      };

      // 模型自己挑的时刻说了不算：免打扰、睡眠窗、时刻去重、最小间隔、额度，这五道照样硬拦
      const dm2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(planDate);
      const dayUtc2 = dm2 ? Date.UTC(+dm2[1], +dm2[2] - 1, +dm2[3]) : NaN;
      const hmToMs = (hm: string): number | null => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
        if (!m || !Number.isFinite(dayUtc2)) return null;
        return dayUtc2 + (+m[1] * 60 + +m[2] - tz) * 60_000;
      };
      const qs2 = settings.quietStart, qe2 = settings.quietEnd;
      const inQuiet2 = (hm: string) => (!qs2 || !qe2 || qs2 === qe2) ? false : (qs2 < qe2 ? (hm >= qs2 && hm < qe2) : (hm >= qs2 || hm < qe2));
      const armedAt: number[] = [];
      let armedCount = 0;
      const prevArmed = (t: number) => armedAt.filter(x => x < t).sort((a, b) => b - a)[0] || 0;
      const taken = new Set<string>();
      const gapMs = Number(settings.minGapMin || 0) * 60_000;
      for (const x of raw.slice(0, settings.quota + 3)) {
        const hm = normHM(x?.time), ms = hm ? hmToMs(hm) : null;
        if (!hm || !ms || ms < nowMs + 3 * 60_000) { log("念头丢弃：时刻不合法或已过点（" + String(x?.time || "") + "）"); continue; }
        if (inQuiet2(hm) || guanianAsleep(dayFull as GuanianDay, hm, qs2, qe2)) { log("念头丢弃：" + hm + " 落在免打扰或睡着的时段"); continue; }
        if (taken.has(hm)) { log("念头丢弃：" + hm + " 已经有一个了"); continue; }
        taken.add(hm);
        const uhm = normHM(x?.until), ums = uhm ? hmToMs(uhm) : null;
        const about = String(x?.about || "想起用户").slice(0, 12);
        const item: Record<string, unknown> = {
          time: hm, fireAt: ms, until: ums && ums > ms ? Math.min(ums, ms + 6 * 3600_000) : ms + 90 * 60_000,
          source: about, act: true,
          why: String(x?.why || ""), intent: String(x?.intent || ""), delivery: "", reason: "", wakeId: "",
          sem: String(x?.sem || ""), topic: String(x?.topic || ""),
          score: calcScore(ms, armedCount, streak0, prevArmed(ms), tz, settings),
        };
        if (armedCount >= settings.quota) { item.act = false; item.why = "超出今日额度"; }
        else if (gapMs && armedAt.some(t => Math.abs(ms - t) < gapMs)) { item.act = false; item.why = "离上一个起念太近"; }
        if (item.act) {
          const intent = String(item.intent || about);
          const res = await armWake(ms, intent);
          if (res.id) {
            item.wakeId = res.id; item.delivery = "push"; item.reason = "";
            log(hm + " 起念 ✓ 已预约离线推送：" + intent);
          } else {
            // 和本地「仅本地」不同：云端没有本地路径可退，起念留着，App 打开时能看到原因
            item.delivery = ""; item.reason = res.reason;
            log(hm + " 起念 ✓ 但没挂上预约（" + res.reason + "）：" + intent);
          }
          armedCount++; armedAt.push(ms);
        } else {
          log(hm + " 未起念：" + String(item.why));
        }
        item.hist = [{ at: nowMs, kind: item.act ? "plan" : "skip", note: item.act ? item.intent : (item.why || "TA这会儿不想"), by: "cloud" }];
        items.push(item);
      }
      items.sort((a, b) => Number(a.fireAt) - Number(b.fireAt));
      log(armedCount ? "TA今天有 " + armedCount + " 个想起你的时刻" : "TA今天想安静地过");
    }

    const saved = await patchPlan({
      items,
      decisions: [],
      recheck_count: 0,
      last_recheck_at: new Date().toISOString(),
      context: {
        ...context,
        mood: dayFull.mood, energy: String(dayFull.energy),
        day, dayFull, genKit: null,
        generatedBy: "cloud", genAt: nowMs, genLog, genChatUsed: chatUsed, genTries: tries, genError: "", selfUsed: 0,
      },
    }, true);
    const rows = saved?.ok ? await saved.json().catch(() => []) as unknown[] : [];
    if (Array.isArray(rows) && rows.length > 0) return;
    // 生成期间 App 自己生成并上传了计划：以 App 为准，刚挂的预约撤掉，别成孤儿
    if (armedKeys.length) {
      await rest(`push_jobs?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending`
        + `&trigger_key=in.(${encodeURIComponent(armedKeys.join(","))})`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }),
      }).catch(() => undefined);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("云端生成失败：" + msg);
    // 也带乐观锁：生成期间 App 自己生成并上传了计划的话，这份带 genKit 的旧 context 盖回去会让云端再生成一次
    await patchPlan({
      last_recheck_at: new Date().toISOString(),
      context: { ...context, genTries: tries, genError: msg.slice(0, 300), genLog },
    }, true);
  }
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 200 });

  const { userId, characterId, planDate, token } = await req.json().catch(() => ({})) as {
    userId?: string; characterId?: string; planDate?: string; token?: string;
  };
  if (!userId || !characterId || !planDate || !token) return new Response("bad request", { status: 400 });

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });

  const secretResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key&limit=1");
  const secretRows = secretResponse.ok
    ? await secretResponse.json() as { cron_secret?: string | null; payload_key?: string | null }[]
    : [];
  const cronSecret = secretRows[0]?.cron_secret || "";
  const payloadKey = secretRows[0]?.payload_key || "";
  if (!cronSecret || String(token) !== cronSecret) return new Response("forbidden", { status: 403 });
  if (!payloadKey) return new Response("payload_key missing", { status: 200 });

  const planFilter = `push_recheck_plans?user_id=eq.${encodeURIComponent(userId)}`
    + `&character_id=eq.${encodeURIComponent(characterId)}`
    + `&plan_date=eq.${encodeURIComponent(planDate)}`;

  const planResponse = await rest(
    `${planFilter}&select=session_id,context,items,decisions,last_recheck_at,recheck_count,updated_at&limit=1`,
  );
  const planRows = planResponse.ok ? await planResponse.json() as PlanRow[] : [];
  const plan = planRows[0];
  if (!plan) return new Response("no plan", { status: 200 });

  const nowMs = Date.now();
  const lastRecheckMs = plan.last_recheck_at ? Date.parse(plan.last_recheck_at) : NaN;
  const context = plan.context || {};

  // 云端生成：这一行还只是 App 寄来的生成原料（没有 day，也没有时刻），到点才动，
  // 生成之前不走下面的复核——没有生活面的复核和自发起念都无从判起。
  const kit = context.genKit && typeof context.genKit === "object" ? context.genKit : null;
  if (kit && context.generatedBy !== "cloud") {
    const tz = Number(kit.tz) || 0;
    const local = new Date(nowMs + tz * 60_000);
    const localDate = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
    // 还没到点的原料行也记一下 last_recheck_at，别让它一直排在 cron 派发队列最前面挤掉别的计划
    const later = (note: string) => rest(planFilter, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_recheck_at: new Date().toISOString() }),
    }).catch(() => undefined).then(() => new Response(note, { status: 200 }));
    if (localDate < planDate) return later("gen: not that day yet");
    if (localDate > planDate) return later("gen: day passed");
    if (hhmm(nowMs, tz) < String(kit.autoGenAt || "07:30")) return later("gen: before autoGenAt");
    if ((Number(context.genTries) || 0) >= GEN_MAX_TRIES) return new Response("gen: gave up", { status: 200 });
    const overUsage = usageExceeded(await usageBudget(rest, userId));
    if (overUsage) return later("gen: usage cap");
    if (Number.isFinite(lastRecheckMs) && nowMs - lastRecheckMs < 10 * 60_000) return new Response("gen: in progress", { status: 200 });
    // 先占坑：last_recheck_at 一写，cron 25 分钟内不会再派同一行
    const claim = await rest(
      plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
      { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ last_recheck_at: new Date().toISOString() }) },
    ).catch(() => undefined);
    const claimed = claim?.ok ? await claim.json().catch(() => []) as unknown[] : [];
    if (!Array.isArray(claimed) || claimed.length === 0) return new Response("gen: plan changed", { status: 200 });
    const work = generateCloudDay({ rest, payloadKey, userId, characterId, planDate, planFilter, plan, context, kit, nowMs }).catch(() => undefined);
    const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work);
    else await work;
    return new Response("gen: started", { status: 200 });
  }
  // 过了日子的行还会在 cron 的 36 小时窗口里待一天：没有待发时刻，但起念门可能还开着，
  // 每轮都可能白调一次模型，产出又全因为不是今天而被丢掉。
  const dayTz = context.day && typeof context.day === "object" ? Number((context.day as { tz?: number }).tz) : NaN;
  const rowTz = Number.isFinite(dayTz) ? dayTz : (kit ? Number(kit.tz) || 0 : NaN);
  if (Number.isFinite(rowTz) && usageLocalDay(nowMs, rowTz) > planDate) {
    await rest(planFilter, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_recheck_at: new Date().toISOString() }) }).catch(() => undefined);
    return new Response("plan date passed", { status: 200 });
  }

  const gate = (key: keyof typeof GATE_DEF): number => {
    const value = Number(context[key]);
    return Number.isFinite(value) && value >= 0 ? value : GATE_DEF[key];
  };

  const items = Array.isArray(plan.items) ? plan.items : [];
  const pending = items.filter(item => Number(item.fireAt) > nowMs + LEAD_MS);
  const allDecisions = Array.isArray(plan.decisions) ? plan.decisions : [];
  const priorDecisions = allDecisions.filter(d => (d as { kind?: string }).kind !== "gate");

  // 门禁：全部过了才轮到下面那一次裁决调用。每一道都只读已有数据，不调模型，
  // 所以可以放心让 cron 派得勤，甚至将来由客户端逐条消息触发。
  //
  // 分两组：判决是重判已排好的时刻，没有待发时刻就无从判起；起念是新开一个时刻，
  // 跟有没有待发时刻无关——日程走完的晚上恰恰最该起念，两者共用一道闸时它永远轮不上。
  // 频率仍然共享（间隔、每日上限）：两组共用同一次裁决调用，分开算等于放开调用次数。
  const litCount = items.filter(item => item.act).length;
  const horizon = gate("gateHorizonMin") * 60_000;
  const nearest = pending.length > 0 ? Math.min(...pending.map(item => Number(item.fireAt))) - nowMs : Infinity;
  const canJudge = pending.length > 0 && (horizon <= 0 || nearest <= horizon);
  const canImpulse = litCount < Number(context.quota ?? 3);
  // 自发起念：没有新聊天也可以起念，由头是TA自己这一天里的事——刚做完一件有分量的日程，
  // 或者双方安静太久。每一次都是一次裁决调用，所以另有每日上限（selfImpulseCap），
  // 用掉的次数记在 context.selfUsed，App 上传计划时会原样带回来，重新编排才清零。
  const day = context.day && typeof context.day === "object" ? context.day : null;
  const selfUsed = Number(context.selfUsed) || 0;
  let selfReason = "";
  let threadNudged: { id: string; mark: string; reason: string } | null = null;
  let budgetTz = 0;
  // 生活轮在门禁之前：不花模型、不看有没有新聊天。掷完的标记和发圈账直接落库——
  // 不走 touch，last_recheck_at 是裁决的印记，掷骰子不该让门禁以为刚判过。
  const life = lifeRoll(context, nowMs);
  if (life) {
    Object.assign(context, life.patch);
    if (life.post) priorDecisions.push({ at: nowMs, kind: "post", note: `想发条朋友圈——${life.post.hint}`, by: "cloud" });
    await rest(planFilter, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ context, ...(life.post ? { decisions: priorDecisions.slice(-60) } : {}) }),
    }).catch(() => undefined);
    if (life.post) console.log("[push-recheck] 生活轮起意发圈：" + life.post.hint);
  }
  const blocked = await (async (): Promise<string> => {
    if (Number.isFinite(lastRecheckMs) && nowMs - lastRecheckMs < gate("gateGapMin") * 60_000) return "离上次裁决还不够久";
    const budget = await usageBudget(rest, userId);
    budgetTz = budget.tz;
    const over = usageExceeded(budget);
    if (over) return over;
    if ((plan.recheck_count || 0) >= gate("gateDailyCap")) return "今天的裁决次数用完了";
    if (!canJudge && !canImpulse) {
      if (pending.length === 0) return "今天没有还没到点的时刻，今日额度也满了";
      return `最近的时刻还在 ${Math.round(nearest / 60_000)} 分钟以外，今日额度也满了`;
    }

    // 没新消息就没有新信息，再判一次只是烧额度。首次复核回看 6 小时，
    // 别把开机前的对话全算成"新"。
    const sinceMs = Number.isFinite(lastRecheckMs) ? lastRecheckMs : nowMs - 6 * 3600_000;
    const freshResponse = await rest(
      `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
      + `&character_id=eq.${encodeURIComponent(characterId)}`
      + "&role=eq.user"
      + `&message_at=gt.${encodeURIComponent(new Date(sinceMs).toISOString())}`
      + "&select=message_at&order=message_at.desc&limit=20",
    );
    const freshRows = freshResponse.ok ? await freshResponse.json() as { message_at: string }[] : [];
    if (freshRows.length < Math.max(1, gate("gateMinMsgs"))) {
      const quiet = "上次裁决之后你没说几句";
      if (!canImpulse || !day || gate("selfImpulseCap") <= 0) return quiet;
      if (selfUsed >= gate("selfImpulseCap")) return `${quiet}，今天的自发起念也用完了`;
      const qs = String(context.quietStart || ""), qe = String(context.quietEnd || "");
      const now = guanianNow(day, nowMs, qs, qe);
      if (qs && qe && qs !== qe && (qs < qe ? (now.hm >= qs && now.hm < qe) : (now.hm >= qs || now.hm < qe))) return `${quiet}，现在是免打扰时段`;
      if (now.asleep) return `${quiet}，TA在睡觉`;
      // 随用随判模式下自发起念是主路而不是兜底：任何刚做完的日程都算由头，安静判据
      // 每过一个周期都能再想一次。次数由 selfImpulseCap、gateGapMin 和下面的配速兜着。
      const live = Number(context.impulseMode) === 1;
      const silenceMs = Math.max(30, Number(context.selfSilenceMin ?? 180)) * 60_000;
      // 配速：随用随判只看「此刻」，没有全天视野，不配速会上午就把额度用光。
      // 允许用掉的额度 = 今天已过去的比例 × quota，至少放开 1 个。
      if (live && day) {
        const tzM = Number(day.tz) || 0;
        const localNow = new Date(nowMs + tzM * 60_000);
        const midnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - tzM * 60_000;
        const hmMs = (hm: string) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
          return m ? midnight + (+m[1] * 60 + +m[2]) * 60_000 : 0;
        };
        const dayStart = hmMs(String(day.wake || context.quietEnd || "07:00"));
        let dayEnd = hmMs(String(day.bed || context.quietStart || "23:00"));
        if (dayEnd <= dayStart) dayEnd += 86_400_000; // 过零点才睡
        const span = dayEnd - dayStart;
        if (span > 0) {
          const frac = Math.max(0, Math.min(1, (nowMs - dayStart) / span));
          const allowed = Math.max(1, Math.ceil((context.quota ?? 3) * frac));
          if (litCount >= allowed) return `按今天的节奏，这会儿最多起 ${allowed} 个念头，已经有 ${litCount} 个了`;
        }
      }
      // 由头三（最具体，先看）：账本里的约定快到点 / 刚过点、到日子了
      const nudge = threadNudge(context, nowMs, Number(day.tz) || budgetTz || 0);
      if (nudge) { selfReason = nudge.reason; threadNudged = nudge; return ""; }
      // 由头一：上次裁决之后新开始了一条日程（严格模式还要求耗神/回血明显或有情绪余味）
      const tzMs = (Number(day.tz) || 0) * 60_000;
      const sameLocalDay = Number.isFinite(lastRecheckMs)
        && Math.floor((lastRecheckMs + tzMs) / 86_400_000) === Math.floor((nowMs + tzMs) / 86_400_000);
      const sinceHM = sameLocalDay ? guanianNow(day, lastRecheckMs, qs, qe).hm : "00:00";
      const weighty = now.done && String(now.done.time) > sinceHM
        && (live || Math.abs(Number(now.done.cost) || 0) >= 15 || !!now.done.mood);
      if (weighty) { selfReason = `刚${now.done!.title || "做完一件事"}`; return ""; }
      // 由头二：双方都安静太久。要有过对话才算，从没聊过的不算「安静」
      const lastAnyResponse = await rest(
        `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
        + `&character_id=eq.${encodeURIComponent(characterId)}`
        + "&select=message_at&order=message_at.desc&limit=1",
      );
      const lastAny = lastAnyResponse.ok ? await lastAnyResponse.json() as { message_at: string }[] : [];
      const lastAnyMs = Date.parse(lastAny[0]?.message_at || "");
      const silentMs = Number.isFinite(lastAnyMs) ? nowMs - lastAnyMs : 0;
      // 严格模式一段安静只起一次念；随用随判每过一个安静周期都可以再想一次
      if (silentMs >= silenceMs && (live || !Number.isFinite(lastRecheckMs) || lastRecheckMs < lastAnyMs + silenceMs)) {
        const mins = Math.round(silentMs / 60_000);
        selfReason = mins >= 120 ? `已经 ${Math.round(mins / 60)} 小时没联系` : `已经 ${mins} 分钟没联系`;
        return "";
      }
      return quiet;
    }
    const freshMs = gate("gateFreshMin") * 60_000;
    const lastMsgMs = Date.parse(freshRows[0]?.message_at || "");
    if (freshMs > 0 && Number.isFinite(lastMsgMs) && nowMs - lastMsgMs < freshMs) return "你才刚说完，等一下再判";
    return "";
  })();

  if (blocked) {
    // 拦截原因写回 decisions：不带 time，App 合并裁决时会跳过它，只当诊断用。
    // 原因没变就不写——cron 每半小时来一次，没必要每次都动这一行。
    const prev = allDecisions.find(d => (d as { kind?: string }).kind === "gate") as { note?: string } | undefined;
    if (prev?.note !== blocked) {
      await rest(
        plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            decisions: [...priorDecisions, { at: nowMs, kind: "gate", note: blocked, by: "cloud" }].slice(-60),
          }),
        },
      ).catch(() => undefined);
    }
    return new Response(blocked, { status: 200 });
  }

  // 先占坑再干活：后面任何一步失败都不会让 cron 每 30 分钟原地重试同一份计划。
  const touch = (extra: Record<string, unknown> = {}, guard = false) => rest(
    // 乐观锁：这一轮手里的 items 是几十秒前读到的，期间 App 重新编排会整份覆盖这行，
    // 无条件写回就把新计划打回旧的。带上读到的 updated_at，被改过就一行也匹配不上。
    guard && plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
    {
      method: "PATCH",
      headers: { Prefer: guard ? "return=representation" : "return=minimal" },
      // 只动 last_recheck_at：updated_at 留给「App 上传计划」，
      // 复核自己刷新它的话，cron 的 36 小时派发窗口就永远不会过期。
      body: JSON.stringify({ last_recheck_at: new Date().toISOString(), ...extra }),
    },
  ).catch(() => undefined);
  await touch();

  const run = async (): Promise<void> => {
    // 时区：计划里的 time 是用户本地 HH:MM，fireAt 是绝对毫秒。两者一减就还原出本地偏移，
    // 后面给临时起念算时刻直接复用，不必猜数据库时区。
    // 挑第一条 time 合法的当基准；一条都没有就退回 UTC，同时不许云端起念——
    // 临时起念的绝对时刻全靠这个基准换算，基准不可信只会把消息发到错的钟点。
    // 用 items 而不是 pending：日程走完的晚上 pending 是空的，但今天已经过点的时刻
    // 一样能还原出时区偏移，起念照样算得出绝对时刻。
    const anchor = items.find(item => /^\d{1,2}:\d{2}$/.test(item.time)) || items[0];
    if (!anchor) return;
    const anchorTrusted = /^\d{1,2}:\d{2}$/.test(anchor.time);
    const anchorLocal = anchorTrusted
      ? Number(anchor.time.split(":")[0]) * 60 + Number(anchor.time.split(":")[1])
      : new Date(anchor.fireAt).getUTCHours() * 60 + new Date(anchor.fireAt).getUTCMinutes();
    const anchorUtc = new Date(anchor.fireAt).getUTCHours() * 60 + new Date(anchor.fireAt).getUTCMinutes();
    let offsetMin = anchorLocal - anchorUtc;
    if (offsetMin > 720) offsetMin -= 1440;
    if (offsetMin < -720) offsetMin += 1440;

    // 快照模板：优先拿今天还没发的那几条预约。它们的 payload 里冻着上游地址和密钥，
    // 裁决调用和后面的点亮都靠它——本函数自己不持有任何模型凭据。
    // 哨兵预约（App 编排时挂的、48 小时后才到点的模板）也算在内：一个时刻都没点亮的日子全靠它。
    const sentinelWakeId = typeof context.sentinelWakeId === "string" ? context.sentinelWakeId : "";
    const wakeKeys = items.map(item => item.wakeId).concat(sentinelWakeId).filter(Boolean).map(id => `"timedwake:${id}"`);
    let found: JobPayload | null = null;
    const jobsByKey = new Map<string, JobRow>();
    if (wakeKeys.length > 0) {
      const jobsResponse = await rest(
        `push_jobs?user_id=eq.${encodeURIComponent(userId)}`
        + `&trigger_key=in.(${encodeURIComponent(wakeKeys.join(","))})`
        + "&select=id,trigger_key,status,execute_at,payload",
      );
      const jobRows = jobsResponse.ok ? await jobsResponse.json() as JobRow[] : [];
      for (const row of jobRows) jobsByKey.set(row.trigger_key, row);
      // 待发的快照最新，已发过的是今早的上下文——克隆和裁决都优先用前者。
      jobRows.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
      for (const row of jobRows) {
        if (found) break;
        try {
          found = JSON.parse(await decryptPayload(row.payload, payloadKey)) as JobPayload;
        } catch { /* 单条解不开就换下一条 */ }
      }
    }
    if (!found) return;
    const template = found;

    const mirrorResponse = await rest(
      `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
      + `&character_id=eq.${encodeURIComponent(characterId)}`
      + `&select=role,content,message_at&order=message_at.desc&limit=${judgeLinesOf(context.judgeLines)}`,
    );
    const mirrorRows = mirrorResponse.ok
      ? (await mirrorResponse.json() as { role: string; content: string; message_at: string }[]).reverse()
      : [];

    // 免打扰和最小间隔在提示词里说过，但模型说了不算：和 App 本地一样再硬拦一道。
    const inQuiet = (hm: string) => {
      const qs = context.quietStart || "";
      const qe = context.quietEnd || "";
      if (day && guanianAsleep(day, hm, qs, qe)) return true; // 睡着的时段和免打扰一样硬拦
      if (!qs || !qe || qs === qe) return false;
      return qs < qe ? (hm >= qs && hm < qe) : (hm >= qs || hm < qe);
    };
    const tooClose = (fireAt: number, list: PlanItem[], self?: PlanItem) => {
      const gap = Number(context.minGapMin || 0) * 60_000;
      if (!gap) return false;
      return list.some(other => other.act && other !== self && Math.abs(other.fireAt - fireAt) < gap);
    };
    const characterName = template.notify?.title || "TA";
    const chatLines = mirrorRows
      .map(row => `${row.role === "user" ? "用户" : characterName}（${hhmm(Date.parse(row.message_at), offsetMin)}）：${String(row.content || "").slice(0, 200)}`)
      .join("\n");
    const planLines = pending
      .map(item => `- ${item.time}｜${item.source}｜${item.act ? "已点亮" : "未点亮"}｜意图：${item.intent || "（无）"}｜理由：${item.why || "（无）"}`)
      .join("\n");

    // 自发起念这轮没有新聊天，判决无从谈起：只问「此刻TA自己想不想找用户」
    const judge = canJudge && !selfReason;
    const threadsOn = Array.isArray(context.threads);
    // 发朋友圈不占私聊额度，但有自己的每日上限；免打扰和睡觉由门禁那层先挡（自发那轮）或由用户在聊天这件事本身证明TA醒着
    const moBudget = momentsBudget(context, nowMs, day ? Number(day.tz) || 0 : 0);
    const canPost = moBudget.ok;
    const threadLinesNow = threadsOn ? threadLines(context, nowMs, offsetMin) : [];
    const now = day ? guanianNow(day, nowMs, context.quietStart, context.quietEnd) : null;
    const stateLine = now
      ? `此刻的状态：${now.asleep ? "在睡觉" : "在" + (now.doing || "没什么特别的")}${now.step ? "（" + now.step + "）" : ""}，情绪「${now.mood}」，精力 ${now.energy}%${now.next ? "，接下来 " + now.next : ""}。`
      : (context.mood || context.energy ? `今天的状态：心情「${context.mood || "普通"}」，精力「${context.energy || "普通"}」。` : "");
    const prompt = [
      `你现在是「${characterName}」，在盘算今天剩下的时间要不要主动联系用户。现在是本地时间 ${hhmm(nowMs, offsetMin)}。`,
      context.bias ? `你的性格倾向：${context.bias}` : "",
      stateLine,
      affectionLine(context.affection),
      `规矩：今天最多主动 ${context.quota ?? 3} 次（已点亮 ${litCount} 次）；`
      + `${context.quietStart || "23:00"}–${context.quietEnd || "07:00"} 不打扰；两次之间至少隔 ${context.minGapMin ?? 90} 分钟。`,
      "",
      selfReason ? "最近和用户的对话（这之后没有新消息）：" : "刚刚和用户的对话：",
      chatLines || "（这段时间没有对话记录）",
      "",
      judge ? "今天剩下的计划时刻：" : (selfReason ? "" : "今天排好的时刻都已经过点了，没有要重判的。"),
      judge ? planLines : "",
      "",
      threadsOn && threadLinesNow.length ? "你心里还挂着的事：\n" + threadLinesNow.join("\n") : "",
      selfReason
        ? `没有新对话。由头是你自己这边的事：${selfReason}。想一想此刻的你会不会想找用户说点什么——`
          + "分享刚发生的、忽然想起TA、单纯想搭句话都行；但不想说、或者上面聊到的事已经了了，就老实写 []，"
          + "不要为了发而发。真要发的话时刻定在接下来 5 到 40 分钟之间，until 给这话的保质期（半小时到两三小时）。"
        : canJudge
        ? "根据刚才聊过的内容重新判断每个时刻：聊过的话题已经了了就别再提，"
          + "用户说了忙/情绪不好就收敛，聊到一半没说完或约好了要说的事可以点亮"
          + (canImpulse ? "甚至新加一个时刻。" : "。")
        : "只看刚才聊的内容里有没有值得临时起一个新念头的事：聊到一半没说完的话头、"
          + "约好了要说的、答应了要问的。只是随口聊到、没落实的事不算。",
      "只输出 JSON，不要任何解释：",
      "{"
      + (judge
        ? '"decisions":[{"time":"HH:MM","act":true,"sem":"关心|分享|约定|闲聊","topic":"一句话主题","why":"你为什么这么定","intent":"到点时你想说的事，一句话","defer":"只是这个点不合适、话还想说时填今天更晚的HH:MM，否则空字符串"}]'
        : '"decisions":[]')
      + ","
      + (canImpulse
        ? '"extra":[{"time":"HH:MM","until":"过了这个时刻这话就不新鲜了HH:MM","about":"这个念头的由头（8字内）","intent":"想说的事","why":"为什么现在加"}]'
        : '"extra":[]')
      + (threadsOn && !selfReason
        ? ',"keep":[{"kind":"topic或promise或date","text":"一句话（20字内）","when":"promise/date 必填：YYYY-MM-DD HH:MM、HH:MM 或 MM-DD；topic 留空"}],"settle":["已了结的账本 id"]'
        : "")
      + (canPost ? ',"post":{"hint":"想发的朋友圈由头或大意（30字内）"}或null' : "")
      + "}",
      threadsOn && !selfReason ? THREAD_TASK : "",
      judge ? "decisions 只写你要改的时刻（其余的保持原样就不用写）。" : "decisions 一律写 []。",
      judge ? `改约：act 写 false 时，如果只是这个时刻不合适（刚聊完太密、这话晚点说更合适、这会儿说了会打断对方），而话本身还想说，就在 defer 里填今天更晚的 HH:MM，整个念头挪过去、不占新额度；真的不想说了才把 defer 留空。到点正忙或在睡觉不用你操心，系统会自动顺延，别为这个改约。只能挪到这个念头的保质期（until）之前——过了那个点这话就不新鲜了，宁可作罢。` : "",
      canImpulse ? "extra 最多 1 条，没有就写 []。" : "今日额度已满，extra 一律写 []。",
      canPost
        ? `post：如果此刻更想发一条朋友圈而不是私聊（晒一下刚做的事、随手记一句、发个感慨——给所有人看的，不是说给用户听的），就在 post.hint 里写想发的由头或大意（30字内），由系统按你的人设成文。这周已发 ${moBudget.weekN} 条。私聊和发圈可以只要一个，也可以都不要；不想发就写 null。`
        : "",
    ].filter(Boolean).join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let judgeText = "";
    try {
      const response = await fetch(template.request.url, {
        method: "POST",
        headers: template.request.headers,
        body: JSON.stringify(buildJudgeBody(template.request, prompt)),
        signal: controller.signal,
      });
      if (!response.ok) return;
      const judgeData = await response.json();
      await usageAdd(rest, userId, budgetTz, "cloud-recheck", template.request.providerKind, judgeData);
      judgeText = extractResponseText(template.request.providerKind, judgeData);
    } catch {
      return;
    } finally {
      clearTimeout(timeout);
    }

    // 门禁只放行了其中一组时，另一组的返回一律丢掉——提示词里已经要求写 []，
    // 但模型不一定听话，这里是硬拦。
    const judged = parseJudgeJson(judgeText);
    const decisions = judge ? judged.decisions : [];
    const extra = canImpulse ? judged.extra : [];
    // 账本改动（自发起念那轮不让模型记账，只标「这个由头提过了」）
    let threadsNext: Thread[] | null = threadsOn && !selfReason ? applyThreads(context, judged.keep, judged.settle, nowMs, offsetMin, (s) => console.log("[push-recheck] " + s)) : null;
    if (threadNudged) {
      const base = threadsNext || (Array.isArray(context.threads) ? context.threads.map(t => ({ ...t })) : []);
      const t = base.find(x => x.id === threadNudged!.id);
      if (t) { t.nudge = (String(t.nudge || "") + " " + threadNudged.mark).trim().slice(-200); t.at = nowMs; threadsNext = base; }
    }
    const ctxPatch: Record<string, unknown> = {};
    if (threadsNext) ctxPatch.threads = threadsNext;
    // 想发圈：云端发不了帖（帖子在手机里），只把起意和时间点记进 outbox，App 下次打开补成当时的帖子
    const post: Outbox | null = canPost && judged.post ? { id: "mo" + nowMs.toString(36), at: nowMs, hint: judged.post, by: "cloud" } : null;
    if (post) {
      ctxPatch.outbox = [...(Array.isArray(context.outbox) ? context.outbox : []).slice(-4), post];
      ctxPatch.momentsLast = nowMs;
      ctxPatch.momentsWeekStart = moBudget.weekStart;
      ctxPatch.momentsWeekN = moBudget.weekN + 1;
      console.log("[push-recheck] 起意发朋友圈：" + post.hint);
    }
    const postDecision = post ? { at: nowMs, kind: "post", note: `想发条朋友圈——${post.hint}`, by: "cloud" } : null;
    const ctxDirty = !!selfReason || !!threadsNext || !!post;
    if (decisions.length === 0 && extra.length === 0) {
      await touch({
        recheck_count: (plan.recheck_count || 0) + 1,
        ...(postDecision ? { decisions: [...priorDecisions, postDecision].slice(-60) } : {}),
        ...(ctxDirty ? { context: { ...context, ...ctxPatch, ...(selfReason ? { selfUsed: selfUsed + 1 } : {}) } } : {}),
      });
      return;
    }

    const applied: Record<string, unknown>[] = [];
    const nextItems = items.map(item => ({ ...item }));
    let lit = litCount;

    // 预约 id 必须带 App 上传的前缀：宿主的 push.cancelWake 只认自家 APP 的 id，
    // 前缀对不上，用户下次打开就撤不掉云端点亮的这条。
    const wakePrefix = context.wakePrefix || "";
    const armedKeys: string[] = [];
    const armJob = async (fireAt: number, intent: string): Promise<string> => {
      if (!wakePrefix) return "";
      const wakeId = `${wakePrefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const clone = JSON.parse(JSON.stringify(template)) as JobPayload;
      const note = `[系统备忘：这不是对方发来的消息。到点了，你现在想主动跟对方说的是——${intent}。`
        + "顺着你们刚才聊的往下说，别重复已经说过的话，也别提起这条备忘。]";
      if (!appendIntentNote(clone.request.body, clone.request.providerKind, note)) return "";
      retuneWakeSnapshot(clone.request.body, clone.request.providerKind, intent,
        Math.max(1, Math.round((fireAt - Date.now()) / 60_000)));
      const insert = await rest("push_jobs", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          id: `job_${crypto.randomUUID()}`,
          user_id: userId,
          trigger_key: `timedwake:${wakeId}`,
          kind: "timed_task",
          execute_at: new Date(fireAt + 15_000).toISOString(),
          status: "pending",
          payload: await encryptPayload(JSON.stringify(clone), payloadKey),
        }]),
      });
      if (!insert.ok) return "";
      armedKeys.push(`"timedwake:${wakeId}"`);
      return wakeId;
    };

    for (const decision of decisions) {
      const time = typeof decision.time === "string" ? decision.time.trim() : "";
      const index = nextItems.findIndex(item => item.time === time && item.fireAt > nowMs + LEAD_MS);
      if (index < 0) continue;
      const item = nextItems[index];
      const why = String(decision.why || "").slice(0, 200);

      if (decision.act === false && item.act) {
        // 改约：话还想说、只是这个点不合适的，整条挪走而不是丢掉。挪不动就退回取消。
        const deferHM = typeof decision.defer === "string" && /^\d{1,2}:\d{2}$/.test(decision.defer.trim())
          ? decision.defer.trim().padStart(5, "0")
          : "";
        const deferAt = deferHM && anchorTrusted
          ? anchor.fireAt + ((Number(deferHM.split(":")[0]) * 60 + Number(deferHM.split(":")[1])) - anchorLocal) * 60_000
          : 0;
        // 挪的上限是念头自己的保质期 until（生成时模型给的，老计划没有就按原时刻 +
        // busyMaxHoldMin 兜底）。不数次数——过了保质期这话就不新鲜了，由头本身不成立。
        const deferOrig = Number(item.origFireAt) || item.fireAt;
        const deferCap = Number(item.until) || deferOrig + Number(context.busyMaxHoldMin ?? 180) * 60_000;
        if (
          deferAt > nowMs + LEAD_MS && !inQuiet(deferHM) && deferAt <= deferCap
          && !nextItems.some(other => other !== item && other.time === deferHM)
          && !tooClose(deferAt, nextItems, item)
        ) {
          const deferJob = item.wakeId ? jobsByKey.get(`timedwake:${item.wakeId}`) : undefined;
          if (deferJob && deferJob.status === "pending") {
            await rest(`push_jobs?id=eq.${encodeURIComponent(deferJob.id)}&status=eq.pending`, {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ status: "cancelled", result_note: "cloud recheck defer", updated_at: new Date().toISOString() }),
            }).catch(() => undefined);
          }
          const deferWakeId = await armJob(deferAt, item.intent || String(decision.intent || ""));
          if (deferWakeId) {
            const from = item.time;
            item.time = deferHM;
            item.fireAt = deferAt;
            item.wakeId = deferWakeId;
            item.origFireAt = deferOrig;
            item.why = why || "这个点不合适";
            // App 合并时按 time 找本地那条，再按 to 去云端 items 里取新时刻和新预约
            applied.push({ at: Date.now(), time: from, to: deferHM, kind: "defer", note: `改约到 ${deferHM}——${item.why}`, by: "cloud" });
            continue;
          }
          item.wakeId = ""; // 旧预约已撤、新的没挂上：往下当取消处理
        }
        const job = item.wakeId ? jobsByKey.get(`timedwake:${item.wakeId}`) : undefined;
        if (job && job.status === "pending") {
          await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.pending`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ status: "cancelled", result_note: "cloud recheck cancel", updated_at: new Date().toISOString() }),
          }).catch(() => undefined);
        }
        item.act = false;
        item.wakeId = "";
        item.why = why || "聊过之后TA改了主意";
        lit -= 1;
        applied.push({ at: Date.now(), time, kind: "recheck", note: `取消——${item.why}`, by: "cloud" });
        continue;
      }

      if (decision.act === true && !item.act) {
        if (lit >= (context.quota ?? 3)) continue;
        if (inQuiet(item.time) || tooClose(item.fireAt, nextItems, item)) continue;
        const intent = String(decision.intent || `刚${item.source}，想到用户`).slice(0, 200);
        const wakeId = await armJob(item.fireAt, intent);
        if (!wakeId) continue;
        item.act = true;
        item.wakeId = wakeId;
        item.intent = intent;
        item.why = why;
        item.sem = String(decision.sem || item.sem).slice(0, 40);
        item.topic = String(decision.topic || item.topic).slice(0, 200);
        lit += 1;
        applied.push({ at: Date.now(), time, kind: "lit", note: `云端点亮——${intent}`, by: "cloud" });
      }
    }

    for (const one of (anchorTrusted ? extra.slice(0, 1) : [])) {
      if (lit >= (context.quota ?? 3)) break;
      const raw = typeof one.time === "string" ? one.time.trim() : "";
      if (!/^\d{1,2}:\d{2}$/.test(raw)) continue;
      // 模型可能给 "9:30"：免打扰是字典序比较，去重也按 "09:30" 存，不补零两处都会错。
      const time = raw.padStart(5, "0");
      if (inQuiet(time)) continue;
      // extra 的 HH:MM 是本地时刻：用同一天已有时刻的绝对毫秒当基准换算，避开时区。
      const localMin = Number(time.split(":")[0]) * 60 + Number(time.split(":")[1]);
      const fireAt = anchor.fireAt + (localMin - anchorLocal) * 60_000;
      if (fireAt <= nowMs + LEAD_MS) continue;
      if (nextItems.some(item => item.time === time)) continue;
      if (tooClose(fireAt, nextItems)) continue;
      const intent = String(one.intent || one.about || "").slice(0, 200);
      if (!intent) continue;
      const wakeId = await armJob(fireAt, intent);
      if (!wakeId) continue;
      const exUhm = typeof one.until === "string" && /^\d{1,2}:\d{2}$/.test(one.until.trim()) ? one.until.trim().padStart(5, "0") : "";
      const exUms = exUhm && anchorTrusted
        ? anchor.fireAt + ((Number(exUhm.split(":")[0]) * 60 + Number(exUhm.split(":")[1])) - anchorLocal) * 60_000
        : 0;
      nextItems.push({
        time,
        fireAt,
        until: exUms > fireAt ? Math.min(exUms, fireAt + 6 * 3600_000) : fireAt + 90 * 60_000,
        source: `${selfReason ? "自发" : "临时"}·${String(one.about || (selfReason ? "想起你" : "未完话题")).slice(0, 10)}`,
        act: true,
        intent,
        why: String(one.why || "").slice(0, 200),
        sem: "",
        topic: "",
        wakeId,
      });
      lit += 1;
      applied.push({ at: Date.now(), time, kind: "extra", note: `云端临时起念——${intent}`, by: "cloud" });
    }

    nextItems.sort((a, b) => a.fireAt - b.fireAt);
    // 自发起念不管有没有起成都记一笔：既扣次数，也让 App 的诊断里看得到「TA想了想，没找你」
    if (selfReason) applied.push({ at: Date.now(), kind: "self", note: `自发起念（${selfReason}）——${lit > litCount ? "起了一个念头" : "想了想，没找你"}`, by: "cloud" });
    if (postDecision) applied.push(postDecision);
    const saved = await touch({
      items: nextItems,
      decisions: [...priorDecisions, ...applied].slice(-60),
      recheck_count: (plan.recheck_count || 0) + 1,
      ...(ctxDirty ? { context: { ...context, ...ctxPatch, ...(selfReason ? { selfUsed: selfUsed + 1 } : {}) } } : {}),
    }, true);
    const rows = saved?.ok ? await saved.json().catch(() => []) as unknown[] : [];
    if (Array.isArray(rows) && rows.length > 0) return;
    // 没写进去 = App 在这轮期间换了计划，我们的裁决作废。刚挂上的预约必须一起撤掉：
    // 新计划里没有它们的 wakeId，留着就是任何界面都查不到出处的孤儿，到点照发。
    if (armedKeys.length) {
      await rest(`push_jobs?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending`
        + `&trigger_key=in.(${encodeURIComponent(armedKeys.join(","))})`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "cancelled" }),
      }).catch(() => undefined);
    }
  };

  const work = run().catch(() => undefined);
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work);
  else await work;
  return new Response("accepted", { status: 200 });
});
