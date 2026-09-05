// 本地时区日历运算。当前时刻由调用方传入，不读取应用状态或系统时钟。
const pad = value => String(value).padStart(2, "0");

export function localDateKey(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

export function formatLocalTime(timestamp) {
  const date = new Date(timestamp);
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}

export function parseLocalDate(value, fallbackMs) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  return match ? new Date(+match[1], +match[2] - 1, +match[3], 12, 0, 0, 0) : new Date(fallbackMs);
}

export function normalizeTime(value) {
  const match = /(\d{1,2})\s*[:：点时.]\s*(\d{1,2})?/.exec(String(value || ""));
  if (!match) return "";
  return pad(Math.min(23, +match[1])) + ":" + pad(Math.min(59, +(match[2] || 0)));
}

export function timeOnLocalDay(value, baseMs) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const date = new Date(baseMs);
  date.setHours(+match[1], +match[2], 0, 0);
  return date.getTime();
}

// 保留原来的“最晚 23:59”规则，不把溢出时间绕到第二天。
export function addMinutes(value, minutes) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return value;
  const total = Math.min(+match[1] * 60 + +match[2] + minutes, 23 * 60 + 59);
  return pad(Math.floor(total / 60)) + ":" + pad(total % 60);
}

export function isInTimeWindow(time, start, end) {
  if (!start || !end || start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function getSleepWindow(day, settings) {
  const bed = normalizeTime(day && day.bed) || (settings && settings.quietStart) || "";
  const wake = normalizeTime(day && day.wake) || (settings && settings.quietEnd) || "";
  // overnight 是旧数据接口名，历史含义为 bed < wake；保留以兼容现有调用方。
  return bed && wake && bed !== wake ? { bed, wake, overnight: bed < wake } : null;
}

export function isAsleep(day, time, settings) {
  const window = getSleepWindow(day, settings);
  return window ? isInTimeWindow(time, window.bed, window.wake) : false;
}
