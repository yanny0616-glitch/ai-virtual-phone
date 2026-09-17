// 生成那天前要知道的「已定安排」：手机日程表上的条目 + 「忙碌回复」插件的固定作息和例外。
// 原料由宿主（小手机开着时）原样寄来，规则与挂念 App planning/routine.js、planning/calendar.js 同源，按角色时区算。

import { hhmm, localHMOn } from "./life.ts";
import type { FixedItem, Routine } from "./day.ts";

const ROUTINE_LOCK: Record<string, string> = { focus: "busy", busy: "busy", distracted: "free", sleep: "busy" };
const ROUTINE_NAME: Record<string, string> = { focus: "专注", busy: "忙", distracted: "分神", sleep: "午睡" };
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (v: string): number => +v.slice(0, 2) * 60 + +v.slice(3, 5);

export type RawCalendarItem = { id?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown; title?: unknown; location?: unknown };

// 日程表条目标题末尾写「·忙」「·闲」，就是替TA定死了这件事顾不顾得上看手机
function lockOfTitle(title: string): { title: string; lock: string } {
  const m = /^(.*?)\s*[·・]\s*(忙|闲)\s*$/.exec(title);
  return m ? { title: m[1], lock: m[2] === "忙" ? "busy" : "free" } : { title, lock: "" };
}

/** 日程表：只取当天、去掉挂念自己写回的（那是可重新生成的结果，不是约束） */
export function calendarFixed(items: unknown, date: string): FixedItem[] {
  return (Array.isArray(items) ? items as RawCalendarItem[] : [])
    .filter(it => it && typeof it === "object" && String(it.date || date) === date && HM.test(String(it.startTime || "")) && String(it.title || "").trim())
    .filter(it => !/^guanian_/.test(String(it.id || "")))
    .map(it => {
      const l = lockOfTitle(String(it.title).trim().slice(0, 60));
      return { id: String(it.id || ""), startTime: String(it.startTime), endTime: HM.test(String(it.endTime || "")) ? String(it.endTime) : "", title: l.title, location: String(it.location || "").slice(0, 60), lock: l.lock };
    })
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** 固定作息折成那天的已定安排和起床 / 上床时刻。不到 3 小时的「睡觉」当午睡 */
export function routineFor(routine: unknown, exceptions: unknown, date: string, tz: number, nowMs: number): { items: FixedItem[]; wake: string; bed: string } {
  const out = { items: [] as FixedItem[], wake: "", bed: "" };
  const d0 = localHMOn(date, "00:00", tz);
  if (d0 === null) return out;
  const d1 = d0 + 86_400_000;
  const [y, mo, d] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const item = (id: unknown, from: string, to: string, title: string, kind: string): FixedItem =>
    ({ id: "routine_" + String(id), startTime: from, endTime: to, title: title || ROUTINE_NAME[kind], location: "", lock: ROUTINE_LOCK[kind] });
  const list = (v: unknown) => (Array.isArray(v) ? v : []).filter(x => x && typeof x === "object") as Record<string, any>[];
  for (const it of list(routine)) {
    if (!HM.test(it.from) || !HM.test(it.to) || it.from === it.to || !ROUTINE_LOCK[it.kind]) continue;
    const days: number[] = Array.isArray(it.days) ? it.days : [];
    const on = (off: number) => !days.length || days.includes((weekday + off + 7) % 7);
    const title = String(it.title || "").slice(0, 20);
    if (it.kind === "sleep" && (mins(it.to) - mins(it.from) + 1440) % 1440 >= 180) {
      const cross = it.from > it.to;
      if (!out.wake && on(cross ? -1 : 0)) out.wake = it.to;
      if (!out.bed && on(cross ? 0 : 1)) out.bed = it.from;
    } else if (on(0)) out.items.push(item(it.id || it.from, it.from, it.to, title, it.kind));
  }
  const inDay = (ms: number) => ms >= d0 && ms < d1;
  for (const ex of list(exceptions)) {
    if (!(+ex.until > nowMs)) continue;
    const title = String(ex.title || "").slice(0, 20), mask = +(ex.maskFrom != null ? ex.maskFrom : ex.from);
    // 推迟睡觉：今晚上床的时刻跟着挪
    if (ex.op === "shift" && ex.kind === "sleep") { if (inDay(mask)) out.bed = hhmm(+ex.from, tz); continue; }
    if ((ex.op === "skip" || ex.op === "shift") && inDay(mask)) {
      const i = out.items.findIndex(x => x.title === title && x.startTime === hhmm(mask, tz));
      if (i >= 0) out.items.splice(i, 1);
    }
    if ((ex.op === "add" || ex.op === "shift") && inDay(+ex.from) && ROUTINE_LOCK[ex.kind]) out.items.push(item(ex.id || ex.from, hhmm(+ex.from, tz), hhmm(+ex.to, tz), title, ex.kind));
  }
  return out;
}

/** 日程表同一时刻已有安排时以日程表为准 */
export function fixedForDay(calendar: unknown, routine: unknown, exceptions: unknown, date: string, tz: number, nowMs: number, routineOn = true): { items: FixedItem[]; routine: Routine } {
  const cal = calendarFixed(calendar, date);
  const r = routineOn ? routineFor(routine, exceptions, date, tz, nowMs) : { items: [], wake: "", bed: "" };
  const taken = new Set(cal.map(it => it.startTime));
  const items = cal.concat(r.items.filter(it => !taken.has(it.startTime))).sort((a, b) => a.startTime.localeCompare(b.startTime));
  return { items, routine: { ...(r.wake ? { wake: r.wake } : {}), ...(r.bed ? { bed: r.bed } : {}) } };
}
