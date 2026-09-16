// 挂念的数据形状。字段名与 push-recheck / 挂念 App 保持一致，迁移时计划行的 context 可以直接拆进来。

export type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

export type ModelRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };

export type GuanianSched = {
  time?: string; end?: string; title?: string; place?: string; note?: string; cost?: number; mood?: string; busy?: boolean;
  steps?: { time?: string; what?: string }[]; fork?: string; moved?: boolean;
};
export type GuanianCond = { startAt?: number; halfLifeMin?: number; intensity?: number; energyDelta?: number; mood?: string; cause?: string };
export type GuanianDay = {
  tz?: number; mood?: string; moodEmoji?: string; energy?: number; location?: string; doing?: string; sleep?: string;
  wake?: string; bed?: string; schedule?: GuanianSched[]; conds?: GuanianCond[];
  forks?: any[]; forkSeed?: string; forkBurst?: number;
};

export type PlanItem = {
  time: string;
  fireAt: number;
  source: string;
  act: boolean;
  /** 出自账本哪件事（账本 id） */
  from?: string;
  intent: string;
  why: string;
  sem: string;
  topic: string;
  /** 后端定时器 id；发出去的 push_outbox.trigger_key = timedwake:<wakeId> */
  wakeId: string;
  origFireAt?: number;
  until?: number;
  /** plan / extra / promise / thread done miss echo quiet fork */
  kind?: string;
  generatedAt?: number;
  promiseRevision?: number;
  matterId?: string; matterRelation?: string; matterEvidenceId?: string; matterSuppressed?: boolean;
};

export type Thread = {
  id: string; kind: string; text: string; due?: number; yearly?: boolean; since?: number; at?: number; by?: string; done?: boolean;
  nudge?: string; why?: string; subject?: string; status?: string; revision?: number; sourceMessageId?: string; mentionedAt?: number;
  matterId?: string; matterRelation?: string; matterEvidenceId?: string;
};
export type Keep = {
  id?: string; subject?: string; status?: string; sourceMessageId?: string; kind?: string; text?: string; when?: string; why?: string;
  matterId?: string; matterRelation?: string; matterEvidenceId?: string;
};
export type Decision = { time?: string; act?: boolean; sem?: string; topic?: string; why?: string; intent?: string; defer?: string };
export type Extra = {
  time?: string; until?: string; about?: string; intent?: string; why?: string; from?: string;
  matterId?: string; matterRelation?: string; matterEvidenceId?: string;
};
export type Outbox = { id: string; at: number; hint: string; by?: string };
export type FbBook = Record<string, [number, number]>;

/** 规则函数看到的上下文：设置 + 跨天状态 + 当天状态拼在一起，形状与云端 PlanContext 相同。 */
export type Ctx = {
  tzOffsetMin: number;
  quota?: number; quietStart?: string; quietEnd?: string;
  userSleepOn?: number; userSleepStart?: string; userSleepEnd?: string; userSleepTimeZone?: string; userSleepTz?: number;
  minGapMin?: number; maxUnanswered?: number; chatCandidates?: string; bias?: string;
  onlineRounds?: number; offlineRounds?: number; judgeLines?: number;
  gateDailyCap?: number; gateGapMin?: number; gateHorizonMin?: number; gateFreshMin?: number; gateMinMsgs?: number;
  selfImpulseCap?: number; selfSilenceMin?: number; missDays?: number; echoOn?: number;
  busyHold?: number; busyBufferMin?: number; busyMaxHoldMin?: number; sleepMode?: number; sleepWakeProb?: number;
  presendMax?: number; presendTalkingMin?: number; presendGapMin?: number;
  momentsOn?: number; momentsWeekly?: number; momentsGapH?: number;
  threadDays?: number; recheckEnabled?: number; genEnabled?: number;
  autoGenAt?: string; forkLevel?: number; forkBurst?: number; dayPrompt?: string; moodGate?: number;
  affection?: { score?: number; tier?: string; relation?: string } | null;
  // 跨天状态
  threads?: Thread[]; fb?: FbBook; fbSeen?: string[]; missKey?: number; echoKey?: number;
  momentsLast?: number; momentsWeekStart?: number; momentsWeekN?: number; momentsRollHour?: number; outbox?: Outbox[];
  // 当天
  day?: GuanianDay | null; selfUsed?: number;
  [key: string]: unknown;
};

/** 设置里的键（App 同步过来）；其余可写的状态键见 STATE_KEYS。 */
export const SETTING_KEYS = [
  "quota", "quietStart", "quietEnd", "userSleepOn", "userSleepStart", "userSleepEnd", "userSleepTimeZone", "userSleepTz",
  "minGapMin", "maxUnanswered", "chatCandidates", "bias", "onlineRounds", "offlineRounds", "judgeLines",
  "gateDailyCap", "gateGapMin", "gateHorizonMin", "gateFreshMin", "gateMinMsgs", "selfImpulseCap", "selfSilenceMin",
  "missDays", "echoOn", "busyHold", "busyBufferMin", "busyMaxHoldMin", "sleepMode", "sleepWakeProb",
  "presendMax", "presendTalkingMin", "presendGapMin", "momentsOn", "momentsWeekly", "momentsGapH", "threadDays",
  "recheckEnabled", "genEnabled", "autoGenAt", "forkLevel", "forkBurst", "dayPrompt", "moodGate", "affection", "tzOffsetMin",
] as const;

export const STATE_KEYS = [
  "threads", "fb", "fbSeen", "missKey", "echoKey", "momentsLast", "momentsWeekStart", "momentsWeekN", "momentsRollHour", "outbox",
] as const;
