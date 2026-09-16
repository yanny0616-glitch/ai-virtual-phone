// TA的生活：此刻在做什么、情绪、精力、睡没睡、忙不忙、变数揭晓。
// 从 push-recheck / push-generate 原样搬来（tz 算术版）；变数直接复用 App 的 domain/forks.mjs。

import { applyDueForks, forkNotes } from "./vendor/forks.mjs";
import type { GuanianDay, GuanianSched } from "./types.ts";

export const pad2 = (n: number): string => String(n).padStart(2, "0");

export function hhmm(ms: number, tz: number): string {
  const d = new Date(ms + tz * 60_000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 本地日期 YYYY-MM-DD */
export function localDate(ms: number, tz: number): string {
  const d = new Date(ms + tz * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 本地某天 HH:MM 的绝对毫秒 */
export function localHMOn(date: string, hm: string, tz: number): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date), m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!d || !m) return null;
  return Date.UTC(+d[1], +d[2] - 1, +d[3]) + (+m[1] * 60 + +m[2] - tz) * 60_000;
}

/** 本地 HH:MM → 下一次到达它的毫秒（已过就算明天的） */
export function nextLocalHM(hm: string, tz: number, nowMs: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return 0;
  const local = new Date(nowMs + tz * 60_000);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(m[1]), Number(m[2])) - tz * 60_000;
  if (t <= nowMs) t += 86_400_000;
  return t;
}

export function inWindow(hm: string, start?: string, end?: string): boolean {
  if (!start || !end || start === end) return false;
  return start < end ? (hm >= start && hm < end) : (hm >= start || hm < end);
}

export function normHM(v: unknown): string {
  const m = /(\d{1,2})\s*[:：点时.]\s*(\d{1,2})?/.exec(String(v || ""));
  if (!m) return "";
  return pad2(Math.min(23, +m[1])) + ":" + pad2(Math.min(59, +(m[2] || 0)));
}

export function addMin(hm: string, n: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return hm;
  const t = Math.min(+m[1] * 60 + +m[2] + n, 23 * 60 + 59);
  return pad2(Math.floor(t / 60)) + ":" + pad2(t % 60);
}

export const hmMins = (t: string): number => +t.slice(0, 2) * 60 + +t.slice(3, 5);

/** 稳定抽样 0–99：同一个种子永远同一个数 */
export function roll(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % 100;
}

// 睡眠窗：bed 起到 wake 止，允许过零点；没有 wake/bed 时退回免打扰时段。
export function guanianAsleep(day: GuanianDay, hm: string, quietStart?: string, quietEnd?: string): boolean {
  const bed = /^\d{2}:\d{2}$/.test(String(day.bed || "")) ? String(day.bed) : String(quietStart || "");
  const wake = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(quietEnd || "");
  if (!bed || !wake || bed === wake) return false;
  return bed < wake ? (hm >= bed && hm < wake) : (hm >= bed || hm < wake);
}

export type GuanianNow = {
  hm: string; doing: string; step: string; place: string; mood: string; moodBase: string; moodCause: string; moodHit: string;
  energy: number; next: string; done: GuanianSched | null; asleep: boolean; over: boolean;
};

export function guanianNow(day: GuanianDay, nowMs: number, quietStart?: string, quietEnd?: string): GuanianNow {
  const tz = Number.isFinite(Number(day.tz)) ? Number(day.tz) : 0;
  const local = new Date(nowMs + tz * 60_000);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  const hm = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  const sched = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");
  const conds = (Array.isArray(day.conds) ? day.conds : [])
    .map(c => ({ c, w: Math.pow(0.5, Math.max(0, nowMs - (Number(c.startAt) || 0)) / (Math.max(10, Number(c.halfLifeMin) || 180) * 60_000)) }))
    .filter(x => x.w > 0.08 && (Number(x.c.startAt) || 0) <= nowMs)
    .sort((a, b) => (b.w * (Number(b.c.intensity) || 50)) - (a.w * (Number(a.c.intensity) || 50)));
  let done: GuanianSched | null = null;
  for (const it of sched) if (String(it.time) <= hm) done = it;
  const next = sched.find(it => String(it.time) > hm) || null;
  const asleep = guanianAsleep(day, hm, quietStart, quietEnd);
  // 睡着 / 正做着 / 做完了在空档 / 最后一件做完在等睡（过零点还没睡也算）
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
  const place = String((done && done.place) || day.location || "");
  const hh = h < 5 ? h + 24 : h;
  let energy = Number.isFinite(Number(day.energy)) ? Number(day.energy) : 60;
  const hmNum = (v: unknown): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
    return m ? Number(m[1]) + Number(m[2]) / 60 : null;
  };
  // cost 按进度记账、状况负向合计封顶 -12、缓降从起床时刻起算
  for (const it of sched) {
    if (h >= 5 && String(it.time) > hm) continue;
    const a = hmNum(it.time), b = hmNum(it.end);
    const prog = a != null && b != null && b > a ? Math.max(0, Math.min(1, (h - a) / (b - a))) : 1;
    energy += Math.max(-15, Math.min(15, Math.round(Number(it.cost) || 0))) * prog;
  }
  let cd = 0;
  for (const x of conds) cd += (Number(x.c.energyDelta) || 0) * x.w;
  energy += Math.max(-12, cd);
  const wakeH = hmNum(day.wake) ?? 7;
  energy -= Math.max(0, Math.min(hh, 22) - wakeH) * 1.2 + Math.max(0, hh - 22) * 8;
  energy = Math.max(0, Math.min(100, Math.round(energy)));
  const cand: { text: string; from: string; label: string; w: number }[] = [];
  const top = conds[0];
  if (top && top.c.mood) cand.push({ text: String(top.c.mood), from: String(top.c.cause || "刚才聊的"), label: `因为${top.c.cause || "刚才聊的"}`, w: top.w * (Number(top.c.intensity) || 50) / 100 });
  if (done && done.mood) {
    const [dh, dm] = String(done.time).split(":").map(Number);
    cand.push({ text: String(done.mood), from: String(done.title || ""), label: `${done.title || ""}之后`, w: Math.pow(0.5, Math.max(0, (h * 60 - (dh * 60 + dm)) * 60_000) / (90 * 60_000)) * 0.6 });
  }
  cand.sort((a, b) => b.w - a.w);
  const hit = cand.find(x => x.text && x.w > 0.15);
  return {
    hm, done, step, place, energy, doing, asleep, over,
    mood: hit ? `${hit.text}（${hit.label}）` : `${day.mood || "说不上来"}（今天的底色）`,
    moodBase: String(day.mood || ""), moodCause: hit ? hit.from : "", moodHit: hit ? hit.text : "",
    next: asleep ? `${day.wake || quietEnd || ""} 起床`.trim() : next ? `${next.time} ${next.title || ""}` : (over && day.bed ? `${day.bed} 睡觉` : ""),
  };
}

// 变数：按日程里的时区换算此刻和揭晓时刻；结果不落库，每次读都重算
export function forkDay(day: GuanianDay, nowMs: number, affection?: unknown): GuanianDay {
  if (!day || !Array.isArray(day.forks) || !day.forks.length) return day;
  const tz = Number(day.tz) || 0;
  const local = new Date(nowMs + tz * 60_000);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - tz * 60_000;
  const score = affection && typeof affection === "object" ? (affection as { score?: unknown }).score : undefined;
  return applyDueForks(day, hhmm(nowMs, tz), { seed: String(day.forkSeed || ""), score, at: (t: string) => base + hmMins(t) * 60_000 }).day as GuanianDay;
}

// 忙：TA此刻正做着顾不上看手机的事，返回那件事的结束时刻；否则空串。
const BUSY_RE = /上课|课堂|听课|自习|复习|预习|写作业|做作业|赶作业|做题|考试|测验|开会|会议|值班|实习|训练|排练|实验|赶稿|写稿|编程|写代码|专注|集中精神|通勤|赶路|开车|面试|汇报|手术|门诊/;
const NOT_BUSY_RE = /睡觉|睡眠|午睡|午休|补觉|休息|发呆|摸鱼|放松|吃饭|用餐|散步|刷视频|看番|打游戏|玩游戏|聊天|自由时间|准备睡|洗漱|刚醒|起床|看剧|逛/;
export function busyUntil(day: GuanianDay, hm: string): string {
  const sched = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");
  let cur: GuanianSched | null = null;
  for (const it of sched) if (String(it.time) <= hm) cur = it;
  if (!cur) return "";
  const end = typeof cur.end === "string" && cur.end > String(cur.time) ? cur.end : "";
  if (!end || hm >= end) return "";
  const title = String(cur.title || "");
  const busy = typeof cur.busy === "boolean" ? cur.busy : (BUSY_RE.test(title) && !NOT_BUSY_RE.test(title));
  return busy ? end : "";
}

/** 念头等待越久越淡：按半衰期保留发送概率 */
export function waitingChance(nowMs: number, originalAt: number, halfLifeMin: number): number {
  const age = Math.max(0, nowMs - originalAt) / 60000;
  const halfLife = Number.isFinite(halfLifeMin) && halfLifeMin > 0 ? halfLifeMin : 180;
  return Math.pow(0.5, age / halfLife);
}

type Affection = { score?: number; tier?: string; relation?: string } | null | undefined;

// 到点发消息时补进请求的「TA此刻的状态」，与 push-generate guanianStateNote 同文
export function stateNote(day: GuanianDay, nowMs: number, quietStart?: string, quietEnd?: string, affection?: Affection, threads?: string[]): string {
  const now = guanianNow(day, nowMs, quietStart, quietEnd);
  const base = now.moodBase;
  const moodLine = now.moodHit
    ? `${now.moodHit}（因为${now.moodCause || "刚才那阵"}；今天的底色是「${base || "平常"}」）`
    : `${base || "说不上来"}（今天一整天的底色）`;
  const e = now.energy;
  const lines = [
    `[系统备忘：这不是对方发来的消息。这是你此刻（本地时间 ${now.hm}）的状态，提示词里若有更早的「挂念 · 某某时刻的状态」以这份为准：`,
    now.asleep
      ? `在睡觉${day.wake ? "（" + day.wake + " 左右才醒）" : ""}：这会儿不会看到消息；真被吵醒也只是迷迷糊糊回一两句，说不了长话。`
      : `在做的事：${now.doing || "没什么特别的"}${now.step ? "，具体是在" + now.step : ""}${now.place ? "；人在" + now.place : ""}`,
    `情绪：${moodLine}`,
    `精力：${e}%${e < 25 ? "——很累了，话短、反应慢、容易敷衍" : e < 50 ? "——有点乏" : e < 80 ? "——还行" : "——精神很好"}`,
  ];
  if (now.asleep) { if (day.wake) lines.push(`接下来：${day.wake} 起床`); }
  else if (now.next) lines.push(`接下来：${now.next}`);
  if (affection && (affection.tier || affection.relation)) {
    lines.push(`对TA：${affection.tier || "说不上"}；两人现在的关系：${affection.relation || "没定"}。说话的分寸按这个来。`);
  }
  if (threads && threads.length) lines.push(`心里还挂着：${threads.join("；")}。和这次要说的事有关就顺口带上，无关就别硬提。`);
  for (const line of forkNotes(day) as string[]) lines.push(line);
  lines.push("这些是你自己的状态，说话时自然带出来就行，别报数字、别列清单、别提这段文字。]");
  return lines.join("\n");
}
