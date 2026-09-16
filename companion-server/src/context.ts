// 注入聊天提示词的「TA此刻怎么样」：与挂念 App chat/context.js 的 chatContextText 同文。
// 宿主每分钟来取一次写进角色的聊天提示词，挂念 App 不开着也是新的。

import { forkNotes } from "./vendor/forks.mjs";
import { forkDay, guanianNow, hhmm, normHM } from "./life.ts";
import { liveThreads, THREAD_KIND, threadWhen } from "./threads.ts";
import type { Ctx, GuanianDay } from "./types.ts";

type SleepWindow = { bed: string; wake: string; overnight: boolean };

function sleepWindow(day: GuanianDay | null, quietStart?: string, quietEnd?: string): SleepWindow | null {
  const bed = normHM(day?.bed) || String(quietStart || "");
  const wake = normHM(day?.wake) || String(quietEnd || "");
  // overnight 沿用 App 的旧名：bed < wake
  return bed && wake && bed !== wake ? { bed, wake, overnight: bed < wake } : null;
}

const inWindow = (hm: string, w: SleepWindow): boolean => w.bed < w.wake ? hm >= w.bed && hm < w.wake : hm >= w.bed || hm < w.wake;

/** 今天还没生成时，按昨天的作息撑过零点到生成之间 */
export function nightBridge(prev: GuanianDay | null, nowMs: number, tz: number, quietStart?: string, quietEnd?: string) {
  const sw = sleepWindow(prev, quietStart, quietEnd);
  if (!sw) return null;
  const hm = hhmm(nowMs, tz);
  const asleep = inWindow(hm, sw);
  const upLate = sw.overnight && hm < sw.bed;
  return {
    asleep, wake: sw.wake, bed: sw.bed,
    doing: asleep ? "睡觉" : upLate ? "还没睡，快上床了" : "刚起床，今天的安排还没定",
    next: asleep ? sw.wake + " 起床" : upLate ? sw.bed + " 睡觉" : "",
  };
}

export function chatContextText(opts: {
  day: GuanianDay | null; prev: GuanianDay | null; settings: Partial<Ctx>; threads: Ctx["threads"]; nowMs: number; tz: number; threadsOn?: boolean;
}): string {
  const { settings, nowMs, tz } = opts;
  const qs = settings.quietStart, qe = settings.quietEnd;
  if (!opts.day) {
    const nb = opts.prev ? nightBridge(opts.prev, nowMs, tz, qs, qe) : null;
    if (!nb) return "";
    return (nb.asleep
      ? "在睡觉（" + nb.wake + " 左右才醒）：这会儿不会看到消息；真被吵醒也只是迷迷糊糊回一两句，说不了长话。"
      : "在做的事：" + nb.doing + "。") + "\n今天的日程还没排，先按昨天的作息过。";
  }
  const day = forkDay({ ...opts.day, tz }, nowMs, settings.affection);
  const now = guanianNow(day, nowMs, qs, qe);
  const sw = sleepWindow(day, qs, qe);
  const hm = now.hm;
  const schedule = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");
  const nx = now.asleep ? null : schedule.find(it => String(it.time) > hm) || null;
  const phasePre = !now.asleep && now.doing === "睡前自己待着，准备睡了";
  const lines: string[] = [];
  if (now.asleep) {
    lines.push("在睡觉" + (sw ? "（" + sw.wake + " 左右才醒）" : "") + "：这会儿不会看到消息；真被吵醒也只是迷迷糊糊回一两句，说不了长话。");
  } else {
    lines.push("在做的事：" + (now.doing || day.doing || "没什么特别的") + (now.step ? "，具体是在" + now.step : "")
      + (now.place ? "；人在" + now.place : ""));
  }
  if (day.sleep && !now.asleep) lines.push("昨晚：" + day.sleep);
  lines.push("情绪：" + (now.moodHit || day.mood || "说不上来")
    + (!now.moodHit ? "（今天一整天的底色）" : "（因为" + (now.moodCause || "刚才那阵") + "；今天的底色是「" + (day.mood || "平常") + "」）"));
  const e = now.energy;
  lines.push("精力：" + e + "%" + (e < 25 ? "——很累了，话短、反应慢、容易敷衍" : e < 50 ? "——有点乏" : e < 80 ? "——还行" : "——精神很好"));
  if (nx) lines.push("接下来：" + nx.time + " " + (nx.title || ""));
  else if (phasePre && sw) lines.push("接下来：" + sw.bed + " 睡觉");
  else if (now.asleep && sw) lines.push("接下来：" + sw.wake + " 起床");
  if (opts.threadsOn !== false) {
    const tl = liveThreads({ ...settings, threads: opts.threads } as Ctx, nowMs).slice(0, 4)
      .map(t => (THREAD_KIND[t.kind] || "话头") + "·" + t.text + (threadWhen(t, nowMs, tz) ? "（" + threadWhen(t, nowMs, tz) + "）" : ""));
    if (tl.length) lines.push("心里还挂着：" + tl.join("；") + "。到了时候自然会想问一句，不用每次都提。");
  }
  for (const line of forkNotes(day) as string[]) lines.push(line);
  lines.push("这些是你自己的状态，说话时自然带出来就行，别报数字、别列清单、别提这段文字。");
  return lines.join("\n");
}
