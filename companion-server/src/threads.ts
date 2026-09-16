// 惦记账本：话头 / 约定 / 日子。从 push-recheck 原样搬来；约定规则复用 domain/promises。

import { promiseAgreementRule, updatePromiseThreads } from "./vendor/promises.mjs";
import { hhmm } from "./life.ts";
import type { Ctx, Keep, Thread } from "./types.ts";

export const THREAD_KIND: Record<string, string> = { topic: "话头", promise: "约定", date: "日子" };

export function threadAlive(t: Thread, nowMs: number, days: number): boolean {
  if (!t || !t.text) return false;
  if (t.done) return nowMs - (Number(t.at) || 0) < 86_400_000;
  const due = Number(t.due) || 0;
  if (t.kind === "date") return t.yearly ? true : (due ? nowMs < due + 86_400_000 : false);
  if (t.kind === "promise") return due ? nowMs < due + 86_400_000 : nowMs - (Number(t.since) || 0) < 7 * 86_400_000;
  return nowMs - (Number(t.at) || Number(t.since) || 0) < (days || 3) * 86_400_000;
}

export function threadDueMs(t: Thread, nowMs: number, tz: number): number {
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

export function liveThreads(ctx: Ctx, nowMs: number): Thread[] {
  const days = Number(ctx.threadDays) || 3;
  return (Array.isArray(ctx.threads) ? ctx.threads : []).filter(t => t && !t.done && threadAlive(t, nowMs, days));
}

// 话头的节奏：刚记下 4 小时内不提，提过一次 36 小时内不再提
function threadPace(t: Thread, nowMs: number): string {
  if (t.kind === "topic" && nowMs - (Number(t.since) || 0) < 4 * 3600_000) return "刚记下，先别提";
  if (/said:/.test(String(t.nudge || "")) && nowMs - (Number(t.at) || 0) < 36 * 3600_000) return "刚提过，先别再提";
  return "";
}

export function threadLines(ctx: Ctx, nowMs: number, tz: number): string[] {
  const active = liveThreads(ctx, nowMs).slice(0, 12).map(t => {
    const notes = [threadWhen(t, nowMs, tz), threadPace(t, nowMs)].filter(Boolean);
    return `[${t.id}] ${THREAD_KIND[t.kind] || "话头"}·${t.text}${notes.length ? "（" + notes.join("，") + "）" : ""}`;
  });
  const settled = (ctx.threads || []).filter(t => t.done && t.kind !== "promise" && threadAlive(t, nowMs, Number(ctx.threadDays) || 3))
    .slice().sort((a, b) => (+(b.at || 0)) - (+(a.at || 0))).slice(0, 8)
    .map(t => `[${t.id}] 已了结·${THREAD_KIND[t.kind] || "话头"}·${t.text}（仅供判重，不再新建或安排）`);
  return active.concat(settled);
}

// 到点发消息时让TA带着的精简版：只看没了结、没过期的，最多 4 件
export function shortThreadLines(threads: unknown, nowMs: number, tz: number): string[] {
  if (!Array.isArray(threads)) return [];
  const out: string[] = [];
  for (const t of threads as Thread[]) {
    if (!t || t.done || !t.text) continue;
    const due = threadDueMs(t, nowMs, tz);
    if (due && nowMs > due + 86_400_000) continue;
    const local = due ? new Date(due + tz * 60_000) : null;
    const n = new Date(nowMs + tz * 60_000);
    const sameDay = local && local.getUTCFullYear() === n.getUTCFullYear() && local.getUTCMonth() === n.getUTCMonth() && local.getUTCDate() === n.getUTCDate();
    const when = !local ? "" : sameDay
      ? (t.kind === "date" ? "今天" : "今天 " + hhmm(due, tz) + (due < nowMs ? "，已经过了" : ""))
      : `${local.getUTCMonth() + 1}/${local.getUTCDate()}`;
    out.push(`${THREAD_KIND[String(t.kind)] || "话头"}·${t.text}${when ? "（" + when + "）" : ""}`);
    if (out.length >= 4) break;
  }
  return out;
}

function threadTextKey(text: unknown): string {
  return String(text || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function findThreadUpdate(list: Thread[], k: Keep, kind: string, text: string, nowMs: number, days: number): Thread | false | null {
  const id = String(k.id || "").replace(/[\[\]\s]/g, "");
  if (id) {
    const found = list.find(t => t.id === id);
    return found && found.kind === kind ? found : false;
  }
  const key = threadTextKey(text);
  const candidates = list.filter(t => t.kind === kind && threadAlive(t, nowMs, days));
  const exact = candidates.filter(t => threadTextKey(t.text) === key);
  const matches = exact.length ? exact : candidates.filter(t => {
    const old = threadTextKey(t.text);
    return Math.min(old.length, key.length) >= 6 && (old.includes(key) || key.includes(old));
  });
  return matches.length === 1 ? matches[0] : matches.length > 1 ? false : null;
}

export const THREAD_TASK = "惦记账本：只记录聊天里明确成立的事。promise 是用户、角色自己或双方明确答应的约定，subject 分别为 user、character、both；角色说「三点半回来一趟」也必须记录。所有有时间的约定（包括今天）都进 keep，系统直接按 when 挂约定任务，不再放入 extra 随机起念。when 必须含 YYYY-MM-DD HH:MM，按原话的日期，不因现在已过点而顺移到明天。sourceMessageId 填证据消息编号；已有同一件事必须填 id，改期更新 when，不创建第二件事。确认完成时 status=completed，明确取消时 status=cancelled；只是发过进展不等于完成。不明确的猜测不记账；话头和日子也必须先核对已有及已了结条目：同一件事换措辞仍是同一件事，keep.id 必须填原编号，系统更新原条而不是新建。只有真正的新事项才留空 id；已了结的同一件事不要再次 keep、settle 或安排，恢复由用户操作。settle 填已了结的话头或日子 id，约定的完成取消通过 keep 更新。每次最多 2 条，没有给空数组。" + promiseAgreementRule();

// 用户一句话把约定 / 话头了结：只认稳的词，宁可漏也不误伤。约定认「做完」和「作废」，话头只认「作废」，日子不碰
const DONE_WORDS = ["好了", "搞定", "解决了", "完成了", "弄完了", "做完了", "办好了", "交了", "买到了", "看完了", "结束了"];
const DROP_WORDS = ["不用了", "算了", "取消", "不去了", "不做了", "不需要了", "别提了", "不聊了", "不说这个了"];
const NEG_BEFORE = /(还没|没有|没能|不算|别)[^，。！？]{0,4}$/;
const TOKEN_STOP = /帮我|记得|提醒|一下|这个|那个|然后|今天|明天|后天|一起|我们|你们|已经|可以|就是|什么/g;

function wordTokens(text: string): Set<string> {
  const out = new Set<string>();
  const cleaned = String(text || "").replace(TOKEN_STOP, " ");
  for (const run of cleaned.match(/[一-鿿]{2,}/g) || []) for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  for (const w of cleaned.match(/[A-Za-z0-9_]{2,}/g) || []) out.add(w.toLowerCase());
  return out;
}

export type WordSettle = { id: string; text: string; how: string; said: string };

export function settleByWords(threads: Thread[], msgs: string[], nowMs: number): WordSettle[] {
  const out: WordSettle[] = [];
  const live = threads.filter(t => t && !t.done && t.text && t.kind !== "date");
  for (const raw of msgs) {
    const msg = String(raw || "").trim();
    if (!msg || msg.length > 60 || /[吗呢？?]\s*$/.test(msg)) continue; // 长句和问句都不猜
    const hit = (words: string[]) => words.find(w => { const i = msg.indexOf(w); return i >= 0 && !NEG_BEFORE.test(msg.slice(0, i)); });
    const drop = hit(DROP_WORDS), done = drop ? "" : hit(DONE_WORDS);
    if (!drop && !done) continue;
    const pool = live.filter(t => !out.some(o => o.id === t.id) && (drop || t.kind === "promise"));
    if (!pool.length) continue;
    const toks = wordTokens(msg);
    let match = pool.filter(t => [...wordTokens(t.text)].some(k => toks.has(k)));
    // 撞不上词：只有一条活着、这句又短得像在直接回应时才认；撞上多条也不猜
    if (!match.length && pool.length === 1 && msg.length <= 8) match = pool;
    if (match.length !== 1) continue;
    const t = match[0];
    t.done = true; t.at = nowMs; t.by = "words";
    if (t.kind === "promise") t.status = drop ? "cancelled" : "completed";
    out.push({ id: t.id, text: t.text, how: drop ? "作废" : "完成", said: drop || done || "" });
  }
  return out;
}

// 模型给的时间：2026-09-10 15:00 / 09-10 / 9月10日 / 15:00 / 明天 15:00，按 tz 折成 UTC ms
export function parseWhen(when: unknown, nowMs: number, tz: number): number {
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

// 判断回来的 keep / settle 并进账本；返回 null 表示没动
export function applyThreads(ctx: Ctx, keep: Keep[], settle: string[], nowMs: number, tz: number, log: (s: string) => void, messages: unknown[] | null = null): Thread[] | null {
  let list: Thread[] = (Array.isArray(ctx.threads) ? ctx.threads : []).map(t => ({ ...t }));
  keep = keep.slice(0, 2).filter(k => k && typeof k === "object").map(k => ({ ...k, id: String(k.id || "").replace(/[\[\]\s]/g, "") }));
  const promises = keep.filter(k => k && (k.kind === "promise" || list.some(t => t.kind === "promise" && t.id === k.id)));
  const before = JSON.stringify(list);
  list = updatePromiseThreads(list, promises.map(k => ({ ...k, due: parseWhen(k.when, nowMs, tz) })), nowMs, "server", messages as never) as Thread[];
  const notes: string[] = before === JSON.stringify(list) ? [] : ["更新约定"];
  for (const id of settle.slice(0, 6)) {
    const t = list.find(x => x.id === String(id).replace(/[\[\]]/g, "").trim());
    if (t && !t.done) { t.done = true; t.at = nowMs; t.by = "server"; notes.push(`了结「${t.text}」`); }
  }
  const days = Number(ctx.threadDays) || 3;
  for (const k of keep) {
    if (promises.includes(k)) continue;
    const text = String(k?.text || "").trim().slice(0, 60);
    if (!text) continue;
    const referenced = k.id && list.find(t => t.id === k.id);
    const kind = THREAD_KIND[String(k?.kind)] ? String(k?.kind) : referenced ? referenced.kind : "topic";
    const existing = findThreadUpdate(list, k, kind, text, nowMs, days);
    if (existing === false || existing && existing.done) continue;
    const due = k.when ? parseWhen(k.when, nowMs, tz) : existing ? (+(existing.due || 0)) : 0;
    if (existing) {
      if (kind !== "topic" && !due) continue;
      Object.assign(existing, { ...(k.matterId ? { matterId: k.matterId } : {}), text, due, at: nowMs, by: "server" }, k.why == null ? {} : { why: String(k.why).slice(0, 40) });
      notes.push(`更新${THREAD_KIND[kind]}「${text}」`);
      continue;
    }
    if (kind !== "topic" && !due) continue;
    list.push({ ...(k.matterId ? { matterId: k.matterId } : {}), id: "t" + Math.random().toString(36).slice(2, 6), kind, text, due, yearly: kind === "date" && /生日|纪念/.test(text), since: nowMs, at: nowMs, by: "server", done: false, why: String(k?.why || "").slice(0, 40) });
    notes.push(`记下${THREAD_KIND[kind]}「${text}」`);
  }
  if (!notes.length) return null;
  log("惦记账本：" + notes.join("，"));
  return list.filter(t => threadAlive(t, nowMs, days)).slice(-30);
}

// 自发起念的由头：到日子了。每个阶段只提一次，记在 nudge 里；明确约定由独立定时器负责
export function threadNudge(ctx: Ctx, nowMs: number, tz: number): { id: string; mark: string; reason: string } | null {
  for (const t of liveThreads(ctx, nowMs)) {
    const due = threadDueMs(t, nowMs, tz);
    if (!due) continue;
    const d = due - nowMs, marks = String(t.nudge || "");
    const mark = (phase: string) => `${phase}:${due}`;
    if (t.kind === "promise") continue;
    if (t.kind === "date" && Math.abs(d) <= 12 * 3_600_000 && !marks.includes(mark("day"))) {
      return { id: t.id, mark: mark("day"), reason: `今天是${t.text}` };
    }
  }
  return null;
}
