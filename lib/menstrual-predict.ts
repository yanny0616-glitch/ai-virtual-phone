// 纯日期算术，不读存储、不取当前时间：调用方传入「今天」，脚本才能逐条校验。

export type CycleInterval = { days: number; skipped: boolean };

export type CycleEstimate = {
  source: "records" | "manual";
  cycleLength: number;
  spread: number;
  periodLength: number;
  intervals: CycleInterval[];
};

export type PredictionWindow = {
  anchor: string;
  peak: string;
  start: string;
  end: string;
  lateDays: number;
};

export type PeriodCarePhaseForWindow = "before" | "active" | "late";

const MAX_INTERVALS = 6;
const MIN_CYCLE = 18;
const MAX_CYCLE = 60;
// 漏记一次的间隔约是正常的两倍；1.6 倍以上就不当成真实周期
const DOUBLED_RATIO = 1.6;
const MANUAL_SPREAD = 2;
const LATE_CARE_DAYS = 3;

const toDay = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
const fromDay = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
export const shiftDate = (iso: string, days: number) => fromDay(toDay(iso) + days);
export const daysFrom = (a: string, b: string) => toDay(b) - toDay(a);

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function estimateCycle(
  starts: string[],
  periods: { startDate: string; endDate: string }[],
  manual: { cycleLength: number; periodLength: number },
  auto: boolean,
): CycleEstimate {
  const sorted = Array.from(new Set(starts)).sort();
  const raw = sorted.slice(1).map((s, i) => daysFrom(sorted[i], s)).slice(-MAX_INTERVALS);
  const inRange = raw.filter(d => d >= MIN_CYCLE && d <= MAX_CYCLE);
  const shortest = inRange.length ? Math.min(...inRange) : 0;
  const firstPass = inRange.filter(d => d < shortest * DOUBLED_RATIO);
  const mid = median(firstPass);
  const keep = (d: number) => d >= MIN_CYCLE && d <= MAX_CYCLE && d < shortest * DOUBLED_RATIO
    && mid !== null && Math.abs(d - mid) <= Math.max(7, mid * 0.25);
  const intervals = raw.map(days => ({ days, skipped: !keep(days) }));
  const used = intervals.filter(x => !x.skipped).map(x => x.days);

  const durations = periods
    .map(p => daysFrom(p.startDate, p.endDate) + 1)
    .filter(d => d >= 2 && d <= 10)
    .slice(-MAX_INTERVALS);
  const fromRecords = auto && used.length > 0;
  if (!fromRecords) {
    return { source: "manual", cycleLength: manual.cycleLength, spread: MANUAL_SPREAD, periodLength: manual.periodLength, intervals };
  }
  // 越近的周期权重越高：1, 2, 3…
  const weightSum = used.reduce((n, _, i) => n + i + 1, 0);
  const cycleLength = clamp(Math.round(used.reduce((n, d, i) => n + d * (i + 1), 0) / weightSum), 21, 60);
  const spread = used.length < 3
    ? MANUAL_SPREAD
    : clamp(Math.ceil(used.reduce((n, d) => n + Math.abs(d - cycleLength), 0) / used.length), 1, 4);
  const periodMedian = durations.length >= 2 ? median(durations) : null;
  return {
    source: "records",
    cycleLength,
    spread,
    periodLength: periodMedian === null ? manual.periodLength : clamp(Math.round(periodMedian), 2, 10),
    intervals,
  };
}

// 过了窗口还没记就停在「晚了」；直到下一个窗口开始才当作漏记、往后推一个周期
export function predictWindow(anchor: string, est: CycleEstimate, today: string): PredictionWindow {
  let peak = shiftDate(anchor, est.cycleLength);
  while (daysFrom(shiftDate(peak, est.cycleLength - est.spread), today) >= 0) peak = shiftDate(peak, est.cycleLength);
  const end = shiftDate(peak, est.spread);
  return { anchor, peak, start: shiftDate(peak, -est.spread), end, lateDays: Math.max(0, daysFrom(end, today)) };
}

export function windowsUntil(first: PredictionWindow, est: CycleEstimate, rangeEnd: string): PredictionWindow[] {
  const list: PredictionWindow[] = [];
  for (let peak = first.peak; daysFrom(shiftDate(peak, -est.spread), rangeEnd) >= 0; peak = shiftDate(peak, est.cycleLength)) {
    list.push({ anchor: first.anchor, peak, start: shiftDate(peak, -est.spread), end: shiftDate(peak, est.spread), lateDays: list.length ? 0 : first.lateDays });
  }
  return list;
}

// 前一晚提醒开着时，窗口前一天的「提前关心」让给它，免得同一天收到两条
export function carePhaseForWindow(win: PredictionWindow, targetDate: string, leadDays: number, eveReminderOn: boolean): PeriodCarePhaseForWindow | null {
  if (targetDate < win.start) {
    const until = daysFrom(targetDate, win.start);
    if (until > leadDays || (eveReminderOn && until === 1)) return null;
    return "before";
  }
  if (targetDate < win.peak) return null;
  if (targetDate <= win.end) return "active";
  return win.lateDays >= LATE_CARE_DAYS ? "late" : null;
}

export function eveReminderDate(win: PredictionWindow): string {
  return shiftDate(win.start, -1);
}
