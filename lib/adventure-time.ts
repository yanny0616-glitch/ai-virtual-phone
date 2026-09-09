import type { GameSave } from "./map-types";

export const ADVENTURE_PERIODS = ["morning", "afternoon", "evening", "night"] as const;
export type AdventureClock = { day: number; period: typeof ADVENTURE_PERIODS[number] };
const LABELS = { morning: "清晨", afternoon: "午后", evening: "黄昏", night: "夜晚" };

export function readAdventureClock(save: Pick<GameSave, "gameDay" | "gameTime">): AdventureClock {
  return { day: save.gameDay, period: save.gameTime };
}

export function formatAdventureClock(clock: AdventureClock): string {
  return `第${clock.day}天 · ${LABELS[clock.period]}`;
}

function validClock(value: unknown): value is AdventureClock {
  if (!value || typeof value !== "object") return false;
  const c = value as AdventureClock;
  return Number.isSafeInteger(c.day) && c.day >= 1 && Number.isSafeInteger(c.day * 4)
    && ADVENTURE_PERIODS.includes(c.period);
}

function same(a: AdventureClock, b: AdventureClock): boolean {
  return a.day === b.day && a.period === b.period;
}

/** A successful turn is remembered even when no time passes. No input is mutated. */
export function applyAdventureTime(save: GameSave, raw: unknown, context: {
  expected: AdventureClock;
  turnId: string;
  createdAt: string;
  locationName: string;
}): { save: GameSave; warning?: string; notice?: string } {
  if (save.lastTimeTurnId === context.turnId) return { save };
  const current = readAdventureClock(save);
  if (!validClock(current) || !same(current, context.expected)) return { save, warning: "生成期间游戏时间已改变，未覆盖新时间" };
  const resolved = { ...save, lastTimeTurnId: context.turnId };
  if (raw === undefined || raw === null) return { save: resolved };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { save: resolved, warning: "时间变化格式无效，已保留原时间" };
  const p = raw as { from?: unknown; to?: unknown; reason?: unknown };
  if (!validClock(p.from) || !validClock(p.to) || !same(p.from, context.expected)) return { save: resolved, warning: "时间变化的原值或目标时段无效，已保留原时间" };
  const before = p.from.day * 4 + ADVENTURE_PERIODS.indexOf(p.from.period);
  const after = p.to.day * 4 + ADVENTURE_PERIODS.indexOf(p.to.period);
  if (after < before) return { save: resolved, warning: "不能倒退游戏时间，已保留原时间" };
  if (after === before) return { save: resolved };
  if (typeof p.reason !== "string" || !p.reason.trim() || p.reason.length > 500) return { save: resolved, warning: "时间推进缺少有效原因，已保留原时间" };
  const notice = `时间推进至${formatAdventureClock(p.to)}：${p.reason.trim()}`;
  return { save: {
    ...resolved, gameDay: p.to.day, gameTime: p.to.period, timestamp: context.createdAt,
    journal: [...save.journal, { id: `${context.turnId}_time`, timestamp: formatAdventureClock(p.to), realTime: context.createdAt,
      locationName: context.locationName, text: notice, type: "discovery" }],
  }, notice };
}

export function adventureTimeContext(clock?: AdventureClock): string {
  return clock ? `\n【本轮开始的游戏时间】${formatAdventureClock(clock)}\n${JSON.stringify(clock)}\n以此为准，旧日志或聊天中的时间不能覆盖存档时间。\n` : "";
}

export function adventureTimeInstruction(clock?: AdventureClock): string {
  if (!clock) return "";
  return `\n【剧情时间协议】\n在原有 JSON 中增加 time_update。根据本轮实际发生的剧情判断时间，不按消息数量或现实时间硬推进。
短暂交谈、即时反应可以不变，输出 time_update:null；明确经过一上午事务、长途赶路、赴晚宴、等待至夜晚、过夜或数日后，才推进至合适时间。
变化时输出："time_update":{"from":{"day":${clock.day},"period":"${clock.period}"},"to":{"day":${clock.day},"period":"afternoon"},"reason":"本轮经过一上午事务"}。这是格式示例，不是强制推进要求。
day 必须是从1开始的整数，period 仅 morning(清晨)、afternoon(午后)、evening(黄昏)、night(夜晚)。使用绝对目标日期和时段，不输出增量，不倒退。睡一夜为次日清晨；明确数日后可跨多天，但不能无依据跳时。
from 必须等于本轮开始时间。reason 不超过500字，说明已发生的耗时；计划、许诺、假设和对过去的回忆不推进当前时间。正文和 journal 的时间必须与 to 一致，无变化则与当前时间一致。场景切换本身不必自动耗时。\n`;
}
