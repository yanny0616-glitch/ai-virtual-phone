// 聊天带来的情绪和未来安排：与 App recheck / applyChatSchedEdits 的规则一致，无 IO。
import { hhmm, hmMins, localDate } from "./life.ts";
import type { GuanianDay, GuanianSched } from "./types.ts";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v); return Math.max(min, Math.min(max, Number.isFinite(n) ? Math.round(n) : fallback));
};
const hm = (v: unknown) => typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim().padStart(5, "0") : "";
const atMin = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

export function applyChatState(day: GuanianDay, feelRaw: unknown, editsRaw: unknown, opts: { nowMs: number; tz: number; date: string; chatEditsDay: boolean }) {
  const notes: { kind: string; note: string }[] = [];
  const next = structuredClone(day);
  // 模型跨过了零点才回来，不能拿今天的聊天改昨天的生活。
  if (localDate(opts.nowMs, opts.tz) !== opts.date) return { day: next, notes };
  const feel = object(feelRaw), mood = text(feel.mood, 24);
  if (mood) {
    const conds = (next.conds || []).filter(c => Math.pow(0.5, Math.max(0, opts.nowMs - Number(c.startAt || 0)) / (Math.max(10, Number(c.halfLifeMin) || 180) * 60_000)) > 0.08);
    next.conds = [...conds, { mood, cause: text(feel.cause, 20) || "刚才聊的", energyDelta: num(feel.energy, 0, -20, 20),
      intensity: num(feel.intensity, 50, 0, 100), halfLifeMin: num(feel.hours, 3, 1, 12) * 60, startAt: opts.nowMs }].slice(-8);
    notes.push({ kind: "mood", note: `聊完之后TA的情绪：${mood}（${text(feel.cause, 20) || "刚才聊的"}）` });
  }
  if (!opts.chatEditsDay || !Array.isArray(editsRaw)) return { day: next, notes };
  const schedule = next.schedule || [];
  const nowHM = hhmm(opts.nowMs, opts.tz);
  for (const raw of editsRaw.slice(0, 2)) {
    const edit = object(raw), op = text(edit.op, 10).toLowerCase(), why = text(edit.why, 20) || "聊天里说定的";
    const to = hm(edit.newTime) || (op === "add" ? hm(edit.time) : "");
    if (op === "add") {
      const title = text(edit.title, 16);
      if (!to || to <= nowHM || !title || schedule.some(s => s.time === to)) continue;
      schedule.push({ time: to, title, note: text(edit.note, 40), mood: text(edit.mood, 24), cost: num(edit.cost, 0, -15, 15), from: "chat", why } as GuanianSched);
      notes.push({ kind: "schedule", note: `聊天改日程：新增 ${to}「${title}」——${why}` });
      continue;
    }
    const from = hm(edit.time), i = from ? schedule.findIndex(s => s.time === from) : -1;
    if (i < 0 || from <= nowHM) continue;
    const item = schedule[i];
    if (op === "drop") {
      schedule.splice(i, 1);
      notes.push({ kind: "schedule", note: `聊天改日程：删掉 ${from}「${item.title}」——${why}` });
    } else if (op === "move") {
      if (!to || to <= nowHM || schedule.some(s => s.time === to)) continue;
      const duration = item.end ? hmMins(item.end) - hmMins(from) : 0;
      if (item.end && (duration <= 0 || hmMins(to) + duration >= 1440)) continue;
      schedule[i] = { ...item, time: to, ...(item.end ? { end: atMin(hmMins(to) + duration) } : {}), from: "chat", why } as GuanianSched;
      delete schedule[i].steps;
      notes.push({ kind: "schedule", note: `聊天改日程：${from}「${item.title}」挪到 ${to}——${why}` });
    }
  }
  next.schedule = schedule.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return { day: next, notes };
}
