import { formatIsoDate, parseIsoDate } from "./calendar-utils";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { carePhaseForWindow, daysFrom, estimateCycle, eveReminderDate, predictWindow, windowsUntil, type CycleEstimate, type PredictionWindow } from "./menstrual-predict";

const MENSTRUAL_CONFIG_KEY = "ai_phone_menstrual_config_v1";
const MENSTRUAL_RECORDS_KEY = "ai_phone_menstrual_records_v1";
const MENSTRUAL_PERIOD_CARE_TRIGGERS_KEY = "ai_phone_menstrual_period_care_triggers_v1";
registerKvMigration(MENSTRUAL_CONFIG_KEY);
registerKvMigration(MENSTRUAL_RECORDS_KEY);
registerKvMigration(MENSTRUAL_PERIOD_CARE_TRIGGERS_KEY);

export type MenstrualPeriodCareLeadDays = 1 | 2 | 3;

export type MenstrualConfig = {
  enabled: boolean;
  cycleLength: number;
  periodLength: number;
  currentPeriodStartDate: string | null;
  periodCareEnabled: boolean;
  periodCareCharacterIds: string[];
  periodCareLeadDays: MenstrualPeriodCareLeadDays;
  autoPredict: boolean;
  // "" 表示不提醒
  eveReminderTime: string;
};

export type MenstrualRecord = {
  id: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
};

export type MenstrualDayType = "period" | "predicted_period" | "fertile" | "ovulation";

export type MenstrualDayState = {
  type: MenstrualDayType;
  label: string;
  shortLabel: string;
  peak?: boolean;
};

export type MenstrualPeriodCarePhase = "before" | "active" | "ended" | "late" | "eve";

export type MenstrualPeriodCareEvent = {
  cycleKey: string;
  phase: MenstrualPeriodCarePhase;
  context: string;
};

export type MenstrualPeriodCareTrigger = {
  id: string;
  characterId: string;
  sessionId: string;
  cycleKey: string;
  triggeredAt: string;
};

const DEFAULT_CONFIG: MenstrualConfig = {
  enabled: false,
  cycleLength: 28,
  periodLength: 5,
  currentPeriodStartDate: null,
  periodCareEnabled: false,
  periodCareCharacterIds: [],
  periodCareLeadDays: 1,
  autoPredict: true,
  eveReminderTime: "21:30",
};

// 晚于这个时间才打开 App 就不补发了：半夜收到「今晚早点睡」不对劲
export const EVE_REMINDER_GRACE_MS = 3 * 3_600_000;

function addDays(dateText: string, offset: number): string {
  const date = parseIsoDate(dateText);
  date.setDate(date.getDate() + offset);
  return formatIsoDate(date);
}

function eachDateInclusive(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    result.push(current);
    current = addDays(current, 1);
  }
  return result;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizePeriodCareLeadDays(value: unknown): MenstrualPeriodCareLeadDays {
  const normalized = clampInt(Number(value ?? DEFAULT_CONFIG.periodCareLeadDays), 1, 3);
  return (normalized === 2 || normalized === 3 ? normalized : 1) as MenstrualPeriodCareLeadDays;
}

function normalizeEveReminderTime(value: unknown): string {
  if (value === undefined) return DEFAULT_CONFIG.eveReminderTime;
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "";
}

function normalizeCharacterIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => String(item).trim()).filter(Boolean)));
}

function daysBetween(startDate: string, endDate: string): number {
  const start = parseIsoDate(startDate).getTime();
  const end = parseIsoDate(endDate).getTime();
  return Math.round((end - start) / 86400000);
}

function getCycleKeyForActualStart(records: MenstrualRecord[], cycleLength: number, actualStartDate: string): string {
  const previous = records.find(record => record.startDate < actualStartDate) ?? null;
  if (!previous) return actualStartDate;

  let predicted = addDays(previous.startDate, cycleLength);
  while (addDays(predicted, cycleLength) <= actualStartDate) {
    predicted = addDays(predicted, cycleLength);
  }

  const previousPredicted = addDays(predicted, -cycleLength);
  const candidates = [predicted, previousPredicted];
  const closest = candidates.reduce((best, candidate) => (
    Math.abs(daysBetween(candidate, actualStartDate)) < Math.abs(daysBetween(best, actualStartDate)) ? candidate : best
  ));

  return Math.abs(daysBetween(closest, actualStartDate)) <= 10 ? closest : actualStartDate;
}

function formatEndedDistance(daysAfterEnd: number): string {
  return daysAfterEnd <= 0 ? "今天" : `${daysAfterEnd}天前`;
}

function saveRawConfig(config: MenstrualConfig): MenstrualConfig {
  if (typeof window !== "undefined") {
    kvSet(MENSTRUAL_CONFIG_KEY, JSON.stringify(config));
  }
  return config;
}

export function loadMenstrualConfig(): MenstrualConfig {
  if (typeof window === "undefined") return { ...DEFAULT_CONFIG };
  try {
    const raw = kvGet(MENSTRUAL_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<MenstrualConfig>;
    return {
      enabled: !!parsed.enabled,
      cycleLength: clampInt(Number(parsed.cycleLength ?? DEFAULT_CONFIG.cycleLength), 21, 60),
      periodLength: clampInt(Number(parsed.periodLength ?? DEFAULT_CONFIG.periodLength), 2, 10),
      currentPeriodStartDate:
        typeof parsed.currentPeriodStartDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.currentPeriodStartDate)
          ? parsed.currentPeriodStartDate
          : null,
      periodCareEnabled: parsed.periodCareEnabled === true,
      periodCareCharacterIds: normalizeCharacterIds(parsed.periodCareCharacterIds),
      periodCareLeadDays: normalizePeriodCareLeadDays(parsed.periodCareLeadDays),
      autoPredict: parsed.autoPredict !== false,
      eveReminderTime: normalizeEveReminderTime(parsed.eveReminderTime),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveMenstrualConfig(config: MenstrualConfig): MenstrualConfig {
  return saveRawConfig({
    enabled: !!config.enabled,
    cycleLength: clampInt(config.cycleLength, 21, 60),
    periodLength: clampInt(config.periodLength, 2, 10),
    currentPeriodStartDate: config.currentPeriodStartDate ?? null,
    periodCareEnabled: config.periodCareEnabled === true,
    periodCareCharacterIds: normalizeCharacterIds(config.periodCareCharacterIds),
    periodCareLeadDays: normalizePeriodCareLeadDays(config.periodCareLeadDays),
    autoPredict: config.autoPredict !== false,
    eveReminderTime: normalizeEveReminderTime(config.eveReminderTime ?? ""),
  });
}

export function loadMenstrualRecords(): MenstrualRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(MENSTRUAL_RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is MenstrualRecord => !!entry && typeof entry.startDate === "string" && typeof entry.endDate === "string")
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
  } catch {
    return [];
  }
}

function saveMenstrualRecords(records: MenstrualRecord[]): MenstrualRecord[] {
  const normalized = [...records].sort((a, b) => b.startDate.localeCompare(a.startDate));
  if (typeof window !== "undefined") {
    kvSet(MENSTRUAL_RECORDS_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function validateMenstrualSettings(input: {
  cycleLength: number;
  periodLength: number;
}): string | null {
  if (input.cycleLength < 21 || input.cycleLength > 60) return "周期长度建议在 21 到 60 天之间";
  if (input.periodLength < 2 || input.periodLength > 10) return "经期天数建议在 2 到 10 天之间";
  return null;
}

export function startCurrentPeriod(dateText = formatIsoDate(new Date())): MenstrualConfig {
  const current = loadMenstrualConfig();
  return saveMenstrualConfig({
    ...current,
    enabled: true,
    currentPeriodStartDate: dateText,
  });
}

export function cancelCurrentPeriodStart(dateText = formatIsoDate(new Date())): MenstrualConfig {
  const current = loadMenstrualConfig();
  if (current.currentPeriodStartDate !== dateText) return current;
  const hasHistory = loadMenstrualRecords().length > 0;
  return saveMenstrualConfig({
    ...current,
    enabled: hasHistory ? current.enabled : false,
    currentPeriodStartDate: null,
  });
}

export function finishCurrentPeriod(dateText = formatIsoDate(new Date())): {
  config: MenstrualConfig;
  records: MenstrualRecord[];
  saved: boolean;
} {
  const current = loadMenstrualConfig();
  if (!current.currentPeriodStartDate || current.currentPeriodStartDate > dateText) {
    return { config: current, records: loadMenstrualRecords(), saved: false };
  }
  const now = new Date().toISOString();
  const records = loadMenstrualRecords();
  const nextRecords = saveMenstrualRecords([
    {
      id: `menstrual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      startDate: current.currentPeriodStartDate,
      endDate: dateText,
      createdAt: now,
      updatedAt: now,
    },
    ...records,
  ]);
  const nextConfig = saveMenstrualConfig({
    ...current,
    currentPeriodStartDate: null,
  });
  return { config: nextConfig, records: nextRecords, saved: true };
}

export function cancelFinishCurrentPeriod(dateText = formatIsoDate(new Date())): {
  config: MenstrualConfig;
  records: MenstrualRecord[];
  restored: boolean;
} {
  const current = loadMenstrualConfig();
  const records = loadMenstrualRecords();
  const target = records.find(record => record.endDate === dateText) ?? null;
  if (!target) {
    return { config: current, records, restored: false };
  }
  const nextRecords = saveMenstrualRecords(records.filter(record => record.id !== target.id));
  const nextConfig = saveMenstrualConfig({
    ...current,
    enabled: true,
    currentPeriodStartDate: target.startDate,
  });
  return { config: nextConfig, records: nextRecords, restored: true };
}

export function deleteMenstrualRecord(recordId: string): MenstrualRecord[] {
  const records = loadMenstrualRecords();
  return saveMenstrualRecords(records.filter(entry => entry.id !== recordId));
}

export function loadMenstrualPeriodCareTriggers(): MenstrualPeriodCareTrigger[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(MENSTRUAL_PERIOD_CARE_TRIGGERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is MenstrualPeriodCareTrigger =>
      !!entry
      && typeof entry.id === "string"
      && typeof entry.characterId === "string"
      && typeof entry.sessionId === "string"
      && typeof entry.cycleKey === "string"
      && typeof entry.triggeredAt === "string",
    );
  } catch {
    return [];
  }
}

export function saveMenstrualPeriodCareTrigger(input: {
  characterId: string;
  sessionId: string;
  cycleKey: string;
}): MenstrualPeriodCareTrigger {
  const trigger: MenstrualPeriodCareTrigger = {
    id: `period_care_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    characterId: input.characterId,
    sessionId: input.sessionId,
    cycleKey: input.cycleKey,
    triggeredAt: new Date().toISOString(),
  };
  if (typeof window !== "undefined") {
    kvSet(MENSTRUAL_PERIOD_CARE_TRIGGERS_KEY, JSON.stringify([trigger, ...loadMenstrualPeriodCareTriggers()]));
  }
  return trigger;
}

export function hasMenstrualPeriodCareTriggered(characterId: string, cycleKey: string): boolean {
  return loadMenstrualPeriodCareTriggers().some(trigger => trigger.characterId === characterId && trigger.cycleKey === cycleKey);
}

function setDayState(map: Map<string, MenstrualDayState>, date: string, state: MenstrualDayState) {
  if (map.has(date)) return;
  map.set(date, state);
}

function getPredictionAnchorDate(records: MenstrualRecord[], config: MenstrualConfig): string | null {
  if (config.currentPeriodStartDate) return config.currentPeriodStartDate;
  if (records.length > 0) return records[0].startDate;
  return null;
}

export function getCycleEstimate(records: MenstrualRecord[], config: MenstrualConfig): CycleEstimate {
  const starts = records.map(record => record.startDate);
  if (config.currentPeriodStartDate) starts.push(config.currentPeriodStartDate);
  return estimateCycle(
    starts,
    [...records].reverse(),
    { cycleLength: config.cycleLength, periodLength: config.periodLength },
    config.autoPredict !== false,
  );
}

export function getNextPeriodWindow(
  records: MenstrualRecord[],
  config: MenstrualConfig,
  today = formatIsoDate(new Date()),
): PredictionWindow | null {
  if (!config.enabled) return null;
  const anchorDate = getPredictionAnchorDate(records, config);
  return anchorDate ? predictWindow(anchorDate, getCycleEstimate(records, config), today) : null;
}

export function buildMenstrualDayMap(
  rangeStart: string,
  rangeEnd: string,
  records: MenstrualRecord[],
  config: MenstrualConfig,
): Map<string, MenstrualDayState> {
  const result = new Map<string, MenstrualDayState>();
  if (!config.enabled) return result;
  const today = formatIsoDate(new Date());
  const estimate = getCycleEstimate(records, config);

  for (const record of records) {
    for (const date of eachDateInclusive(record.startDate, record.endDate)) {
      if (date < rangeStart || date > rangeEnd) continue;
      result.set(date, { type: "period", label: "经期中", shortLabel: "经期" });
    }
  }

  if (config.currentPeriodStartDate) {
    const predictedCurrentEnd = addDays(config.currentPeriodStartDate, Math.max(estimate.periodLength - 1, 0));
    const actualCurrentEnd = today < predictedCurrentEnd ? today : predictedCurrentEnd;
    const currentActiveEnd = actualCurrentEnd < rangeEnd ? actualCurrentEnd : rangeEnd;
    if (config.currentPeriodStartDate <= currentActiveEnd) {
      for (const date of eachDateInclusive(config.currentPeriodStartDate, currentActiveEnd)) {
        if (date < rangeStart || date > rangeEnd) continue;
        result.set(date, { type: "period", label: "经期中", shortLabel: "经期" });
      }
    }

    if (today < predictedCurrentEnd) {
      const predictedFollowStart = addDays(today, 1);
      const predictedFollowEnd = predictedCurrentEnd < rangeEnd ? predictedCurrentEnd : rangeEnd;
      if (predictedFollowStart <= predictedFollowEnd) {
        for (const date of eachDateInclusive(predictedFollowStart, predictedFollowEnd)) {
          if (date < rangeStart || date > rangeEnd) continue;
          setDayState(result, date, { type: "predicted_period", label: "预计经期", shortLabel: "预计" });
        }
      }
    }
  }

  const anchorDate = getPredictionAnchorDate(records, config);
  if (!anchorDate) return result;

  for (const window of windowsUntil(predictWindow(anchorDate, estimate, today), estimate, rangeEnd)) {
    for (let offset = -estimate.spread; offset <= estimate.spread; offset += 1) {
      const date = addDays(window.peak, offset);
      if (date < rangeStart || date > rangeEnd) continue;
      setDayState(result, date, offset === 0
        ? { type: "predicted_period", label: "最可能来", shortLabel: "最可能", peak: true }
        : { type: "predicted_period", label: "可能来", shortLabel: "可能" });
    }

    const ovulationDate = addDays(window.peak, -14);
    if (ovulationDate >= rangeStart && ovulationDate <= rangeEnd) {
      setDayState(result, ovulationDate, { type: "ovulation", label: "预计排卵", shortLabel: "排卵" });
    }
    for (let offset = -5; offset <= 1; offset += 1) {
      const date = addDays(ovulationDate, offset);
      if (date < rangeStart || date > rangeEnd) continue;
      setDayState(result, date, { type: "fertile", label: "易孕期", shortLabel: "易孕" });
    }
  }

  return result;
}

export function getNextPredictedPeriodStart(
  records: MenstrualRecord[],
  config: MenstrualConfig,
  fromDate = formatIsoDate(new Date()),
): string | null {
  return getNextPeriodWindow(records, config, fromDate)?.peak ?? null;
}

export function getMenstrualPeriodCareEvent(
  records: MenstrualRecord[],
  config: MenstrualConfig,
  targetDate = formatIsoDate(new Date()),
): MenstrualPeriodCareEvent | null {
  if (!config.enabled || !config.periodCareEnabled) return null;
  const estimate = getCycleEstimate(records, config);

  if (config.currentPeriodStartDate && config.currentPeriodStartDate <= targetDate) {
    const startDate = config.currentPeriodStartDate;
    const cycleKey = getCycleKeyForActualStart(records, estimate.cycleLength, startDate);
    const predictedEndDate = addDays(startDate, Math.max(estimate.periodLength - 1, 0));
    const dayIndex = daysBetween(startDate, targetDate) + 1;
    if (targetDate <= predictedEndDate) {
      return {
        cycleKey,
        phase: "active",
        context: `{{user}}已记录经期从${startDate}开始，现在可能处于第${dayIndex}天。`,
      };
    }

    const daysAfterPredictedEnd = daysBetween(predictedEndDate, targetDate);
    if (daysAfterPredictedEnd <= 5) {
      return {
        cycleKey,
        phase: "ended",
        context: `{{user}}已记录经期从${startDate}开始；按周期长度推算，可能已经结束${daysAfterPredictedEnd}天，但用户尚未记录结束。`,
      };
    }
    return null;
  }

  const latest = records[0] ?? null;
  if (latest && latest.endDate <= targetDate) {
    const daysAfterActualEnd = daysBetween(latest.endDate, targetDate);
    if (daysAfterActualEnd <= 5) {
      return {
        cycleKey: getCycleKeyForActualStart(records, estimate.cycleLength, latest.startDate),
        phase: "ended",
        context: `{{user}}已记录经期已于${latest.endDate}结束，是${formatEndedDistance(daysAfterActualEnd)}结束的。`,
      };
    }
  }

  const anchorDate = getPredictionAnchorDate(records, config);
  if (!anchorDate) return null;
  const window = predictWindow(anchorDate, estimate, targetDate);
  const phase = carePhaseForWindow(window, targetDate, config.periodCareLeadDays, !!config.eveReminderTime);
  if (phase === "before") {
    return {
      cycleKey: window.peak,
      phase,
      context: `按预测，{{user}}的经期可能在${window.start}到${window.end}之间来，最可能是${window.peak}，还有${daysFrom(targetDate, window.peak)}天。`,
    };
  }
  if (phase === "active") {
    return {
      cycleKey: window.peak,
      phase,
      context: `按预测，{{user}}的经期可能已经来了（最可能是${window.peak}），但{{user}}还没有记录。`,
    };
  }
  if (phase === "late") {
    return {
      cycleKey: `${window.peak}:late`,
      phase,
      context: `按预测，{{user}}的经期本该在${window.start}到${window.end}之间来，现在过了${window.lateDays}天还没有记录，也可能只是忘了记。只关心{{user}}最近身体和心情怎么样，不追问，不猜原因，别让{{user}}紧张。`,
    };
  }
  return null;
}

export type MenstrualEveReminder = MenstrualPeriodCareEvent & { date: string; fireAtMs: number };

export function getMenstrualEveReminder(
  records: MenstrualRecord[],
  config: MenstrualConfig,
  now = new Date(),
): MenstrualEveReminder | null {
  if (!config.enabled || !config.periodCareEnabled || !config.eveReminderTime) return null;
  const today = formatIsoDate(now);
  const window = getNextPeriodWindow(records, config, today);
  if (!window) return null;
  const date = eveReminderDate(window);
  if (date < today) return null;
  const fireAt = parseIsoDate(date);
  const [hour, minute] = config.eveReminderTime.split(":").map(Number);
  fireAt.setHours(hour, minute, 0, 0);
  return {
    cycleKey: `${window.peak}:eve`,
    phase: "eve",
    date,
    fireAtMs: fireAt.getTime(),
    context: `按预测，{{user}}的经期最早可能明天（${window.start}）来，最可能是${window.peak}。现在是前一晚，提醒{{user}}一句：包里备好卫生巾、早点休息、别吃冰的。用你自己的方式自然地说，别说教，也别像闹钟。`,
  };
}

export function getMenstrualSummary(records: MenstrualRecord[], config: MenstrualConfig, targetDate = formatIsoDate(new Date())) {
  const today = formatIsoDate(new Date());
  const latest = records[0] ?? null;
  const nextPredicted = getNextPredictedPeriodStart(records, config);
  const todayState = buildMenstrualDayMap(targetDate, targetDate, records, config).get(targetDate) ?? null;
  const todayStarted = config.currentPeriodStartDate === targetDate || records.some(record => record.startDate === targetDate);
  const todayFinished = records.some(record => record.endDate === targetDate);
  return {
    latest,
    nextPredicted,
    todayState,
    todayStarted,
    todayFinished,
    currentPeriodStartDate: config.currentPeriodStartDate,
    isPeriodActive: !!config.currentPeriodStartDate,
  };
}
