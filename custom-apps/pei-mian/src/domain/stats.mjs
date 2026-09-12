// 夜记统计：每晚一条记录 → 每天/每周/每月的汇总。纯函数。
// 记录字段：date(YYYY-MM-DD，按入睡当晚算)、sleepAt/wakeAt(ISO)、durationMin、rating(1-5|0)、wakeups、mode、mixName、lastLine、note、morningLine

const DAY_MS = 86400000;

export function pad2(n) { return String(n).padStart(2, "0"); }

export function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 凌晨 6 点前入睡算前一晚
export function nightKeyFor(date) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  return localDateKey(d);
}

export function minutesBetween(startIso, endIso) {
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 60000);
}

// 入睡时刻换成「相对 18:00 的分钟数」，这样 23:30 和 01:10 能平均
export function bedtimeMinutes(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let m = d.getHours() * 60 + d.getMinutes() - 18 * 60;
  if (m < 0) m += 24 * 60;
  return m;
}

export function formatBedtime(minutesFrom18) {
  if (minutesFrom18 == null) return "--:--";
  const abs = (minutesFrom18 + 18 * 60) % (24 * 60);
  return `${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function formatDuration(min) {
  if (!min) return "--";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? pad2(m) : ""}` : `${m}m`;
}

function average(values) {
  const list = values.filter(v => typeof v === "number" && Number.isFinite(v));
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

export function weekStartKey(date, weekStartsOn = 1) {
  const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return localDateKey(d);
}

export function addDays(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  return localDateKey(date);
}

export function weekDays(startKey) {
  return Array.from({ length: 7 }, (_, i) => addDays(startKey, i));
}

export function summarizeWeek(nights, startKey, goal) {
  const days = weekDays(startKey);
  const byDate = new Map(nights.map(n => [n.date, n]));
  const rows = days.map(date => ({ date, night: byDate.get(date) || null }));
  const present = rows.filter(r => r.night && r.night.durationMin > 0).map(r => r.night);
  const durations = present.map(n => n.durationMin);
  const bedtimes = present.map(n => bedtimeMinutes(n.sleepAt)).filter(v => v != null);
  const goalMin = goal && goal.hours ? Math.round(goal.hours * 60) : null;
  const goalBed = goal && goal.bedtime ? bedtimeMinutes(`1970-01-02T${goal.bedtime}:00`) : null;
  const mixCount = new Map();
  for (const n of present) if (n.mixName) mixCount.set(n.mixName, (mixCount.get(n.mixName) || 0) + 1);
  let topMix = null;
  for (const [name, count] of mixCount) if (!topMix || count > topMix.count) topMix = { name, count };
  return {
    startKey,
    days: rows,
    nightsLogged: present.length,
    avgDurationMin: average(durations),
    avgBedtime: average(bedtimes),
    bedtimeSpread: bedtimes.length > 1 ? Math.max(...bedtimes) - Math.min(...bedtimes) : 0,
    totalWakeups: present.reduce((s, n) => s + (n.wakeups || 0), 0),
    avgRating: average(present.map(n => n.rating || null)),
    topMix,
    goalDurationHits: goalMin ? durations.filter(d => d >= goalMin).length : null,
    goalBedtimeHits: goalBed != null ? bedtimes.filter(b => b <= goalBed + 15).length : null,
  };
}

export function compareWeeks(current, previous) {
  const dur = current.avgDurationMin != null && previous.avgDurationMin != null ? Math.round(current.avgDurationMin - previous.avgDurationMin) : null;
  const bed = current.avgBedtime != null && previous.avgBedtime != null ? Math.round(current.avgBedtime - previous.avgBedtime) : null;
  return { durationDeltaMin: dur, bedtimeDeltaMin: bed };
}

export function streakDays(nights, todayKey) {
  const set = new Set(nights.filter(n => n.durationMin > 0).map(n => n.date));
  let key = set.has(todayKey) ? todayKey : addDays(todayKey, -1);
  let count = 0;
  while (set.has(key)) { count += 1; key = addDays(key, -1); }
  return count;
}

export function monthGrid(year, month /* 1-12 */, weekStartsOn = 1) {
  const first = new Date(year, month - 1, 1);
  const lead = (first.getDay() - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(`${year}-${pad2(month)}-${pad2(d)}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export const _internal = { DAY_MS, average };

// 同晚分段：闭合区间取并集，避免旧重复记录重叠计时；缺少分段的旧记录仍可读取。
export function nightIntervals(night) {
  const values = Array.isArray(night.sleepIntervals) ? night.sleepIntervals
    : night.wakeAt ? [{ start: night.sleepAt, end: night.wakeAt }] : [];
  return values.filter(x => Number.isFinite(Date.parse(x.start)) && Date.parse(x.end) > Date.parse(x.start))
    .map(x => ({ start: x.start, end: x.end }));
}
export function unionNightIntervals(values) {
  const sorted = values.map(x => [Date.parse(x.start), Date.parse(x.end)]).filter(([a,b]) => Number.isFinite(a) && b > a).sort((a,b) => a[0]-b[0]);
  const out = [];
  for (const [a,b] of sorted) {
    const last = out[out.length-1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a,b]);
  }
  return out.map(([a,b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString() }));
}
export function intervalMinutes(intervals) {
  return Math.round(unionNightIntervals(intervals).reduce((n,x) => n + Date.parse(x.end)-Date.parse(x.start), 0)/60000);
}
export function uniqueNights(rows) {
  const groups = new Map();
  for (const row of rows.filter(n => n && n.date)) { const list=groups.get(row.date)||[];list.push(row);groups.set(row.date,list); }
  return [...groups.values()].map(all => {
    const shadowed = new Set(all.flatMap(n => n.mergedNightIds || []));
    const live = all.filter(n => !shadowed.has(n.id));
    const list = (live.length ? live : all).slice().sort((a,b) => String(a.sleepAt).localeCompare(String(b.sleepAt)) || String(a.updatedAt||'').localeCompare(String(b.updatedAt||'')));
    if (list.length === 1) return { ...list[0] };
    const latest = list[list.length-1];
    const intervals = unionNightIntervals(list.flatMap(nightIntervals));
    const open = list.filter(n => !n.wakeAt).at(-1);
    const openStart = open?.segmentSleepAt || open?.sleepAt;
    const covered = openStart && intervals.some(x => Date.parse(x.end) >= Date.parse(openStart));
    const isOpen = open && !covered;
    return { ...latest, sleepAt: list[0].sleepAt, sleepIntervals: intervals,
      wakeAt: isOpen ? '' : intervals.at(-1)?.end || latest.wakeAt || '',
      segmentSleepAt: isOpen ? openStart : '', durationMin: intervalMinutes(intervals),
      wakeups: Math.max(list.length-1,...list.map(n=>n.wakeups||0)),
      note: [...new Set(list.map(n=>n.note).filter(Boolean))].join('\n'),
      mergedNightIds: [...new Set(all.flatMap(n=>[n.id,...(n.mergedNightIds||[])])).values()].filter(id=>id && id!==latest.id),
    };
  }).sort((a,b)=>b.date.localeCompare(a.date));
}
