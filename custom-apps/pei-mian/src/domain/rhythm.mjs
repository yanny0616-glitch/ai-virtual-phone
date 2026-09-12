// 哄睡节奏：把「说几段、每段多少字、间隔从多少秒拉到多少分钟」算成一张时间表。
// 纯函数，Node 测试直接 import。

export const RHYTHM_PRESETS = Object.freeze({
  gentle: { id: "gentle", name: "轻柔", segments: 5, firstChars: 90, lastChars: 20, firstGapSec: 40, lastGapSec: 300 },
  brief: { id: "brief", name: "简短", segments: 3, firstChars: 60, lastChars: 15, firstGapSec: 30, lastGapSec: 180 },
  long: { id: "long", name: "漫长", segments: 8, firstChars: 120, lastChars: 12, firstGapSec: 45, lastGapSec: 480 },
});

export const DIRECTIONS = Object.freeze([
  { id: "today", label: "讲今天", hint: "回顾今天发生的事，捡安静的说" },
  { id: "self", label: "讲TA自己", hint: "TA自己的小事、TA的一天" },
  { id: "trivia", label: "无关的小事", hint: "和你们都无关的、没有意义的小画面" },
  { id: "breath", label: "数呼吸", hint: "带着数呼吸、放松身体" },
  { id: "scene", label: "描述安静的画面", hint: "一个静止的、缓慢的场景" },
  { id: "hum", label: "只是陪着", hint: "几乎不说什么，只是在" },
]);

export function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeRhythm(input) {
  const base = RHYTHM_PRESETS.gentle;
  const r = input && typeof input === "object" ? input : {};
  return {
    segments: clampInt(r.segments, 1, 12, base.segments),
    firstChars: clampInt(r.firstChars, 10, 300, base.firstChars),
    lastChars: clampInt(r.lastChars, 5, 300, base.lastChars),
    firstGapSec: clampInt(r.firstGapSec, 5, 1800, base.firstGapSec),
    lastGapSec: clampInt(r.lastGapSec, 5, 3600, base.lastGapSec),
  };
}

// 段与段之间用缓出曲线：前面密、后面疏。返回每段 { index, chars, gapAfterSec }。
export function buildSchedule(rhythmInput) {
  const r = normalizeRhythm(rhythmInput);
  const n = r.segments;
  const steps = [];
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 1 : i / (n - 1);
    const eased = 1 - Math.pow(1 - t, 2);
    const chars = Math.round(r.firstChars + (r.lastChars - r.firstChars) * eased);
    const gapAfterSec = i === n - 1 ? 0 : Math.round(r.firstGapSec + (r.lastGapSec - r.firstGapSec) * eased);
    steps.push({ index: i, chars: Math.max(5, chars), gapAfterSec });
  }
  return steps;
}

export function totalScheduleSeconds(rhythmInput) {
  return buildSchedule(rhythmInput).reduce((sum, step) => sum + step.gapAfterSec, 0);
}

export function describeSchedule(rhythmInput) {
  const sec = totalScheduleSeconds(rhythmInput);
  const r = normalizeRhythm(rhythmInput);
  const mins = Math.round(sec / 60);
  return `${r.segments} 段 · 约 ${mins} 分钟说完 · 从 ${r.firstChars} 字降到 ${r.lastChars} 字`;
}
