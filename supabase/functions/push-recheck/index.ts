// 云端动态复核（Supabase Edge Function 版）
// 部署：Dashboard → Edge Functions → 新建函数 push-recheck → 粘贴本文件 →
//      关闭 JWT 校验（Enforce JWT verification = off，本函数用 cron_secret 自校验）
// 职责：cron 每 30 分钟派一份计划过来 → 只在聊天镜像出现新的用户消息时才动 →
//      借待发预约里冻结的 LLM 凭据发一次裁决 → 撤销/点亮/临时起念直接改 push_jobs →
//      裁决同时留在 push_recheck_plans.decisions，等挂念 App 下次打开合并进本地轨迹。
// 注意：本函数不重建角色提示词——点亮和临时起念是克隆同一天某条预约的快照再追加
//      一句新意图，所以人设/世界书跟着那条快照走，不会比 App 现排的更旧。

type ProviderKind = "openai-compatible" | "anthropic" | "gemini";
type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

type JobRow = { id: string; trigger_key: string; status: string; execute_at: string; payload: EncryptedPayload };
type JobPayload = {
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  notify?: { title?: string; url?: string; characterId?: string };
  merge?: Record<string, unknown> & { sessionId?: string };
  [key: string]: unknown;
};

type PlanItem = { promiseRevision?: number; generatedAt?: number;
  time: string;
  fireAt: number;
  source: string;
  act: boolean;
  /** 这条时刻出自账本里哪件事（账本 id）：发出去之后回写账本，用户了结时连带撤掉 */
  from?: string;
  intent: string;
  why: string;
  sem: string;
  topic: string;
  wakeId: string;
  origFireAt?: number;
  /** 这个念头的保质期：过了就不新鲜了，改约只能挪到它之前 */
  until?: number;
  /** 由头种类：plan 早上定的 / extra 聊天里冒的 / thread done miss echo quiet 自发五种。回音率按它归类 */
  kind?: string;
};
type PlanContext = {
  tzOffsetMin?: number | null;
  mood?: string;
  energy?: string;
  quota?: number;
  quietStart?: string;
  quietEnd?: string;
  /** 用户自己的可选睡眠窗，仅用于回音等待计时，与角色作息独立。 */
  userSleepOn?: number;
  userSleepStart?: string;
  userSleepEnd?: string;
  userSleepTimeZone?: string;
  userSleepTz?: number;
  minGapMin?: number;
  maxUnanswered?: number;
  chatCandidates?: string;
  bias?: string;
  wakePrefix?: string;
  onlineRounds?: number;
  offlineRounds?: number;
  gateDailyCap?: number;
  gateGapMin?: number;
  gateHorizonMin?: number;
  gateFreshMin?: number;
  gateMinMsgs?: number;
  selfImpulseCap?: number;
  /** 0=早上一把定完（旧）  1=随用随判：编排不排念头，白天由云端随时起 */
  impulseMode?: number;
  /** 多久没联系算「安静太久」（分钟） */
  selfSilenceMin?: number;
  /** 断了几天算「想念」；0=关。每段断联只掷一次骰子，掷过的记 missKey（用户最后一句的时间戳），App 跨天带着 */
  missDays?: number;
  missKey?: number;
  /** 昨天的余韵：1=开。每天只掷一次，掷过的记 echoKey（本地日序号） */
  echoOn?: number;
  echoKey?: number;
  /** 各类由头的回音账 { kind: [发过几次, 回了几次] }，App 跨天带着；fbSeen 是已经记过账的 wakeId */
  fb?: Record<string, [number, number]>;
  fbSeen?: string[];
  /** 改约的总上限，和「忙就押后」共用同一个设置 */
  busyMaxHoldMin?: number;
  selfUsed?: number;
  /** 聊天插件「好感与关系」算出来的分寸，App 编排时寄来；没装插件就没有 */
  affection?: { score?: number; tier?: string; relation?: string } | null;
  day?: GuanianDay;
  genKit?: GenKit | null;
  /** 惦记账本：App 从聊天里记下的话头 / 约定 / 日子，跨天带着；云端复核也往里记、往外销 */
  threads?: Thread[];
  threadDays?: number;
  /** 发朋友圈：云端发不了帖，起意写进 outbox，App 下次打开按 at 那个时间点补发。
   *  配速（一周几条、至少隔几小时）和发圈账（上一条时间、本周条数）App 与云端共用一套，合并取大 */
  momentsOn?: number;
  momentsWeekly?: number;
  momentsGapH?: number;
  momentsLast?: number;
  momentsWeekStart?: number;
  momentsWeekN?: number;
  momentsRollHour?: number;
  outbox?: Outbox[];
  generatedBy?: string;
  genTries?: number;
  [key: string]: unknown;
};
// 挂念寄存的当天原料：日程带 cost/情绪，conds 是还在起作用的聊天情绪。算法与挂念 index.html
// 的 energyAt / moodNow 一致，改一处要同步另一处（push-generate 里也有一份）。
type GuanianSched = { time?: string; end?: string; title?: string; cost?: number; mood?: string; busy?: boolean; steps?: { time?: string; what?: string }[] };
type GuanianCond = { startAt?: number; halfLifeMin?: number; intensity?: number; energyDelta?: number; mood?: string; cause?: string };
type GuanianDay = {
  tz?: number; mood?: string; energy?: number; location?: string; doing?: string;
  wake?: string; bed?: string; schedule?: GuanianSched[]; conds?: GuanianCond[];
};
// 睡眠窗：bed 起到 wake 止，允许过零点；老版本 App 没寄 wake/bed 时退回免打扰时段。与 App 端 asleepAt 同步。
function guanianAsleep(day: GuanianDay, hm: string, quietStart?: string, quietEnd?: string): boolean {
  const bed = /^\d{2}:\d{2}$/.test(String(day.bed || "")) ? String(day.bed) : String(quietStart || "");
  const wake = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(quietEnd || "");
  if (!bed || !wake || bed === wake) return false;
  return bed < wake ? (hm >= bed && hm < wake) : (hm >= bed || hm < wake);
}
function affectionLine(aff: { tier?: string; relation?: string } | null | undefined): string {
  if (!aff || (!aff.tier && !aff.relation)) return "";
  return `你对用户：${aff.tier || "说不上"}；两人现在的关系：${aff.relation || "没定"}。想不想找TA、找了说什么，都按这个分寸来。`;
}
// 自发起念的由头分五种，各有口径：想念不催回复、余韵不求回应、惦记像随口问起、安静太久才是搭话
const SELF_KIND: Record<string, string> = { thread: "惦记", done: "刚忙完", miss: "想念", echo: "余韵", quiet: "安静太久" };
// 沉默无法证明不喜欢：不把未接话次数交给模型当负反馈。
function fbLine(fb: FbBook | undefined, kind: string): string {
  const rec = fb && Array.isArray(fb[kind]) ? fb[kind] : [0, 0];
  const replied = Math.max(0, Math.min(Number(rec[0]) || 0, Number(rec[1]) || 0));
  if (replied < 3) return "没有足够的接话记录可判断偏好；用户可能在忙、睡觉或没有看到消息，未回复不代表不喜欢，不要因此责怪或催促。";
  return `这类由头之后记录到用户接话 ${replied} 次，可作为轻微的正向参考，不代表每次都想聊。未回复不作为负面偏好，不据此判断用户冷淡或不喜欢，也不要催回复。`;
}
function selfBrief(kind: string, reason: string): string {
  if (kind === "miss") return `没有新对话。${reason}，最后一句是用户说的，不是你发了没人回。按你的性子和现在的关系想一想会不会有点想TA——本来就不主动的人、关系还生疏的，就不发。要发也只轻轻带一句想念或近况，不问「怎么不理我」，不催TA回。`;
  if (kind === "echo") return `没有新对话。由头是${reason}——从昨天的对话里挑一件轻松的小事（吃的、看的、随口说过的），像忽然想起来那样顺手提一句，不要求TA回应；昨天的事已经过去或已经说清楚了就别提，别翻旧账、别追问结果。`;
  if (kind === "thread") return `没有新对话。由头是心里挂着的事：${reason}。像朋友随口问起，不像提醒或查岗；上面聊到的事已经了了就写 []。`;
  return `没有新对话。由头是你自己这边的事：${reason}。想一想此刻的你会不会想找用户说点什么——分享刚发生的、忽然想起TA、单纯想搭句话都行；上面聊到的事已经了了就写 []。`;
}
// 由头的分量：三分值（要紧 / 温度 / 急迫）合成 0–1，再乘各自的时间曲线和接话正反馈。
// 曲线不是统一衰减：刚忙完几小时内掉光，约定靠近到点反而涨，想念断得越久越重，安静太久是平的
const KIND_VAL: Record<string, [number, number, number]> = {
  thread: [0.7, 0.6, 0.7], done: [0.6, 0.5, 0.4], miss: [0.6, 0.9, 0.3], echo: [0.4, 0.7, 0.2],
  quiet: [0.3, 0.5, 0.2], extra: [0.7, 0.6, 0.6], plan: [0.5, 0.5, 0.4],
};
type FbBook = Record<string, [number, number]>;
// 只用正反馈：至少 3 次接话后轻微加权，最多 1.2 倍；未回应不会降低已有权重。
// 保留旧 [发送数, 接话数] 数据格式，历史未回应无需迁移且不再扣分。
function fbMod(fb: FbBook | undefined, kind: string): number {
  const rec = fb && Array.isArray(fb[kind]) ? fb[kind] : [0, 0];
  const replied = Math.max(0, Math.min(Number(rec[0]) || 0, Number(rec[1]) || 0));
  return replied < 3 ? 1 : 1 + Math.min(0.2, (replied - 2) * 0.04);
}

function impulseValue(kind: string, curve: number, fb: FbBook | undefined): number {
  const [sal, warm, urg] = KIND_VAL[kind] || KIND_VAL.quiet;
  return Math.max(0, Math.min(1, (sal + urg * 0.9 + warm * 0.7) / 2.6 * Math.max(0, Math.min(1, curve)) * fbMod(fb, kind)));
}
// 额度快用完时只让分量够的由头过：剩 2 个要 0.45，剩 1 个要 0.65，更多不设槛
function valueFloor(remaining: number): number {
  return remaining <= 1 ? 0.65 : remaining === 2 ? 0.45 : 0;
}
// 累积 3 小时非睡眠时间；未满返回 null。按绝对分钟推进，保留秒/毫秒边界，
// IANA 时区负责夏令时的重复/缺失小时；旧客户端没有开关时完全沿用原窗口。
function feedbackWindowEnd(sentAt: number, context: PlanContext, nowMs: number): number | null {
  const duration = 3 * 3600_000;
  const regularEnd = sentAt + duration;
  if (regularEnd > nowMs) return null;
  if (context.userSleepOn !== 1) return regularEnd <= nowMs ? regularEnd : null;
  const parse = (value: unknown): number | null => {
    const m = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(String(value || ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = parse(context.userSleepStart), end = parse(context.userSleepEnd);
  if (start === null || end === null || start === end) return regularEnd <= nowMs ? regularEnd : null;
  let format: Intl.DateTimeFormat | null = null;
  try {
    if (context.userSleepTimeZone) format = new Intl.DateTimeFormat("en-GB", {
      timeZone: context.userSleepTimeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch { /* 无效/不支持的时区使用上传时的 UTC 偏移 */ }
  const offset = Math.max(-840, Math.min(840, Number(context.userSleepTz) || 0));
  let remaining = duration, cursor = sentAt;
  while (cursor < nowMs) {
    let minute: number;
    if (format) {
      const parts = format.formatToParts(new Date(cursor));
      minute = Number(parts.find(p => p.type === "hour")?.value) * 60 + Number(parts.find(p => p.type === "minute")?.value);
    } else {
      const local = new Date(cursor + offset * 60_000);
      minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    }
    const asleep = start < end ? minute >= start && minute < end : minute >= start || minute < end;
    const next = Math.min(nowMs, (Math.floor(cursor / 60_000) + 1) * 60_000);
    if (!asleep) {
      if (remaining <= next - cursor) return cursor + remaining;
      remaining -= next - cursor;
    }
    cursor = next;
  }
  return null;
}
// 记回音账：按实际发送后的有效 3 小时窗口统计接话，可选用户睡眠时段不计时；未接话不降低偏好权重。
// 先看 push_jobs 的执行结果——result_note 以 generated / sent 开头才算「发过」
// （押后作罢、发送前拦下、睡着没发的都不算），用户在有效等待窗口内接了话才算「回了」（启用睡眠暂停后可能跨到次日）。
// 凭据是这条预约自己的结果，不拿聊天记录里恰好有的一句冒充。每个 wakeId 只记一次，不调模型
async function feedbackRoll(
  rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string, characterId: string,
  items: PlanItem[], context: PlanContext, nowMs: number,
): Promise<{ fb: FbBook; fbSeen: string[]; settled: string[] } | null> {
  const settled: string[] = [];
  const seen = Array.isArray(context.fbSeen) ? context.fbSeen.map(String) : [];
  const fb: FbBook = {};
  for (const [k, v] of Object.entries(context.fb || {})) if (Array.isArray(v)) fb[k] = [Number(v[0]) || 0, Number(v[1]) || 0];
  const due = items.filter(it => it.act && it.wakeId && Number(it.fireAt) + 3 * 3600_000 <= nowMs && !seen.includes(it.wakeId)).slice(0, 6);
  if (!due.length) return null;
  const jobsResp = await rest(
    `push_jobs?user_id=eq.${encodeURIComponent(userId)}`
    + `&trigger_key=in.(${encodeURIComponent(due.map(it => `"timedwake:${it.wakeId}"`).join(","))})`
    + "&select=trigger_key,status,result_note,updated_at",
  );
  if (!jobsResp.ok) return null;
  const jobs = await jobsResp.json() as { trigger_key: string; status: string; result_note: string | null; updated_at: string }[];
  for (const it of due) {
    const kind = String(it.kind || "plan");
    const job = jobs.find(j => j.trigger_key === `timedwake:${it.wakeId}`);
    if (job && (job.status === "pending" || job.status === "running")) continue; // 押后中，下轮再看
    const sentAt = job && job.status === "done" && /^(generated|sent)/.test(String(job.result_note || "")) ? Date.parse(job.updated_at) : NaN;
    if (!Number.isFinite(sentAt)) { seen.push(it.wakeId); continue; } // 没发出去：不算账，账本也不动
    // 押后发送的回应窗口从实际成功时间开始；窗口未结束不能把 wakeId 标成已结算。
    const windowEnd = feedbackWindowEnd(sentAt, context, nowMs);
    if (windowEnd === null) continue;
    const resp = await rest(
      `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
      + `&character_id=eq.${encodeURIComponent(characterId)}`
      + "&role=eq.user"
      + `&message_at=gt.${encodeURIComponent(new Date(sentAt).toISOString())}`
      + `&message_at=lte.${encodeURIComponent(new Date(windowEnd).toISOString())}`
      + "&select=message_at&limit=1",
    );
    if (!resp.ok) continue; // 镜像暂时读不到，不等于用户没回应；下一轮重试。
    const replied = ((await resp.json()) as unknown[]).length > 0;
    seen.push(it.wakeId);
    const rec = fb[kind] || [0, 0];
    fb[kind] = [rec[0] + 1, rec[1] + (replied ? 1 : 0)];
    // 出自账本的那条真说出去了，才推进账本：话头了结、约定标「提过了」。App 的 settleFired 同一套规则
    const t = it.from && Array.isArray(context.threads) ? context.threads.find(x => x.id === it.from) : undefined;
    if (t && !t.done) {
      if (t.kind === "topic") { t.done = true; t.at = nowMs; t.by = "cloud"; settled.push(`说完了，了结「${t.text}」`); }
      else if (!/said:/.test(String(t.nudge || ""))) { t.nudge = (String(t.nudge || "") + " said:" + it.time).trim().slice(-200); t.at = nowMs; settled.push(`提过了「${t.text}」`); }
    }
  }
  return { fb, fbSeen: seen.slice(-60), settled };
}
// 昨天的计划不会再走起念流程；今天统计时接上昨晚尚未结算的回音。
// 昨天的累计账先并入今天的基线，已结算键一起带入，避免重算已记过的回复。
async function feedbackWithPreviousDay(
  rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string, characterId: string,
  planDate: string, items: PlanItem[], context: PlanContext, nowMs: number,
): Promise<{ fb: FbBook; fbSeen: string[]; settled: string[] } | null> {
  if (!context.userSleepStart) return feedbackRoll(rest, userId, characterId, items, context, nowMs);
  const previous = new Date(planDate + "T12:00:00Z");
  previous.setUTCDate(previous.getUTCDate() - 1);
  const response = await rest(
    `push_recheck_plans?user_id=eq.${encodeURIComponent(userId)}&character_id=eq.${encodeURIComponent(characterId)}`
    + `&plan_date=eq.${previous.toISOString().slice(0, 10)}&select=items,context&limit=1`,
  );
  if (!response.ok) return null; // 基线读失败时保留待统计，下一轮再试。
  const rows = await response.json() as { items?: PlanItem[]; context?: PlanContext }[];
  const old = rows[0];
  if (!old) return feedbackRoll(rest, userId, characterId, items, context, nowMs);
  const fb: FbBook = {};
  for (const book of [old.context?.fb || {}, context.fb || {}]) {
    for (const [kind, counts] of Object.entries(book)) {
      if (!Array.isArray(counts)) continue;
      const current = fb[kind] || [0, 0];
      fb[kind] = [Math.max(current[0], Number(counts[0]) || 0), Math.max(current[1], Number(counts[1]) || 0)];
    }
  }
  const seen = [...new Set([...(old.context?.fbSeen || []), ...(context.fbSeen || [])])].slice(-60);
  const combined = [...new Map([...(old.items || []), ...items].map(item => [item.wakeId, item])).values()];
  const result = await feedbackRoll(rest, userId, characterId, combined, { ...context, fb, fbSeen: seen }, nowMs);
  if (result) return result;
  return JSON.stringify(fb) !== JSON.stringify(context.fb || {}) || JSON.stringify(seen) !== JSON.stringify(context.fbSeen || [])
    ? { fb, fbSeen: seen, settled: [] } : null;
}
// ── 惦记账本（App index.html 同名函数的 tz 算术版；改一处要同步另一处）
const THREAD_KIND: Record<string, string> = { topic: "话头", promise: "约定", date: "日子" };
function threadAlive(t: Thread, nowMs: number, days: number): boolean {
  if (!t || !t.text) return false;
  if (t.done) return nowMs - (Number(t.at) || 0) < 86_400_000;
  const due = Number(t.due) || 0;
  if (t.kind === "date") return t.yearly ? true : (due ? nowMs < due + 86_400_000 : false);
  if (t.kind === "promise") return due ? nowMs < due + 86_400_000 : nowMs - (Number(t.since) || 0) < 7 * 86_400_000;
  return nowMs - (Number(t.at) || Number(t.since) || 0) < (days || 3) * 86_400_000;
}
function threadDueMs(t: Thread, nowMs: number, tz: number): number {
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
function liveThreads(context: PlanContext, nowMs: number): Thread[] {
  const days = Number(context.threadDays) || 3;
  return (Array.isArray(context.threads) ? context.threads : []).filter(t => t && !t.done && threadAlive(t, nowMs, days));
}
// 话头的节奏（App 同名函数同步）：刚记下 4 小时内不提，提过一次 36 小时内不再提
function threadPace(t: Thread, nowMs: number): string {
  if (t.kind === "topic" && nowMs - (Number(t.since) || 0) < 4 * 3600_000) return "刚记下，先别提";
  if (/said:/.test(String(t.nudge || "")) && nowMs - (Number(t.at) || 0) < 36 * 3600_000) return "刚提过，先别再提";
  return "";
}
function threadLines(context: PlanContext, nowMs: number, tz: number): string[] {
  return liveThreads(context, nowMs).slice(0, 12).map(t => {
    const notes = [threadWhen(t, nowMs, tz), threadPace(t, nowMs)].filter(Boolean);
    return `[${t.id}] ${THREAD_KIND[t.kind] || "话头"}·${t.text}${notes.length ? "（" + notes.join("，") + "）" : ""}`;
  });
}
const THREAD_TASK = "惦记账本：只记录聊天里明确成立的事。promise 是用户、角色自己或双方明确答应的约定，subject 分别为 user、character、both；角色说「三点半回来一趟」也必须记录。所有有时间的约定（包括今天）都进 keep，系统直接按 when 挂约定任务，不再放入 extra 随机起念。when 必须含 YYYY-MM-DD HH:MM，按原话的日期，不因现在已过点而顺移到明天。sourceMessageId 填证据消息编号；已有同一件事必须填 id，改期更新 when，不创建第二件事。确认完成时 status=completed，明确取消时 status=cancelled；只是发过进展不等于完成。不明确的猜测不记账；话头 topic 和日子 date 沿用原规则。settle 填已了结的话头或日子 id，约定的完成取消通过 keep 更新。每次最多 2 条，没有给空数组。" + promiseAgreementRule();
// 用户一句话把约定 / 话头了结：只认稳的词，宁可漏（漏的下一轮模型 settle 兜底）也不误伤。
// 约定认「做完」和「作废」，话头只认「作废」，日子不碰（到日子自己过期）
const DONE_WORDS = ["好了", "搞定", "解决了", "完成了", "弄完了", "做完了", "办好了", "交了", "买到了", "看完了", "结束了"];
const DROP_WORDS = ["不用了", "算了", "取消", "不去了", "不做了", "不需要了", "别提了", "不聊了", "不说这个了"];
const NEG_BEFORE = /(还没|没有|没能|不算|别)[^，。！？]{0,4}$/;
const TOKEN_STOP = /帮我|记得|提醒|一下|这个|那个|然后|今天|明天|后天|一起|我们|你们|已经|可以|就是|什么/g;
function wordTokens(text: string): Set<string> {
  const out = new Set<string>();
  const cleaned = String(text || "").replace(TOKEN_STOP, " ");
  for (const run of cleaned.match(/[\u4e00-\u9fff]{2,}/g) || []) for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2));
  for (const w of cleaned.match(/[A-Za-z0-9_]{2,}/g) || []) out.add(w.toLowerCase());
  return out;
}
function settleByWords(threads: Thread[], msgs: string[], nowMs: number): { id: string; text: string; how: string; said: string }[] {
  const out: { id: string; text: string; how: string; said: string }[] = [];
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
function parseWhen(when: unknown, nowMs: number, tz: number): number {
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
// 复核回来的 keep / settle 并进账本；返回 null 表示没动
function applyThreads(context: PlanContext, keep: Keep[], settle: string[], nowMs: number, tz: number, log: (s: string) => void, messages = null): Thread[] | null {
  let list: Thread[] = (Array.isArray(context.threads) ? context.threads : []).map(t => ({ ...t }));
  const promises = keep.filter(k => k && (k.kind === "promise" || list.some(t => t.kind === "promise" && t.id === k.id)));
  const before = JSON.stringify(list);
  list = updatePromiseThreads(list, promises.map(k => ({ ...k, due: parseWhen(k.when, nowMs, tz) })), nowMs, "cloud", messages);
  const notes: string[] = before === JSON.stringify(list) ? [] : ["更新约定"];
  for (const id of settle.slice(0, 6)) {
    const t = list.find(x => x.id === String(id).replace(/[\[\]]/g, "").trim());
    if (t && !t.done) { t.done = true; t.at = nowMs; t.by = "cloud"; notes.push(`了结「${t.text}」`); }
  }
  for (const k of keep.slice(0, 2)) {
    if (promises.includes(k)) continue;
    const text = String(k?.text || "").trim().slice(0, 60);
    if (!text) continue;
    const kind = THREAD_KIND[String(k?.kind)] ? String(k?.kind) : "topic";
    const dup = list.find(x => !x.done && (x.text === text || x.text.includes(text) || text.includes(x.text)));
    if (dup) { dup.at = nowMs; continue; }
    const due = parseWhen(k?.when, nowMs, tz);
    if (kind !== "topic" && !due) continue;
    list.push({ id: "t" + Math.random().toString(36).slice(2, 6), kind, text, due, yearly: kind === "date" && /生日|纪念/.test(text), since: nowMs, at: nowMs, by: "cloud", done: false, why: String(k?.why || "").slice(0, 40) });
    notes.push(`记下${THREAD_KIND[kind]}「${text}」`);
  }
  if (!notes.length) return null;
  log("惦记账本：" + notes.join("，"));
  return list.filter(t => threadAlive(t, nowMs, Number(context.threadDays) || 3)).slice(-30);
}
// 自发起念的由头三：约定快到点（前 30–90 分钟）、刚过点（1–3 小时后）、到日子了。每个阶段只提一次，记在 nudge 里
function threadNudge(context: PlanContext, nowMs: number, tz: number): { id: string; mark: string; reason: string } | null {
  for (const t of liveThreads(context, nowMs)) {
    const due = threadDueMs(t, nowMs, tz);
    if (!due) continue;
    const d = due - nowMs, marks = String(t.nudge || "");
    const mark = (phase: string) => `${phase}:${due}`;
    if (t.kind === "promise") continue; // 明确约定由独立任务负责，不再随机前后起念
    if (t.kind === "date" && Math.abs(d) <= 12 * 3_600_000 && !marks.includes(mark("day"))) {
      return { id: t.id, mark: mark("day"), reason: `今天是${t.text}` };
    }
  }
  return null;
}
type GuanianNow = { hm: string; doing: string; step: string; mood: string; energy: number; next: string; done: GuanianSched | null; asleep: boolean };

function guanianNow(day: GuanianDay, nowMs: number, quietStart?: string, quietEnd?: string): GuanianNow {
  const tz = Number.isFinite(Number(day.tz)) ? Number(day.tz) : 0;
  const local = new Date(nowMs + tz * 60_000);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  const hm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const sched = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");
  const conds = (Array.isArray(day.conds) ? day.conds : [])
    .map(c => ({ c, w: Math.pow(0.5, Math.max(0, nowMs - (Number(c.startAt) || 0)) / (Math.max(10, Number(c.halfLifeMin) || 180) * 60_000)) }))
    .filter(x => x.w > 0.08 && (Number(x.c.startAt) || 0) <= nowMs)
    .sort((a, b) => (b.w * (Number(b.c.intensity) || 50)) - (a.w * (Number(a.c.intensity) || 50)));
  let done: GuanianSched | null = null;
  for (const it of sched) if (String(it.time) <= hm) done = it;
  const next = sched.find(it => String(it.time) > hm) || null;
  const asleep = guanianAsleep(day, hm, quietStart, quietEnd);
  // 与 App 端 phaseAt 同步：睡着 / 正做着 / 做完了在空档 / 最后一件做完在等睡（过零点还没睡也算）
  const bedHM = /^\d{2}:\d{2}$/.test(String(day.bed || "")) ? String(day.bed) : String(quietStart || "");
  const wakeHM = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(quietEnd || "");
  const lateNight = !done && !!bedHM && !!wakeHM && bedHM < wakeHM && hm < bedHM;
  const over = lateNight || !!(done && done.end && done.end > String(done.time) && hm >= done.end);
  const doing = asleep ? "睡觉"
    : lateNight ? "睡前自己待着，准备睡了"
    : !done ? (day.doing || "起床后的时间")
    : !over ? String(done.title || "")
    : next ? `歇着（刚忙完${done.title || ""}）` : "睡前自己待着，准备睡了";
  let step = "";
  if (done && !over && !asleep && Array.isArray(done.steps)) {
    for (const x of done.steps) if (x && typeof x.time === "string" && x.time <= hm) step = String(x.what || "");
  }
  const hh = h < 5 ? h + 24 : h;
  let energy = Number.isFinite(Number(day.energy)) ? Number(day.energy) : 60;
  const hmNum = (v: unknown): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
    return m ? Number(m[1]) + Number(m[2]) / 60 : null;
  };
  // 与面板 energyAt 同步：cost 按进度记账、状况负向合计封顶 -12、缓降从起床时刻起算
  for (const it of sched) {
    if (h >= 5 && String(it.time) > hm) continue;
    const a = hmNum(it.time), b = hmNum(it.end);
    const prog = a != null && b != null && b > a ? Math.max(0, Math.min(1, (h - a) / (b - a))) : 1;
    energy += Math.max(-15, Math.min(15, Math.round(Number(it.cost) || 0))) * prog;
  }
  let cd = 0;
  for (const x of conds) cd += (Number(x.c.energyDelta) || 0) * x.w;
  energy += Math.max(-12, cd);
  const wakeH = hmNum(day.wake) ?? 7;
  energy -= Math.max(0, Math.min(hh, 22) - wakeH) * 1.2 + Math.max(0, hh - 22) * 8;
  energy = Math.max(0, Math.min(100, Math.round(energy)));
  const cand: { text: string; w: number }[] = [];
  const top = conds[0];
  if (top && top.c.mood) cand.push({ text: `${top.c.mood}（因为${top.c.cause || "刚才聊的"}）`, w: top.w * (Number(top.c.intensity) || 50) / 100 });
  if (done && done.mood) {
    const [dh, dm] = String(done.time).split(":").map(Number);
    cand.push({ text: `${done.mood}（${done.title || ""}之后）`, w: Math.pow(0.5, Math.max(0, (h * 60 - (dh * 60 + dm)) * 60_000) / (90 * 60_000)) * 0.6 });
  }
  cand.sort((a, b) => b.w - a.w);
  const hit = cand.find(x => x.w > 0.15);
  return {
    hm, done, step, energy, doing, asleep,
    mood: hit ? hit.text : `${day.mood || "说不上来"}（今天的底色）`,
    next: asleep ? `${day.wake || quietEnd || ""} 起床`.trim() : next ? `${next.time} ${next.title || ""}` : (over && day.bed ? `${day.bed} 睡觉` : ""),
  };
}
type PlanRow = {
  state_version?: number; retry_count?: number; next_retry_at?: string; retry_error?: string; retry_stopped?: boolean;
  session_id: string;
  context: PlanContext;
  items: PlanItem[];
  decisions: unknown[];
  judged_chat_at?: number; judged_at?: number;
  last_recheck_at: string | null;
  recheck_count: number;
  updated_at: string | null;
};

type Impulse = { time?: string; until?: string; about?: string; sem?: string; topic?: string; intent?: string; why?: string };
// ─── 生活轮：TA自己想不想发朋友圈，和用户无关，不调模型 ───
// 与 chat-plugins/moments-rhythm.js 同一套骰子：每小时掷一次，概率 = 周目标/7 × 时段权重 × 精力 × 刚做完一件事的加成。
// 装了挂念的话插件让位，所以这是唯一在掷的骰子；一周条数和最小间隔是硬上限。
const MO_HOUR_W = [0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.6, 0.6, 0.6, 0.9, 0.9, 0.6, 0.6, 0.6, 0.7, 1.0, 1.2, 1.3, 1.3, 1.2, 0.8];
const MO_W_SUM = MO_HOUR_W.reduce((a, b) => a + b, 0);
function momentsWeekStart(nowMs: number, tzMin: number): number {
  const local = new Date(nowMs + tzMin * 60_000);
  const dow = (local.getUTCDay() + 6) % 7;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow) - tzMin * 60_000;
}
function momentsBudget(context: PlanContext, nowMs: number, tzMin: number): { weekStart: number; weekN: number; ok: boolean } {
  const weekStart = momentsWeekStart(nowMs, tzMin);
  const weekN = Number(context.momentsWeekStart) === weekStart ? Number(context.momentsWeekN) || 0 : 0;
  const ok = Number(context.momentsOn) === 1
    && weekN < Math.max(0, Number(context.momentsWeekly ?? 3))
    && nowMs - (Number(context.momentsLast) || 0) >= Math.max(0, Number(context.momentsGapH ?? 6)) * 3600_000;
  return { weekStart, weekN, ok };
}
function lifeRoll(context: PlanContext, nowMs: number): { patch: Record<string, unknown>; post: Outbox | null } | null {
  const day = context.day && typeof context.day === "object" ? context.day : null;
  if (Number(context.momentsOn) !== 1 || !day) return null;
  const tz = Number(day.tz) || 0;
  const hourKey = Math.floor((nowMs + tz * 60_000) / 3600_000);
  if (Number(context.momentsRollHour) === hourKey) return null;
  const budget = momentsBudget(context, nowMs, tz);
  const patch: Record<string, unknown> = { momentsRollHour: hourKey, momentsWeekStart: budget.weekStart, momentsWeekN: budget.weekN };
  const skip = (why: string) => { console.log("[push-recheck] 生活轮不发圈：" + why); return { patch, post: null }; };
  if (!budget.ok) return skip("本周条数或间隔");
  const now = guanianNow(day, nowMs, context.quietStart, context.quietEnd);
  if (now.asleep) return skip("睡着");
  const local = new Date(nowMs + tz * 60_000);
  const cur = now.done && now.doing === String(now.done.title || "") ? now.done : null;
  const slotW = cur && cur.busy ? 0.2 : Math.max(MO_HOUR_W[local.getUTCHours()], 0.4);
  let boost = 0.5 + (Math.max(0, Math.min(100, now.energy)) / 100) * 0.8;
  const hints: string[] = [];
  if (now.done && now.doing.startsWith("歇着")) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(now.done.end || now.done.time || ""));
    const endMs = m ? Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(m[1]), Number(m[2])) - tz * 60_000 : 0;
    if (endMs && nowMs - endMs < 45 * 60_000) { boost *= 1.5; hints.push("刚做完：" + String(now.done.title || "") + (now.done.mood ? "，" + now.done.mood : "")); }
  } else if (cur) hints.push("此刻在：" + String(cur.title || ""));
  if (now.mood) hints.push("此刻情绪：" + now.mood);
  if (day.location) hints.push("在：" + String(day.location));
  const p = Math.min(0.9, (Number(context.momentsWeekly ?? 3) / 7) * (slotW / MO_W_SUM) * boost);
  const roll = Math.random();
  console.log(`[push-recheck] 生活轮 ${local.getUTCHours()}点 p=${p.toFixed(3)} roll=${roll.toFixed(3)} → ${roll < p ? "发圈" : "不发"}`);
  if (roll >= p) return { patch, post: null };
  const post: Outbox = { id: "mo" + nowMs.toString(36), at: nowMs, hint: ("可以顺着这些来，不用全提：" + hints.join("；")).slice(0, 120), by: "cloud" };
  patch.momentsLast = nowMs;
  patch.momentsWeekN = budget.weekN + 1;
  patch.outbox = [...(Array.isArray(context.outbox) ? context.outbox : []).slice(-4), post];
  return { patch, post };
}

type Decision = { time?: string; act?: boolean; sem?: string; topic?: string; why?: string; intent?: string; defer?: string };
type Extra = { time?: string; until?: string; about?: string; intent?: string; why?: string; from?: string };
type Thread = { subject?: string; status?: string; revision?: number; sourceMessageId?: string; mentionedAt?: number; id: string; kind: string; text: string; due?: number; yearly?: boolean; since?: number; at?: number; by?: string; done?: boolean; nudge?: string; why?: string };
type Keep = { id?: string; subject?: string; status?: string; sourceMessageId?: string; kind?: string; text?: string; when?: string; why?: string };
type Outbox = { id: string; at: number; hint: string; by?: string };

// 门禁默认值，可被 App 上传的 context 里的同名字段覆盖（改设置不用重新部署云函数）。
// 这一层每一道都只读本地状态，一次模型都不调——判断得勤和花钱多是两件事。
const GATE_DEF = {
  gateDailyCap: 8,     // 每份计划每天最多几次裁决调用
  gateGapMin: 25,      // 两次裁决最小间隔（分钟）。cron 每 30 分钟派一次，留 5 分钟容抖动
  gateHorizonMin: 240, // 最近的待发时刻在这么久以外就不判（分钟，0=不限）
  gateFreshMin: 10,    // 最后一句话说完还不到这么久就先不判，等话说完（分钟，0=不等）
  gateMinMsgs: 1,      // 上次裁决之后用户至少说这么多句才判
  selfImpulseCap: 0,   // 没有新聊天时，每天最多几次「自发起念」裁决（0=关）
};
// 自发起念的第二种由头：双方都这么久没说话了
// 还有不到 2 分钟就到点的时刻不再改动，免得和 push-generate 抢同一条预约。
const LEAD_MS = 2 * 60_000;
const SELF_SILENCE_MS = 3 * 3600_000;

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

async function encryptPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plain) as unknown as BufferSource,
  ));
  return {
    v: 1,
    iv: bytesToBase64(iv),
    tag: bytesToBase64(combined.slice(combined.length - 16)),
    ct: bytesToBase64(combined.slice(0, combined.length - 16)),
  };
}

async function decryptPayload(payload: EncryptedPayload, secret: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const ct = base64ToBytes(payload.ct);
  const tag = base64ToBytes(payload.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) as unknown as BufferSource },
    key,
    combined as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

function textFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
      return typeof item.text === "string" ? item.text : "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

/* ─── 模型调用用量账本（push_api_usage / push_api_limits）：几个云函数各有一份同样的副本 ─── */
type UsageBudget = { day: string; tz: number; calls: number; tokens: number; dailyCalls: number; dailyTokens: number };
function usageLocalDay(nowMs: number, tz: number): string {
  const d = new Date(nowMs + tz * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function extractUsage(providerKind: ProviderKind, data: unknown): { prompt: number; completion: number } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const n = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
  if (providerKind === "gemini") {
    const u = d.usageMetadata || {};
    return { prompt: n(u.promptTokenCount), completion: n(u.candidatesTokenCount) };
  }
  const u = d.usage || {};
  if (providerKind === "anthropic") {
    return { prompt: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens), completion: n(u.output_tokens) };
  }
  return { prompt: n(u.prompt_tokens), completion: n(u.completion_tokens) };
}
async function usageBudget(rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string): Promise<UsageBudget> {
  const limitsRes = await rest(`push_api_limits?user_id=eq.${encodeURIComponent(userId)}&select=daily_calls,daily_tokens,tz&limit=1`).catch(() => null);
  const limits = limitsRes && limitsRes.ok ? (await limitsRes.json().catch(() => []) as { daily_calls?: number; daily_tokens?: number; tz?: number }[])[0] : undefined;
  const tz = Number(limits?.tz) || 0;
  const day = usageLocalDay(Date.now(), tz);
  const rowsRes = await rest(`push_api_usage?user_id=eq.${encodeURIComponent(userId)}&day=eq.${encodeURIComponent(day)}&source=neq.cloud-chat&select=calls,prompt_tokens,completion_tokens`).catch(() => null);
  const rows = rowsRes && rowsRes.ok ? await rowsRes.json().catch(() => []) as { calls: number; prompt_tokens: number; completion_tokens: number }[] : [];
  let calls = 0, tokens = 0;
  for (const r of rows) { calls += Number(r.calls) || 0; tokens += (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0); }
  return { day, tz, calls, tokens, dailyCalls: Number(limits?.daily_calls) || 0, dailyTokens: Number(limits?.daily_tokens) || 0 };
}
function usageExceeded(b: UsageBudget): string {
  if (b.dailyCalls > 0 && b.calls >= b.dailyCalls) return `今天的模型调用次数用完了（${b.calls}/${b.dailyCalls}）`;
  if (b.dailyTokens > 0 && b.tokens >= b.dailyTokens) return `今天的 token 额度用完了（${b.tokens}/${b.dailyTokens}）`;
  return "";
}
async function usageAdd(rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string, tz: number, source: string,
  providerKind: ProviderKind, data: unknown): Promise<void> {
  const u = extractUsage(providerKind, data);
  await rest("rpc/ai_phone_usage_add", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ p_user_id: userId, p_day: usageLocalDay(Date.now(), tz), p_source: source, p_calls: 1, p_prompt: u.prompt, p_completion: u.completion }),
  }).catch(() => undefined);
}

function extractResponseText(providerKind: ProviderKind, data: unknown): string {
  if (providerKind === "anthropic") {
    const blocks = (data as { content?: unknown[] }).content;
    let text = "";
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const item = block as { type?: string; text?: string };
      if (item.type === "text") text += item.text ?? "";
    }
    return text;
  }
  if (providerKind === "gemini") {
    const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      const item = part as { text?: string; thought?: boolean; functionCall?: unknown };
      if (!item.functionCall && !item.thought) text += item.text ?? "";
    }
    return text;
  }
  const d = data as { choices?: Array<{ message?: { content?: unknown }; text?: string }>; response?: string };
  return textFromUnknownContent(d.choices?.[0]?.message?.content).trim()
    || (typeof d.choices?.[0]?.text === "string" ? d.choices[0].text.trim() : "")
    || (typeof d.response === "string" ? d.response.trim() : "");
}

/** 保留人设、预设和世界书；专用模板仅替换任务占位符，旧预约快照在末尾追加判断任务。 */
function buildJudgeBody(template: JobPayload["request"], prompt: string): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(template.body)) as Record<string, unknown>;
  const task = "【后台判断任务：本轮仅按下面要求输出 JSON，不生成聊天回复、不调用工具】\n" + prompt;
  if (!fillTemplate(body, template.providerKind, task)) {
    if (template.providerKind === "gemini") {
      body.contents = [...(Array.isArray(body.contents) ? body.contents : []), { role: "user", parts: [{ text: task }] }];
    } else {
      body.messages = [...(Array.isArray(body.messages) ? body.messages : []), { role: "user", content: task }];
    }
  }
  delete body.tools; delete body.tool_choice; delete body.toolConfig;
  if (template.providerKind === "gemini") {
    body.generationConfig = { maxOutputTokens: 2048, ...((body.generationConfig || {}) as Record<string, unknown>) };
  } else {
    body.stream = false; delete body.stream_options;
    if (!body.max_tokens && !body.max_completion_tokens) body.max_tokens = 2048;
  }
  return body;
}

/** 模型爱把 JSON 裹在解释或 ``` 里，取最外层的一对花括号。 */
function parseJudgeJson(text: string): { decisions: Decision[]; extra: Extra[]; keep: Keep[]; settle: string[]; post: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { decisions: [], extra: [], keep: [], settle: [], post: "" };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { decisions?: unknown; extra?: unknown; keep?: unknown; settle?: unknown; post?: unknown };
    const post = parsed.post && typeof parsed.post === "object" ? (parsed.post as { hint?: unknown }).hint : null;
    return {
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 12) as Decision[] : [],
      extra: Array.isArray(parsed.extra) ? parsed.extra.slice(0, 1) as Extra[] : [],
      keep: Array.isArray(parsed.keep) ? parsed.keep.slice(0, 2) as Keep[] : [],
      settle: Array.isArray(parsed.settle) ? parsed.settle.slice(0, 6).map(x => String(x)) : [],
      post: typeof post === "string" ? post.trim().slice(0, 120) : "",
    };
  } catch {
    return { decisions: [], extra: [], keep: [], settle: [], post: "" };
  }
}

/** 把新意图写进克隆出来的快照：追加一条用户视角的系统备忘，各家结构不同分别塞。 */
function appendIntentNote(body: Record<string, unknown>, providerKind: ProviderKind, note: string): boolean {
  if (providerKind === "gemini") {
    const contents = body.contents;
    if (!Array.isArray(contents)) return false;
    contents.push({ role: "user", parts: [{ text: note }] });
    return true;
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  messages.push({ role: "user", content: note });
  return true;
}

// 快照里烤着原时刻的「约 N 分钟前你这么决定的」和当时那句意图，克隆到新时刻就成了假话。
// 提示词是用户可改的，对不上就整段不动——追加的备忘里已经写明了真正的新意图。
function retuneWakeSnapshot(body: Record<string, unknown>, providerKind: ProviderKind, intent: string, minutes: number): void {
  const fix = (text: string) => text
    .replace(/（约\s*\d+\s*分钟前你这么决定的）/g, `（约 ${minutes} 分钟前你这么决定的）`)
    .replace(/你当时想着：“[^”]*”/g, `你当时想着：“${intent}”`);
  if (providerKind === "gemini") {
    for (const one of (Array.isArray(body.contents) ? body.contents : [])) {
      const parts = (one as Record<string, unknown>)?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const p = part as Record<string, unknown>;
        if (typeof p?.text === "string") p.text = fix(p.text);
      }
    }
    return;
  }
  for (const one of (Array.isArray(body.messages) ? body.messages : [])) {
    const m = one as Record<string, unknown>;
    if (typeof m?.content === "string") m.content = fix(m.content);
  }
}

function hhmm(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/* ═══════════════ 云端生成TA的一天（挂念「浏览器关着也生成」） ═══════════════
 * App 每次打开为明天寄一份 genKit：生成指令（由 App 的 buildDayInstruction 拼好，云端不自己拼提示词）、
 * 两个 push.freeze 模板键（companion+daily / companion+impulse，与本地 ai.generate 同源）、到点时刻、时区、锚点开关。
 * 到点后：借 daily 模板换掉占位符 → 生成 JSON → 下面这些逐字对照 App index.html 的函数归一/编排 →
 * 借 impulse 模板判断起念 → 克隆哨兵聊天快照挂预约 → 整份写回计划行，App 打开时 adoptCloudDay 接管。
 * 以下带「App 同名」注释的函数改动要和 index.html 同步。 */
type GenKit = {
  date?: string; instruction?: string; autoGenAt?: string; tz?: number;
  existing?: { id?: string; startTime?: string; endTime?: string; title?: string; location?: string; lock?: string }[];
  tplDaily?: string; tplImpulse?: string;
  anchorMorning?: boolean; anchorSleep?: boolean; moodGate?: boolean; kitAt?: number;
};
type GenDay = {
  wake: string; bed: string; mood: string; moodEmoji: string; energy: number; doing: string; location: string; sleep: string;
  schedule: { time: string; end?: string; title: string; place?: string; note?: string; mood?: string; cost?: number; busy?: boolean }[];
  conds: { mood: string; cause: string; energyDelta: number; intensity: number; halfLifeMin: number; startAt: number }[];
};
const GEN_PLACEHOLDER = "__CUSTOM_APP_INSTRUCTION__";
const GEN_MAX_TRIES = 3;
const pad2 = (n: number): string => String(n).padStart(2, "0");

// App 同名 parseModelJson
function parseModelJson(text: unknown): any {
  let t = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
  try { return JSON.parse(t); } catch (_e) { /* 继续尝试截取 */ }
  for (let a = t.indexOf("{"); a >= 0; a = t.indexOf("{", a + 1)) {
    let depth = 0, inStr = false, escaped = false;
    for (let i = a; i < t.length; i++) {
      const ch = t[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(t.slice(a, i + 1)); } catch (_e) { break; }
      }
    }
  }
  throw new Error("模型没回 JSON，它说的是：「" + t.slice(0, 100) + (t.length > 100 ? "…" : "") + "」");
}
// App 同名 pickField / isTrue / normHM / addMin
function pickField(o: any, keys: string[]): any {
  for (const k of keys) {
    if (o && o[k] != null && String(o[k]).trim() !== "") return o[k];
  }
  return "";
}
function isTrue(v: unknown): boolean { return v === true || /^(true|是|1)$/i.test(String(v || "").trim()); }
function normHM(v: unknown): string {
  const m = /(\d{1,2})\s*[:：点时.]\s*(\d{1,2})?/.exec(String(v || ""));
  if (!m) return "";
  return String(Math.min(23, +m[1])).padStart(2, "0") + ":" + String(Math.min(59, +(m[2] || 0))).padStart(2, "0");
}
function addMin(hm: string, n: number): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim()); if (!m) return hm;
  const t = Math.min(+m[1] * 60 + +m[2] + n, 23 * 60 + 59);
  return pad2(Math.floor(t / 60)) + ":" + pad2(t % 60);
}
// App 同名 parseDayResult
function parseDayResult(d: any, existing: NonNullable<GenKit["existing"]>, settings: { quietStart?: string; quietEnd?: string }, nowMs: number): GenDay {
  const schedRaw = pickField(d, ["schedule", "日程", "日程表"]);
  if (!Array.isArray(schedRaw)) throw new Error("日程缺失（模型返回的字段：" + Object.keys(d || {}).slice(0, 10).join("/") + "）");
  const sched: GenDay["schedule"] = schedRaw.slice(0, 10).map((it: any) => ({
    time: normHM(pickField(it, ["time", "时间", "at"])),
    end: normHM(pickField(it, ["end", "endTime", "结束", "到"])),
    title: String(pickField(it, ["title", "标题", "事项", "name"]) || ""),
    place: String(pickField(it, ["place", "地点", "位置", "在哪"]) || "").slice(0, 16),
    note: String(pickField(it, ["note", "备注", "细节", "desc"]) || ""),
    mood: String(pickField(it, ["mood", "情绪", "心情"]) || "").slice(0, 24),
    cost: Math.max(-15, Math.min(15, Math.round(+pickField(it, ["cost", "精力影响", "消耗"]) || 0))),
    busy: pickField(it, ["busy", "顾不上", "忙"]) === "" ? undefined : isTrue(pickField(it, ["busy", "顾不上", "忙"])),
  }));
  for (const it of existing) {
    const hit = sched.find((x) => x.time === it.startTime);
    if (!hit) sched.push({ time: String(it.startTime || ""), title: String(it.title || ""), place: it.location || "", note: it.location || "日程表上的安排", busy: it.lock ? it.lock === "busy" : undefined });
    else if (it.lock) hit.busy = it.lock === "busy";
  }
  sched.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  for (const it of sched) if (it.end && it.end <= it.time) it.end = "";
  const last = sched[sched.length - 1];
  const wake = normHM(pickField(d, ["wake", "起床", "wakeUp"])) || (sched[0] && sched[0].time) || String(settings.quietEnd || "");
  const bodyRaw = pickField(d, ["body", "身体", "状况"]);
  const bodyConds: GenDay["conds"] = (Array.isArray(bodyRaw) ? bodyRaw : []).slice(0, 2)
    .filter((b: any) => b && String(b.label || "").trim())
    .map((b: any) => ({
      mood: String(b.mood || b.label).trim().slice(0, 24),
      cause: String(b.label).trim().slice(0, 20),
      energyDelta: Math.max(-8, Math.min(8, Math.round(+b.energy || 0))),
      intensity: 60,
      halfLifeMin: Math.max(1, Math.min(12, Math.round(+b.hours || 4))) * 60,
      startAt: nowMs,
    }));
  const bed = normHM(pickField(d, ["bed", "睡觉", "bedtime"])) || (last ? addMin(last.end || last.time, last.end ? 30 : 90) : String(settings.quietStart || ""));
  return {
    wake: wake, bed: bed,
    mood: String(pickField(d, ["mood", "心情", "情绪"]) || ""),
    moodEmoji: String(pickField(d, ["moodEmoji", "emoji", "表情"]) || "🌙").slice(0, 4),
    energy: Math.max(0, Math.min(100, +pickField(d, ["energy", "精力", "体力"]) || 60)),
    doing: String(pickField(d, ["doing", "正在做", "当前"]) || ""),
    location: String(pickField(d, ["location", "位置", "地点"]) || ""),
    sleep: String(pickField(d, ["sleep", "睡眠", "昨晚"]) || "").slice(0, 40),
    schedule: sched,
    conds: bodyConds,
  };
}
// App 同名 buildImpulseInstruction
function buildImpulseInstruction(day: { mood: string; energy: number; schedule: unknown[] }, outlook: unknown[], nowHM: string, lines: string[],
  settings: { quota: number; quietStart: string; quietEnd: string; minGapMin: number; moodGate: boolean; anchorMorning: boolean; anchorSleep: boolean }, biasLine: string, threads: string[]): string {
  const anchors = [
    settings.anchorMorning ? "早上刚过免打扰那会儿，TA可能会想问一句早" : null,
    settings.anchorSleep ? "睡前那段，TA可能会想说句晚安或白天没说完的话" : null,
  ].filter(Boolean);
  return [
    "【后台系统任务，不是聊天：不要以角色口吻说话、不要直接写消息内容，只输出判断 JSON】",
    "你是当前角色的内心。现在是 " + nowHM + "。想一想：今天剩下的时间里，TA会在哪些时刻想给用户发消息？",
    "念头是TA自己冒出来的，不必挂在日程上——刚做完一件事想说、路上看见什么、忽然惦记、白天没聊完的话头、单纯想搭句话，都算；一件事也可以不产生任何念头。按TA的性格克制判断，宁可少也别硬凑。",
    '输出严格 JSON，第一个字符必须是 {，字段名一字不差：{"impulses":[{"time":"这个念头最想说出口的时刻HH:MM","about":"这个念头的由头（8字内，例：路过花店/刚开完会/昨晚那事没聊完）","sem":"接触类型：问候/关心/追话题/分享/惦记 选一","topic":"想聊的话题（8字内）","intent":"TA当时的第一人称心理动机（40字内，不写台词）","why":"为什么这会儿会想起（20字内）"}]}',
    "impulses 按时刻从早到晚排；一个也没有就给空数组，不要为了填满而编。",
    "没有固定保质期。已经说过、已经解决或事实发生变化就作罢；等待仅让发送概率逐渐降低。",
    "TA今天的生活面（背景，不是候选时刻）：", JSON.stringify({ mood: day.mood, energy: day.energy, schedule: day.schedule }),
    "（energy 是TA刚醒时的基线，不是此刻的）",
    "", "今天剩下的时间长这样（按TA的日程逐段列出，end 是这段结束的时刻，空档也单列一行；精力越低越懒得开口，busy=true 那几段顾不上看手机，别把念头排在里面——排在它结束之后反而正好）：",
    JSON.stringify(outlook),
    lines.length ? "\n最近和用户的聊天（「我」=用户，「TA」=角色，从旧到新）：\n" + lines.join("\n") : null,
    lines.length ? "结合聊天氛围判断：正聊得火热就不必刻意再约时刻；有没接完的话头、刚闹过别扭、或很久没联系，都会真实影响TA想不想主动、以及动机的内容。动机要能接上最近聊的事，不要凭空另起炉灶。" : null,
    threads.length ? "\nTA心里还挂着这些事（约定快到点想打个气、过了点想问结果、到日子的想说一句、话头没接完想续上，都是很自然的由头）：\n" + threads.join("\n") : null,
    anchors.length ? "\n用户希望留意这几段：" + anchors.join("；") + "。想不起来就不用勉强。" : null,
    "", "约束：最多给 " + (settings.quota + 3) + " 个念头，今天最多真的发 " + settings.quota + " 条（多出来的会被记成「想过但没发」）；"
      + "时刻必须晚于 " + nowHM + "；免打扰时段 " + settings.quietStart + "–" + settings.quietEnd + " 内不要排"
      + (settings.minGapMin > 0 ? "；相邻两个念头至少隔 " + settings.minGapMin + " 分钟" : "") + "。",
    (settings.moodGate && day.energy < 30) ? "TA今天精力只有 " + day.energy + "%，很低。这种时候TA更想缩着，明显减少主动。" : null,
    biasLine || null,
  ].filter((s) => s !== null).join("\n");
}
// App 同名 chatExcerpt / unansweredStreak
function chatExcerpt(msgs: { role: string; c: string }[], maxLines: number): string[] {
  return msgs.slice(-(maxLines || 24)).map((m) =>
    (m.role === "user" ? "我：" : "TA：") + (m.c.length > 200 ? m.c.slice(0, 200) + "…" : m.c));
}
// 判断时回看几句：App 设置寄在 context.judgeLines，越界的值一律按默认算
function judgeLinesOf(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : 24;
}
function unansweredStreak(msgs: { role: string; t: number }[], nowMs: number): number {
  let prevT: number | null = null, rounds = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") break;
    if (prevT === null || prevT - m.t > 3 * 60000) {
      if (nowMs - m.t >= 30 * 60000) rounds++;
    }
    prevT = m.t;
  }
  return rounds;
}
// App 同名 fitScore / calcScore（本地小时用 tz 换算）
function fitScore(fireAt: number, tz: number): number {
  const d = new Date(fireAt + tz * 60_000);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const g = (peak: number, sigma: number) => Math.exp(-Math.pow(h - peak, 2) / (2 * sigma * sigma));
  return Math.round(100 * Math.min(1, g(13, 3) * 0.75 + g(21, 2.5)));
}
function calcScore(fireAt: number, armedBefore: number, streak: number, lastArmedAt: number, tz: number,
  settings: { quota: number; maxUnanswered: number; minGapMin: number }) {
  const pq = Math.round(Math.min(100, armedBefore / Math.max(1, settings.quota) * 100));
  const mu = settings.maxUnanswered;
  const pr = Math.round(Math.min(100, mu > 0 ? streak / mu * 100 : streak * 25));
  let pg = 0;
  const gapMin = settings.minGapMin;
  if (gapMin > 0 && lastArmedAt) {
    const dist = (fireAt - lastArmedAt) / 60000;
    if (dist < gapMin * 2) pg = Math.round(Math.max(0, Math.min(100, (1 - dist / (gapMin * 2)) * 100)));
  }
  return { fit: fitScore(fireAt, tz), pq, pr, pg, press: Math.round(pq * 0.4 + pr * 0.4 + pg * 0.2) };
}
// App 同名 dayOutlook：本地 timeToMs/fmtHM 换成按 tz 的 UTC 算术。
// 念头不再挂日程节点，这里只给「今天剩下的时间长什么样」当模型自己挑时刻的依据。
// 按日程自己的边界走而不是固定网格采样——固定网格会漏掉夹在两点之间的短日程。
function dayOutlook(day: GenDay, planDate: string, tz: number, nowMs: number,
  settings: { quietStart: string; quietEnd: string }) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(planDate);
  const dayUtc = dm ? Date.UTC(+dm[1], +dm[2] - 1, +dm[3]) : NaN;
  const timeToMs = (hm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
    if (!m || !Number.isFinite(dayUtc)) return null;
    return dayUtc + (+m[1] * 60 + +m[2] - tz) * 60_000;
  };
  const inQuiet = (hm: string) => {
    const qs = settings.quietStart, qe = settings.quietEnd;
    if (!qs || !qe || qs === qe) return false;
    return qs < qe ? (hm >= qs && hm < qe) : (hm >= qs || hm < qe);
  };
  const bed = normHM(day.bed) || settings.quietStart || "";
  const wake = normHM(day.wake) || settings.quietEnd || "";
  const sw = bed && wake && bed !== wake ? { bed, wake, overnight: bed < wake } : null;
  const asleepAt = (hm: string) => !sw ? false : (sw.overnight ? (hm >= sw.bed && hm < sw.wake) : (hm >= sw.bed || hm < sw.wake));
  const endMs = (sw && timeToMs(sw.overnight ? "23:50" : sw.bed)) || timeToMs("23:00") || nowMs;
  const rows: { time: string; end: string; energy: number; doing: string; busy: boolean }[] = [];
  const push = (ms: number, doing: string, busy: boolean, end: string) => {
    const hm = hhmm(ms, tz);
    if (ms < nowMs || ms > endMs || inQuiet(hm) || asleepAt(hm)) return;
    rows.push({ time: hm, end: end || "", energy: guanianNow(day as GuanianDay, ms, settings.quietStart, settings.quietEnd).energy, doing, busy: !!busy });
  };
  let cursor = nowMs;
  for (const it of (day.schedule || [])) {
    const a = it && it.time ? timeToMs(String(it.time)) : null;
    if (!a) continue;
    const b = it.end ? timeToMs(String(it.end)) : null;
    if ((b || a) < nowMs) continue;
    if (a - cursor > 20 * 60_000) push(Math.round((Math.max(cursor, nowMs) + a) / 2), "空着", false, "");
    push(Math.max(a, nowMs), String(it.title || ""), typeof it.busy === "boolean" ? it.busy : /上课|课堂|听课|自习|复习|预习|写作业|做作业|赶作业|做题|考试|测验|开会|会议|值班|实习|训练|排练|实验|赶稿|写稿|编程|写代码|专注|集中精神|通勤|赶路|开车|面试|汇报|手术|门诊/.test(String(it.title || "")) && !/睡觉|睡眠|午睡|午休|补觉|休息|发呆|摸鱼|放松|吃饭|用餐|散步|刷视频|看番|打游戏|玩游戏|聊天|自由时间|准备睡|洗漱|刚醒|起床|看剧|逛/.test(String(it.title || "")), String(it.end || ""));
    cursor = Math.max(cursor, b || a);
  }
  if (endMs - cursor > 20 * 60_000) push(Math.round((Math.max(cursor, nowMs) + endMs) / 2), "睡前自己待着", false, "");
  return rows.slice(0, 16);
}

// 模板里最后一条用户消息是「[挂念] __CUSTOM_APP_INSTRUCTION__」，把占位符换成真正的指令。各家消息结构不同，逐段找字符串替换。
function fillTemplate(body: Record<string, unknown>, providerKind: ProviderKind, instruction: string): boolean {
  let hit = false;
  const fix = (text: string) => {
    if (!text.includes(GEN_PLACEHOLDER)) return text;
    hit = true;
    return text.split(GEN_PLACEHOLDER).join(instruction);
  };
  const walkParts = (parts: unknown) => {
    for (const part of (Array.isArray(parts) ? parts : [])) {
      const p = part as Record<string, unknown>;
      if (typeof p?.text === "string") p.text = fix(p.text);
    }
  };
  if (providerKind === "gemini") {
    for (const one of (Array.isArray(body.contents) ? body.contents : [])) walkParts((one as Record<string, unknown>)?.parts);
    return hit;
  }
  for (const one of (Array.isArray(body.messages) ? body.messages : [])) {
    const m = one as Record<string, unknown>;
    if (typeof m?.content === "string") m.content = fix(m.content);
    else walkParts(m?.content);
  }
  return hit;
}

// 与 App generateJson 一致：第一次没拿到 JSON 就追加严格指令再试一次
async function generateJsonWith(template: JobPayload, instruction: string, log: (line: string) => void,
  record?: (providerKind: ProviderKind, data: unknown) => Promise<void>): Promise<any> {
  const call = async (inst: string): Promise<string> => {
    const clone = JSON.parse(JSON.stringify(template.request)) as JobPayload["request"];
    if (!fillTemplate(clone.body, clone.providerKind, inst)) throw new Error("模板里找不到指令占位符");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 240_000);
    try {
      const response = await fetch(clone.url, { method: "POST", headers: clone.headers, body: JSON.stringify(clone.body), signal: controller.signal });
      if (!response.ok) throw new Error(`模型 HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 160)}`);
      const data = await response.json();
      if (record) await record(clone.providerKind, data);
      return extractResponseText(clone.providerKind, data);
    } finally { clearTimeout(timeout); }
  };
  try { return parseModelJson(await call(instruction)); } catch (e) {
    log("首次生成未得到 JSON（" + (e instanceof Error ? e.message : String(e)) + "），追加严格指令重试");
    return parseModelJson(await call(instruction + "\n\n重要：只输出 JSON 本身，第一个字符必须是 {，最后一个字符必须是 }，不要任何解释、前言、思考过程或代码块标记。"));
  }
}

type GenDeps = {
  rest: (path: string, init?: RequestInit) => Promise<Response>;
  payloadKey: string; userId: string; characterId: string; planDate: string; planFilter: string;
  plan: PlanRow; context: PlanContext; kit: GenKit; nowMs: number;
};
// 到点生成 + 编排。失败只记 genTries/genError，cron 下一轮再来，最多 GEN_MAX_TRIES 次。
async function generateCloudDay(deps: GenDeps): Promise<void> {
  const { rest, payloadKey, userId, characterId, planDate, planFilter, plan, context, kit, nowMs } = deps;
  const tz = Number(kit.tz) || 0;
  const genLog: string[] = [];
  const log = (line: string) => { if (genLog.length < 40) genLog.push(line); };
  const tries = (Number(context.genTries) || 0) + 1;
  const patchPlan = (body: Record<string, unknown>, guard: boolean) => rest(
    guard && plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
    { method: "PATCH", headers: { Prefer: guard ? "return=representation" : "return=minimal" }, body: JSON.stringify(body) },
  ).catch(() => undefined);
  const active = async () => {
    const response = await rest(`${planFilter}${plan.updated_at ? "&updated_at=eq." + encodeURIComponent(plan.updated_at) : ""}&select=plan_date&limit=1`).catch(() => undefined);
    const rows = response?.ok ? await response.json().catch(() => []) : [];
    return Array.isArray(rows) && rows.length > 0;
  };
  const armedKeys: string[] = [];
  try {
    // 借模板：daily / impulse 两份 push.freeze 冻的完整提示词，加上哨兵聊天快照（点亮预约要克隆它）
    const sentinelWakeId = typeof context.sentinelWakeId === "string" ? context.sentinelWakeId : "";
    const keys = [kit.tplDaily, kit.tplImpulse, sentinelWakeId ? `timedwake:${sentinelWakeId}` : ""].filter(Boolean) as string[];
    const jobsResponse = await rest(
      `push_jobs?user_id=eq.${encodeURIComponent(userId)}`
      + `&trigger_key=in.(${encodeURIComponent(keys.map(k => `"${k}"`).join(","))})`
      + "&select=id,trigger_key,status,execute_at,payload",
    );
    const jobRows = jobsResponse.ok ? await jobsResponse.json() as JobRow[] : [];
    jobRows.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
    const payloads = new Map<string, JobPayload>();
    for (const row of jobRows) {
      if (payloads.has(row.trigger_key)) continue;
      try { payloads.set(row.trigger_key, JSON.parse(await decryptPayload(row.payload, payloadKey)) as JobPayload); }
      catch { /* 单条解不开就算没有 */ }
    }
    const tplDaily = kit.tplDaily ? payloads.get(kit.tplDaily) : undefined;
    const tplImpulse = kit.tplImpulse ? payloads.get(kit.tplImpulse) : undefined;
    const tplChat = sentinelWakeId ? payloads.get(`timedwake:${sentinelWakeId}`) : undefined;
    if (!tplDaily || !tplImpulse) throw new Error("云端没有可借的提示词模板（App 打开一次会重新冻结）");
    const instruction = String(kit.instruction || "");
    if (!instruction) throw new Error("生成原料里没有指令");
    const existing = Array.isArray(kit.existing) ? kit.existing : [];
    const settings = {
      quota: Number(context.quota) || 3,
      quietStart: String(context.quietStart || ""), quietEnd: String(context.quietEnd || ""),
      minGapMin: Number(context.minGapMin) || 0, maxUnanswered: Number(context.maxUnanswered) || 0,
      moodGate: kit.moodGate !== false, anchorMorning: kit.anchorMorning === true, anchorSleep: kit.anchorSleep !== false,
    };

    // ── 生成TA的一天（与 App generateDay 同一份指令、同一套归一）
    const budgetTz = (await usageBudget(rest, userId)).tz;
    const record = (providerKind: ProviderKind, data: unknown) => usageAdd(rest, userId, budgetTz, "cloud-gen", providerKind, data);
    if (!await active()) return;
    const raw = await generateJsonWith(tplDaily, instruction, log, record);
    if (!await active()) return;
    const dayFull = parseDayResult(raw, existing, settings, nowMs);
    const day: GuanianDay & Record<string, unknown> = {
      tz, mood: dayFull.mood, energy: dayFull.energy, location: dayFull.location, doing: dayFull.doing,
      wake: dayFull.wake, bed: dayFull.bed,
      schedule: dayFull.schedule.map(it => ({ time: it.time, end: it.end || "", title: it.title, place: it.place || "", cost: +(it.cost || 0), mood: it.mood || "", busy: typeof it.busy === "boolean" ? it.busy : undefined })),
      conds: dayFull.conds.map(c => ({ startAt: c.startAt, halfLifeMin: c.halfLifeMin, intensity: c.intensity, energyDelta: c.energyDelta, mood: c.mood, cause: c.cause })),
    };
    log("生成今日生活面：" + dayFull.schedule.length + " 条日程（日程表已定 " + existing.length + " 条），作息 " + dayFull.wake + " 起 " + dayFull.bed + " 睡，心情「" + dayFull.mood + "」"
      + (dayFull.sleep ? "，昨晚" + dayFull.sleep : "") + (dayFull.conds.length ? "，身上：" + dayFull.conds.map(c => c.cause).join("、") : "")
      + (dayFull.mood ? "" : "（心情为空，模型顶层字段：" + Object.keys(raw || {}).slice(0, 10).join("/") + "）"));

    // ── 编排心动时刻（与 App orchestrate 同一套候选、同一份判断指令、同一套数值约束）
    const outlook = dayOutlook(dayFull, planDate, tz, nowMs, settings);
    const items: Record<string, unknown>[] = [];
    let chatUsed = 0;
    if (!outlook.length) {
      log("编排：今天剩下的时间全在免打扰或睡眠里");
    } else if (Number(context.impulseMode) === 1) {
      // 与 App orchestrate 同步：随用随判早上不预排念头，白天由复核随时起
      log("随用随判：早上不排念头（没调模型）");
    } else {
      const { chat, lines } = await (async () => {
        if (guanianHasWindow(context)) {
          const history = await readGuanianCloudHistory(rest, userId, plan.session_id, context);
          const selected = selectGuanianHistory(history.messages, context);
          return { chat: selected.filter(m => m.media_type !== "offline_summary").map(m => ({ role: m.role, t: Date.parse(m.message_at), c: m.content })),
            lines: guanianHistoryText(history, tz, 80, context).split("\n").filter(Boolean) };
        }
      const mirrorResponse = await rest(
        `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
        + `&character_id=eq.${encodeURIComponent(characterId)}`
        + `&or=(media_type.is.null,media_type.neq.response_batch)&select=role,content,message_at&order=message_at.desc&limit=${judgeLinesOf(context.judgeLines) + 20}`,
      );
      const mirrorRows = mirrorResponse.ok ? (await mirrorResponse.json() as { role: string; content: string; message_at: string }[]).reverse() : [];
        const chat = mirrorRows
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role, t: Date.parse(m.message_at) || 0, c: String(m.content || "").replace(/\s+/g, " ").trim() }))
        .filter(m => m.c)
        .sort((a, b) => a.t - b.t);
        return { chat, lines: chatExcerpt(chat, judgeLinesOf(context.judgeLines)) };
      })();
      const streak0 = unansweredStreak(chat, nowMs);
      chatUsed = lines.length;
      if (lines.length) log("已读入最近 " + lines.length + " 句聊天作为判断上下文" + (streak0 ? "（当前连续 " + streak0 + " 轮未回）" : ""));
      if (!await active()) return;
      const parsed = await generateJsonWith(tplImpulse, buildImpulseInstruction(dayFull, outlook, hhmm(nowMs, tz), lines, settings, String(context.bias || ""), threadLines(context, nowMs, tz)), log, record);
      if (!await active()) return;
      const raw: Impulse[] = Array.isArray(parsed?.impulses) ? parsed.impulses : [];
      log("TA提了 " + raw.length + " 个念头：" + (raw.map(x => normHM(x?.time) + "·" + String(x?.about || "")).join("，") || "（一个都没有）"));

      const wakePrefix = String(context.wakePrefix || "");
      const armWake = async (fireAt: number, intent: string): Promise<{ id: string; reason: string }> => {
        if (!tplChat) return { id: "", reason: "云端没有可借的聊天模板（哨兵预约不在了）" };
        if (!wakePrefix) return { id: "", reason: "没有预约 id 前缀" };
        const wakeId = `${wakePrefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const clone = JSON.parse(JSON.stringify(tplChat)) as JobPayload;
        delete clone.generatedResponse; // A new wake must generate its own reply.
        const note = `[系统备忘：这不是对方发来的消息。到点了，你现在想主动跟对方说的是——${intent}。`
          + "顺着你们刚才聊的往下说，别重复已经说过的话，也别提起这条备忘。]";
        if (!appendIntentNote(clone.request.body, clone.request.providerKind, note)) return { id: "", reason: "聊天模板结构不认识" };
        retuneWakeSnapshot(clone.request.body, clone.request.providerKind, intent, Math.max(1, Math.round((fireAt - Date.now()) / 60_000)));
        clone.merge = { ...(clone.merge || {}), ...(settings.maxUnanswered > 0 ? { cooldownRounds: settings.maxUnanswered } : {}) };
        const insert = await rest("push_jobs", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify([{
            id: `job_${crypto.randomUUID()}`, user_id: userId, trigger_key: `timedwake:${wakeId}`, kind: "timed_task",
            execute_at: new Date(fireAt + 15_000).toISOString(), status: "pending",
            payload: await encryptPayload(JSON.stringify(clone), payloadKey),
          }]),
        });
        if (!insert.ok) return { id: "", reason: `预约写入失败 HTTP ${insert.status}` };
        armedKeys.push(`"timedwake:${wakeId}"`);
        return { id: wakeId, reason: "" };
      };

      // 模型自己挑的时刻说了不算：免打扰、睡眠窗、时刻去重、最小间隔、额度，这五道照样硬拦
      const dm2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(planDate);
      const dayUtc2 = dm2 ? Date.UTC(+dm2[1], +dm2[2] - 1, +dm2[3]) : NaN;
      const hmToMs = (hm: string): number | null => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
        if (!m || !Number.isFinite(dayUtc2)) return null;
        return dayUtc2 + (+m[1] * 60 + +m[2] - tz) * 60_000;
      };
      const qs2 = settings.quietStart, qe2 = settings.quietEnd;
      const inQuiet2 = (hm: string) => (!qs2 || !qe2 || qs2 === qe2) ? false : (qs2 < qe2 ? (hm >= qs2 && hm < qe2) : (hm >= qs2 || hm < qe2));
      const armedAt: number[] = [];
      let armedCount = 0;
      const prevArmed = (t: number) => armedAt.filter(x => x < t).sort((a, b) => b - a)[0] || 0;
      const taken = new Set<string>();
      const gapMs = Number(settings.minGapMin || 0) * 60_000;
      for (const x of raw.slice(0, settings.quota + 3)) {
        const hm = normHM(x?.time), ms = hm ? hmToMs(hm) : null;
        if (!hm || !ms || ms < nowMs + 3 * 60_000) { log("念头丢弃：时刻不合法或已过点（" + String(x?.time || "") + "）"); continue; }
        if (inQuiet2(hm) || guanianAsleep(dayFull as GuanianDay, hm, qs2, qe2)) { log("念头丢弃：" + hm + " 落在免打扰或睡着的时段"); continue; }
        if (taken.has(hm)) { log("念头丢弃：" + hm + " 已经有一个了"); continue; }
        taken.add(hm);
        const uhm = normHM(x?.until), ums = uhm ? hmToMs(uhm) : null;
        const about = String(x?.about || "想起用户").slice(0, 12);
        const item: Record<string, unknown> = {
          time: hm, fireAt: ms, until: ums && ums > ms ? Math.min(ums, ms + 6 * 3600_000) : 0,
          source: about, act: true, kind: "plan",
          why: String(x?.why || ""), intent: String(x?.intent || ""), delivery: "", reason: "", wakeId: "",
          sem: String(x?.sem || ""), topic: String(x?.topic || ""),
          score: calcScore(ms, armedCount, streak0, prevArmed(ms), tz, settings),
        };
        if (armedCount >= settings.quota) { item.act = false; item.why = "超出今日额度"; }
        else if (gapMs && armedAt.some(t => Math.abs(ms - t) < gapMs)) { item.act = false; item.why = "离上一个起念太近"; }
        if (item.act) {
          const intent = String(item.intent || about);
          const res = await armWake(ms, intent);
          if (res.id) {
            item.wakeId = res.id; item.delivery = "push"; item.reason = "";
            log(hm + " 起念 ✓ 已预约离线推送：" + intent);
          } else {
            // 和本地「仅本地」不同：云端没有本地路径可退，起念留着，App 打开时能看到原因
            item.delivery = ""; item.reason = res.reason;
            log(hm + " 起念 ✓ 但没挂上预约（" + res.reason + "）：" + intent);
          }
          armedCount++; armedAt.push(ms);
        } else {
          log(hm + " 未起念：" + String(item.why));
        }
        item.hist = [{ at: nowMs, kind: item.act ? "plan" : "skip", note: item.act ? item.intent : (item.why || "TA这会儿不想"), by: "cloud" }];
        items.push(item);
      }
      items.sort((a, b) => Number(a.fireAt) - Number(b.fireAt));
      log(armedCount ? "TA今天有 " + armedCount + " 个想起你的时刻" : "TA今天想安静地过");
    }

    const saved = await patchPlan({
      items,
      decisions: [],
      recheck_count: 0,
      last_recheck_at: new Date().toISOString(),
      context: {
        ...context,
        mood: dayFull.mood, energy: String(dayFull.energy),
        day, dayFull, genKit: null,
        generatedBy: "cloud", genAt: nowMs, genLog, genChatUsed: chatUsed, genTries: tries, genError: "", selfUsed: 0,
      },
    }, true);
    if (!saved?.ok && saved?.status !== 409) throw new Error("复核结果保存失败");
    const rows = saved?.ok ? await saved.json().catch(() => []) as unknown[] : [];
    if (Array.isArray(rows) && rows.length > 0) return;
    // 生成期间 App 自己生成并上传了计划：以 App 为准，刚挂的预约撤掉，别成孤儿
    if (armedKeys.length) {
      await rest(`push_jobs?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending`
        + `&trigger_key=in.(${encodeURIComponent(armedKeys.join(","))})`, {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }),
      }).catch(() => undefined);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("云端生成失败：" + msg);
    // 也带乐观锁：生成期间 App 自己生成并上传了计划的话，这份带 genKit 的旧 context 盖回去会让云端再生成一次
    await patchPlan({
      last_recheck_at: new Date().toISOString(),
      context: { ...context, genTries: tries, genError: msg.slice(0, 300), genLog },
    }, true);
  }
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 200 });

  const { userId, characterId, planDate, token, action } = await req.json().catch(() => ({})) as {
    userId?: string; characterId?: string; planDate?: string; token?: string; action?: string;
  };
  if (!token || (action !== "capabilities" && (!userId || !characterId || !planDate))) return new Response("bad request", { status: 400 });

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  let currentPlan: PlanRow | null = null;
  let planConflict = false;
  let planWriteFailed = false;
  const rest = async (path: string, init?: RequestInit): Promise<Response> => {
    const patch = init?.method === "PATCH" && init.body ? JSON.parse(String(init.body)) : null;
    const ownsPath = path.startsWith("push_recheck_plans?") && path.includes(`&character_id=eq.${encodeURIComponent(characterId || "")}`)
      && path.includes(`&plan_date=eq.${encodeURIComponent(planDate || "")}`);
    const guarded = currentPlan && ownsPath && patch && ["context","items","decisions"].some(k => k in patch);
    if (guarded) {
      if (planConflict) return new Response("plan changed", { status: 409 });
      if (!Number.isFinite(currentPlan!.state_version)) return new Response("schema 12 required", { status: 409 });
      path += `&state_version=eq.${currentPlan!.state_version}`;
    }
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, { ...init,
      headers: { ...restHeaders, ...(init?.headers ?? {}), ...(guarded ? { Prefer: "return=representation" } : {}) },
    });
    if (guarded && !response.ok) planWriteFailed = true;
    if (guarded && response.ok) {
      const rows = await response.clone().json();
      if (!Array.isArray(rows) || !rows.length) { planConflict = true; return new Response("plan changed", { status: 409 }); }
      currentPlan!.state_version = rows[0].state_version;
      if (rows[0].updated_at) currentPlan!.updated_at = rows[0].updated_at;
    }
    if (ownsPath && patch?.context?.day && response.ok) {
      try {
        await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, { method: "POST", headers: restHeaders,
          signal: AbortSignal.timeout(2000), body: JSON.stringify({ messages: [{ topic: `guanian-presence:${userId}`, event: "changed", payload: {}, private: true }] }) });
      } catch { /* 状态通知失败由宿主定时补同步，不影响已保存的日程。 */ }
    }
    return response;
  };

  const secretResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key&limit=1");
  const secretRows = secretResponse.ok
    ? await secretResponse.json() as { cron_secret?: string | null; payload_key?: string | null }[]
    : [];
  const cronSecret = secretRows[0]?.cron_secret || "";
  const payloadKey = secretRows[0]?.payload_key || "";
  if (!cronSecret || String(token) !== cronSecret) return new Response("forbidden", { status: 403 });
  if (action === "capabilities") return Response.json({ ok: true, capabilities: ["user-sleep-feedback-v1", "recheck-control-v1", "generation-stop-v1", "judge-task-v1", "promise-tasks-v1", "promise-tasks-v2", "scheduler-state-v1", "history-window-v1"] });
  if (!userId || !characterId || !planDate) return new Response("bad request", { status: 400 });
  if (!payloadKey) return new Response("payload_key missing", { status: 200 });

  let planFilter = `push_recheck_plans?user_id=eq.${encodeURIComponent(userId)}`
    + `&character_id=eq.${encodeURIComponent(characterId)}`
    + `&plan_date=eq.${encodeURIComponent(planDate)}`;

  const planResponse = await rest(
    `${planFilter}&select=*&limit=1`,
  );
  if (!planResponse.ok) return new Response("plan read unavailable", { status: 503 });
  const planRows = planResponse.ok ? await planResponse.json() as PlanRow[] : [];
  const plan = planRows[0];
  if (!plan) return new Response("no plan", { status: 200 });

  currentPlan = plan;
  const nowMs = Date.now();
  if (plan.context?.genKit && plan.context.genEnabled === 0) return new Response("gen: disabled", { status: 200 });
  if (!plan.context?.genKit && plan.context?.recheckEnabled === 0) {
    await rest(planFilter, { method: "PATCH", body: JSON.stringify({ last_recheck_at: new Date(nowMs).toISOString() }) }).catch(() => undefined);
    return new Response("recheck disabled", { status: 200 });
  }
  const failPlan = async (note: string): Promise<Response> => {
    const freshRead = await rest(`${planFilter}&select=state_version,updated_at,retry_count&limit=1`).catch(() => null);
    const fresh = freshRead?.ok ? (await freshRead.json())[0] : null;
    if (fresh && fresh.updated_at !== plan.updated_at) return new Response("plan replaced; old failure ignored", { status: 200 });
    if (fresh && Number.isFinite(fresh.state_version)) plan.state_version = fresh.state_version;
    const count = (Number(fresh?.retry_count ?? plan.retry_count) || 0) + 1;
    const stopped = count >= 6 || !Number.isFinite(plan.state_version);
    const next = new Date(nowMs + Math.min(120, 5 * 2 ** (count - 1)) * 60000).toISOString();
    const modern = Number.isFinite(plan.state_version);
    // Metadata writes never replace a plan snapshot; a new upload also resets errors.
    const filter = planFilter + (plan.updated_at ? `&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : "")
      + (modern ? `&state_version=eq.${plan.state_version}` : "");
    await rest(filter, { method: "PATCH", body: JSON.stringify(modern ? {
      retry_count: count, next_retry_at: stopped ? null : next, retry_stopped: stopped,
      retry_error: note.slice(0,300), last_recheck_at: new Date(nowMs).toISOString(),
    } : { last_recheck_at: "9999-01-01T00:00:00.000Z" }) }).catch(() => undefined);
    return new Response(`${stopped ? "stopped" : "retry scheduled"}: ${note}`, { status: 503 });
  };
  if (!Number.isFinite(plan.state_version)) return failPlan("需要 schema 12：请更新数据库后重新同步计划");
  if (plan.retry_stopped) return new Response("stopped: " + plan.retry_error, { status: 200 });
  if (Date.parse(plan.next_retry_at || "") > nowMs) return new Response("retry backoff", { status: 200 });
  const lastRecheckMs = Math.max(plan.last_recheck_at ? Date.parse(plan.last_recheck_at) || 0 : 0, +plan.judged_at || 0) || NaN;
  const context = plan.context || {};
  let rowTz = guanianContextTimezone(context as Record<string, unknown>, nowMs);
  if (rowTz === null) {
    // A frozen request can recover the timezone of a legacy empty-day plan.
    const keys = [context.judgeTemplate, context.sentinelWakeId ? "timedwake:" + context.sentinelWakeId : "", ...(plan.items || []).slice(0, 3).map(w => "timedwake:" + w.wakeId)].filter(Boolean);
    for (const key of keys) {
      try {
        const r = await rest(`push_jobs?user_id=eq.${encodeURIComponent(userId)}&trigger_key=eq.${encodeURIComponent(String(key))}&select=payload&limit=1`);
        if (!r.ok) continue;
        const row = (await r.json())[0];
        if (!row) continue;
        const frozen = JSON.parse(await decryptPayload(row.payload, payloadKey));
        rowTz = guanianTimezone(frozen.merge?.tzOffsetMin, frozen.merge?.quietWin?.tzOffsetMin);
        if (rowTz !== null) break;
      } catch { /* Try the next template; otherwise stop explicitly below. */ }
    }
  }
  if (rowTz === null) return failPlan("时区资料缺失：请打开挂念重新同步计划，不能按 UTC 猜约定时间");
  context.tzOffsetMin = rowTz;
  if (context.day) context.day = { ...context.day, tz: rowTz };

  // 云端生成：这一行还只是 App 寄来的生成原料（没有 day，也没有时刻），到点才动，
  // 生成之前不走下面的复核——没有生活面的复核和自发起念都无从判起。
  const kit = context.genKit && typeof context.genKit === "object" ? context.genKit : null;
  if (kit && context.generatedBy !== "cloud") {
    if (context.genEnabled === 0) return new Response("gen: disabled", { status: 200 });
    planFilter += "&or=(context->>genEnabled.is.null,context->>genEnabled.neq.0)";
    const tz = rowTz;
    kit.tz = rowTz;
    const local = new Date(nowMs + tz * 60_000);
    const localDate = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
    // 还没到点的原料行也记一下 last_recheck_at，别让它一直排在 cron 派发队列最前面挤掉别的计划
    const later = (note: string) => rest(planFilter, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_recheck_at: new Date().toISOString() }),
    }).catch(() => undefined).then(() => new Response(note, { status: 200 }));
    if (localDate < planDate) return later("gen: not that day yet");
    if (localDate > planDate) return later("gen: day passed");
    if (hhmm(nowMs, tz) < String(kit.autoGenAt || "07:30")) return later("gen: before autoGenAt");
    if ((Number(context.genTries) || 0) >= GEN_MAX_TRIES) return new Response("gen: gave up", { status: 200 });
    const overUsage = usageExceeded(await usageBudget(rest, userId));
    if (overUsage) return later("gen: usage cap");
    if (Number.isFinite(lastRecheckMs) && nowMs - lastRecheckMs < 10 * 60_000) return new Response("gen: in progress", { status: 200 });
    // 先占坑：last_recheck_at 一写，cron 25 分钟内不会再派同一行
    const claim = await rest(
      plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
      { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ last_recheck_at: new Date().toISOString() }) },
    ).catch(() => undefined);
    const claimed = claim?.ok ? await claim.json().catch(() => []) as unknown[] : [];
    if (!Array.isArray(claimed) || claimed.length === 0) return new Response("gen: plan changed", { status: 200 });
    const work = generateCloudDay({ rest, payloadKey, userId, characterId, planDate, planFilter, plan, context, kit, nowMs }).catch(() => undefined);
    const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work);
    else await work;
    return new Response("gen: started", { status: 200 });
  }
  if (context.recheckEnabled === 0) {
    await rest(planFilter, { method: "PATCH", body: JSON.stringify({ last_recheck_at: new Date().toISOString() }) }).catch(() => undefined);
    return new Response("recheck disabled", { status: 200 });
  }
  // 关闭过程中，已在运行的旧复核不能把 context 写回去重新打开开关。
  planFilter += "&or=(context->>recheckEnabled.is.null,context->>recheckEnabled.neq.0)";
  // 过了日子的行还会在 cron 的 36 小时窗口里待一天：没有待发时刻，但起念门可能还开着，
  // 每轮都可能白调一次模型，产出又全因为不是今天而被丢掉。
  if (Number.isFinite(rowTz) && usageLocalDay(nowMs, rowTz) > planDate) {
    await rest(planFilter, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_recheck_at: new Date().toISOString() }) }).catch(() => undefined);
    return new Response("plan date passed", { status: 200 });
  }

  const gate = (key: keyof typeof GATE_DEF): number => {
    const value = Number(context[key]);
    return Number.isFinite(value) && value >= 0 ? value : GATE_DEF[key];
  };

  let cloudHistory: GuanianCloudHistory;
  try {
    // Legacy apps uploaded an empty session. Recover only from this character's
    // own encrypted templates; never substitute another session's history.
    let sessionId = String(plan.session_id || "");
    if (!sessionId) {
      const keys = [context.judgeTemplate, context.sentinelWakeId ? "timedwake:" + context.sentinelWakeId : "",
        ...(plan.items || []).map(w => w.wakeId ? "timedwake:" + w.wakeId : "")]
        .filter(Boolean).slice(0, 30).map(k => `"${String(k).replace(/[^A-Za-z0-9._:-]/g, "")}"`);
      if (keys.length) {
        const response = await rest(`push_jobs?user_id=eq.${encodeURIComponent(userId)}&trigger_key=in.(${encodeURIComponent(keys.join(","))})&select=payload&limit=30`);
        if (!response.ok) throw new Error("session template unavailable");
        for (const row of await response.json()) {
          try {
            const p = JSON.parse(await decryptPayload(row.payload, payloadKey));
            if (p.notify?.characterId && p.notify.characterId !== characterId) continue;
            if (typeof p.merge?.sessionId === "string" && p.merge.sessionId) { sessionId = p.merge.sessionId; break; }
          } catch { /* try another template */ }
        }
      }
    }
    cloudHistory = await readGuanianCloudHistory(rest, userId, sessionId, context);
  }
  catch { return failPlan("云端历史或会话模板读取失败，请检查数据库和模板"); }
  const items = Array.isArray(plan.items) ? plan.items : [];
  let sentChanged = false;
  for (const o of cloudHistory.outputs) {
    const w = items.find(w => o.trigger_key === "timedwake:" + w.wakeId);
    const at = Date.parse(o.created_at);
    if (!w || !Number.isFinite(at) || w.generatedAt === at) continue;
    w.generatedAt = at; sentChanged = true;
    const t = (context.threads || []).find(t => t.id === w.from);
    if (t && !t.done && (t.kind !== "promise" || Number(t.revision || 1) === Number(w.promiseRevision || 1))) {
      t.mentionedAt = at; t.at = at;
      if (t.kind === "topic") t.done = true;
      else t.nudge = (String(t.nudge || "") + " said:" + w.time).trim().slice(-200);
    }
  }
  const allDecisions = Array.isArray(plan.decisions) ? plan.decisions : [];
  const priorDecisions = allDecisions.filter(d => (d as { kind?: string }).kind !== "gate");
  // 自发起念：没有新聊天也可以起念，由头是TA自己这一天里的事——刚做完一件有分量的日程，
  // 或者双方安静太久。每一次都是一次裁决调用，所以另有每日上限（selfImpulseCap），
  // 用掉的次数记在 context.selfUsed，App 上传计划时会原样带回来，重新编排才清零。
  let day = context.day && typeof context.day === "object" ? context.day : null;
  let selfUsed = Number(context.selfUsed) || 0;
  let selfReason = "";
  let threadNudged: { id: string; mark: string; reason: string } | null = null;
  let selfKind = "";
  // 想念和余韵的骰子各只掷一次，掷过的键要落库——就算这轮被拦下也要记，否则每 5 分钟重掷
  const selfMarks: Record<string, number> = {};
  let echoRows: { role: string; content: string; message_at: string }[] = [];
  let budgetTz = 0;
  // 生活轮在门禁之前：不花模型、不看有没有新聊天。掷完的标记和发圈账直接落库——
  // 不走 touch，last_recheck_at 是裁决的印记，掷骰子不该让门禁以为刚判过。
  const life = lifeRoll(context, nowMs);
  if (life) Object.assign(context, life.patch);
  // 回音账同样在门禁之前记，也不调模型
  const fbRoll = await feedbackWithPreviousDay(rest, userId, characterId, planDate, items, context, nowMs).catch(() => null);
  if (fbRoll) { context.fb = fbRoll.fb; context.fbSeen = fbRoll.fbSeen; }
  if (life || fbRoll || sentChanged) {
    if (life?.post) priorDecisions.push({ at: nowMs, kind: "post", note: `想发条朋友圈——${life.post.hint}`, by: "cloud" });
    for (const note of fbRoll?.settled || []) priorDecisions.push({ at: nowMs, kind: "settle", note, by: "cloud" });
    const noteful = !!life?.post || !!fbRoll?.settled.length;
    const savedEarly = await rest(planFilter, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ context, ...(sentChanged ? { items } : {}), ...(noteful ? { decisions: priorDecisions.slice(-60) } : {}) }),
    }).catch(() => undefined);
    if (!savedEarly?.ok) return savedEarly?.status === 409 ? new Response("plan changed", { status: 200 }) : failPlan("计划进度保存失败，等待恢复");
    if (life?.post) console.log("[push-recheck] 生活轮起意发圈：" + life.post.hint);
  }
  // 由头的分量曲线，门禁里各由头选定后算，额度紧时拿它卡槛
  let selfCurve = 1;
  // 用户一句「好了 / 算了」直接了结的账本条目，拦下来也要落库
  let wordSettled: { id: string; text: string; how: string; said: string }[] = [];
  const reconcilePromises = async (): Promise<void> => {
    const response = await rest(`${planFilter}&select=*&limit=1`);
    if (!response.ok) throw new Error("约定计划读取失败");
    const current = (await response.json())[0];
    if (!current) return;
    const ctx = current.context || {}, list = current.items || [];
    const threads = Array.isArray(ctx.threads) ? ctx.threads : [];
    if (threads.some((t: Thread) => t.kind === "promise")) {
      const cancelled = await rest("rpc/push_cancel_stale_promises", { method: "POST", body: JSON.stringify({
        p_user_id: userId, p_character_id: characterId, p_threads: threads,
      }) });
      if (!cancelled.ok) throw new Error("旧约定任务撤销失败");
    }
    const end = nowMs + 31 * 86400000;
    const need = threads.filter((t: Thread) => promiseNeedsTask(t, list, nowMs, end));
    if (!need.length) return;
    if (!ctx.wakePrefix) throw new Error("约定缺少预约模板前缀，请打开挂念重新同步");
    const keys = [ctx.sentinelWakeId, ...list.map((w: PlanItem) => w.wakeId)].filter(Boolean).map(id => `"timedwake:${id}"`);
    if (ctx.judgeTemplate) keys.push(`"${String(ctx.judgeTemplate).replace(/[^A-Za-z0-9._:-]/g, "")}"`);
    if (!keys.length) throw new Error("约定缺少可用模板");
    const templates = await rest(`push_jobs?user_id=eq.${encodeURIComponent(userId)}&trigger_key=in.(${encodeURIComponent(keys.join(","))})&select=payload&limit=30`);
    if (!templates.ok) throw new Error("约定模板读取失败");
    let template: JobPayload | null = null;
    for (const t of await templates.json()) {
      try { const p = JSON.parse(await decryptPayload(t.payload, payloadKey)); if (p.request) { template = p; break; } } catch { /* try next stored template */ }
    }
    if (!template) throw new Error("约定缺少可用模板");
    for (const t of need) {
      const fireAt = Math.max(Number(t.due), nowMs + 15000);
      const intent = promiseIntent(t, new Date(Number(t.due) + (Number(rowTz) || 0) * 60000).toISOString().slice(0, 16));
      const wakeId = ctx.wakePrefix + "promise_" + t.id + "_" + (Number(t.revision) || 1);
      const clone = JSON.parse(JSON.stringify(template));
      delete clone.generatedResponse; // Never inherit a completed template reply.
      clone.merge = { ...(clone.merge || {}), tzOffsetMin: rowTz, cooldownRounds: 0, guanianPromise: { id: t.id, revision: Number(t.revision) || 1 } };
      if (!appendIntentNote(clone.request.body, clone.request.providerKind, `[系统约定任务，非用户消息] ${intent}`)) continue;
      retuneWakeSnapshot(clone.request.body, clone.request.providerKind, intent, Math.max(1, Math.round((fireAt - nowMs) / 60000)));
      const item = { time: hhmm(fireAt, Number(rowTz) || 0), fireAt, origFireAt: Number(t.due),
        kind: "promise", from: t.id, promiseRevision: Number(t.revision) || 1, source: "约定·" + t.text,
        intent, why: t.why || "按明确约定到点核对", act: true, sem: "约定", wakeId };
      const result = await rest("rpc/push_arm_promise", { method: "POST", body: JSON.stringify({
        p_user_id: userId, p_character_id: characterId, p_date: planDate, p_thread_id: t.id,
        p_revision: Number(t.revision) || 1, p_item: item, p_payload: await encryptPayload(JSON.stringify(clone), payloadKey),
      }) });
      if (!result.ok) throw new Error("约定预约失败，请更新 schema 11");
    }
  };
  try {
    await reconcilePromises();
    const refreshed = await rest(`${planFilter}&select=items,context,decisions,updated_at,state_version,recheck_count&limit=1`);
    if (!refreshed.ok) throw new Error("plan refresh failed");
    const latest = (await refreshed.json())[0];
    if (latest) {
      items.splice(0, items.length, ...(latest.items || [])); Object.assign(context, latest.context || {});
      rowTz = guanianContextTimezone(context as Record<string, unknown>, nowMs) ?? rowTz;
      context.tzOffsetMin = rowTz;
      if (context.day) context.day = { ...context.day, tz: rowTz };
      plan.state_version = latest.state_version;
      plan.recheck_count = latest.recheck_count ?? plan.recheck_count;
      if (latest.updated_at) plan.updated_at = latest.updated_at;
      if (Array.isArray(latest.decisions)) priorDecisions.splice(0, priorDecisions.length, ...latest.decisions.filter(d => d.kind !== "gate"));
    }
  } catch (e) { return failPlan("约定同步失败：" + String(e instanceof Error ? e.message : e)); }
  day = context.day && typeof context.day === "object" ? context.day : null;
  selfUsed = Number(context.selfUsed) || 0;
  if (planWriteFailed) return failPlan("计划保存失败，等待恢复");
  if (planConflict) return new Response("plan changed; retry fresh snapshot", { status: 200 });
  const evidence = recheckEvidence(cloudHistory.messages, context.threads || [], +plan.judged_chat_at || nowMs - 6 * 3600000);
  const promiseUpdate = evidence.promiseUpdate;
  const ledgerOnly = evidence.ledgerOnly;
  const pending = items.filter(item => item.kind !== "promise" && Number(item.fireAt) > nowMs + LEAD_MS);
  const litCount = ordinaryQuota(items);
  const horizon = gate("gateHorizonMin") * 60_000;
  const nearest = pending.length ? Math.min(...pending.map(item => Number(item.fireAt))) - nowMs : Infinity;
  const canJudge = !ledgerOnly && pending.length > 0 && (horizon <= 0 || nearest <= horizon);
  const canImpulse = !ledgerOnly && context.chatCandidates !== "不允许临时起念" && litCount < Number(context.quota ?? 3);
  let blocked = await (async (): Promise<string> => {
    if (Number.isFinite(lastRecheckMs) && nowMs - lastRecheckMs < (promiseUpdate ? Math.min(1, gate("gateGapMin")) : gate("gateGapMin")) * 60_000) return "离上次裁决还不够久";
    const budget = await usageBudget(rest, userId);
    budgetTz = budget.tz;
    const over = usageExceeded(budget);
    if (over) return over;
    if ((plan.recheck_count || 0) >= gate("gateDailyCap")) return "今天的裁决次数用完了";
    if (!canJudge && !canImpulse && !promiseUpdate) {
      if (pending.length === 0) return "今天没有还没到点的时刻，今日额度也满了";
      return `最近的时刻还在 ${Math.round(nearest / 60_000)} 分钟以外，今日额度也满了`;
    }

    // 没新消息就没有新信息，再判一次只是烧额度。首次复核回看 6 小时，
    // 别把开机前的对话全算成"新"。
    const freshRows = evidence.updates;
    if (Array.isArray(context.threads) && freshRows.length) {
      wordSettled = settleByWords(context.threads, freshRows.filter(r => r.role === "user").map(r => String(r.content || "")), nowMs);
    }
    if (!promiseUpdate && freshRows.length < Math.max(1, gate("gateMinMsgs"))) {
      const quiet = "上次裁决之后你没说几句";
      if (!canImpulse || !day || gate("selfImpulseCap") <= 0) return quiet;
      if (selfUsed >= gate("selfImpulseCap")) return `${quiet}，今天的自发起念也用完了`;
      const qs = String(context.quietStart || ""), qe = String(context.quietEnd || "");
      const now = guanianNow(day, nowMs, qs, qe);
      if (qs && qe && qs !== qe && (qs < qe ? (now.hm >= qs && now.hm < qe) : (now.hm >= qs || now.hm < qe))) return `${quiet}，现在是免打扰时段`;
      if (now.asleep) return `${quiet}，TA在睡觉`;
      // 随用随判模式下自发起念是主路而不是兜底：任何刚做完的日程都算由头，安静判据
      // 每过一个周期都能再想一次。次数由 selfImpulseCap、gateGapMin 和下面的配速兜着。
      const live = Number(context.impulseMode) === 1;
      const silenceMs = Math.max(30, Number(context.selfSilenceMin ?? 180)) * 60_000;
      // 配速：随用随判只看「此刻」，没有全天视野，不配速会上午就把额度用光。
      // 允许用掉的额度 = 今天已过去的比例 × quota，至少放开 1 个。
      if (live && day) {
        const tzM = Number(day.tz) || 0;
        const localNow = new Date(nowMs + tzM * 60_000);
        const midnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - tzM * 60_000;
        const hmMs = (hm: string) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
          return m ? midnight + (+m[1] * 60 + +m[2]) * 60_000 : 0;
        };
        const dayStart = hmMs(String(day.wake || context.quietEnd || "07:00"));
        let dayEnd = hmMs(String(day.bed || context.quietStart || "23:00"));
        if (dayEnd <= dayStart) dayEnd += 86_400_000; // 过零点才睡
        const span = dayEnd - dayStart;
        if (span > 0) {
          const frac = Math.max(0, Math.min(1, (nowMs - dayStart) / span));
          const allowed = Math.max(1, Math.ceil((context.quota ?? 3) * frac));
          if (litCount >= allowed) return `按今天的节奏，这会儿最多起 ${allowed} 个念头，已经有 ${litCount} 个了`;
        }
      }
      // 由头三（最具体，先看）：账本里的约定快到点 / 刚过点、到日子了
      const nudge = threadNudge(context, nowMs, rowTz);
      if (nudge) {
        selfReason = nudge.reason; threadNudged = nudge; selfKind = "thread";
        const t = liveThreads(context, nowMs).find(x => x.id === nudge.id);
        const due = t ? threadDueMs(t, nowMs, rowTz) : 0;
        // 约定：越近越重，过点 3 小时后回落；日子：当天满分，前后减半
        selfCurve = !due ? 1 : t?.kind === "date" ? (Math.abs(due - nowMs) <= 12 * 3600_000 ? 1 : 0.5)
          : due > nowMs ? 0.6 + 0.4 * (1 - Math.min(1, (due - nowMs) / (3 * 3600_000))) : Math.max(0.3, 1 - (nowMs - due) / (3 * 3600_000) * 0.7);
        return "";
      }
      // 下面几个由头都先看「谁最后说的」：TA自己起的念头发出去没人回，一律不追——
      // 追一句没人回的话是催回复，不是想念。正常一问一答后停下来的不算
      const tail = [...cloudHistory.messages].reverse();
      const lastAnyMs = Date.parse(tail[0]?.message_at || "");
      const lastUserMs = Date.parse(tail.find(r => r.role === "user")?.message_at || "");
      const lastMineMs = Date.parse(tail.find(r => r.role !== "user")?.message_at || "");
      // 「没人回」的判据：TA最后开口在用户之后，且那句要么对得上今天某个点亮的时刻，
      // 要么离用户上一句超过半小时——正常回复都是紧跟着用户那句的，隔很久才说的只能是主动找的
      const hanging = Number.isFinite(lastMineMs) && (!Number.isFinite(lastUserMs) || lastMineMs > lastUserMs)
        && (!Number.isFinite(lastUserMs) || lastMineMs - lastUserMs > 30 * 60_000
          || items.some(it => it.act && Number(it.fireAt) <= nowMs && Number(it.fireAt) > lastUserMs));
      if (hanging) return `${quiet}，上一个念头发出去还没回音`;
      const tzM = Number(day.tz) || 0;
      const daytime = now.hm >= "10:00" && now.hm < "21:30";
      const absentDays = Number.isFinite(lastUserMs) ? (nowMs - lastUserMs) / 86_400_000 : 0;
      // 由头四：断了好几天。每段断联（以用户最后一句为界）只掷一次骰子，概率随这类念头的回音率涨落
      const missDays = Number(context.missDays ?? 3);
      if (missDays > 0 && daytime && absentDays >= missDays && absentDays <= 21 && Number(context.missKey) !== lastUserMs) {
        selfMarks.missKey = lastUserMs;
        if (Math.random() < Math.min(0.9, 0.56 * fbMod(context.fb, "miss"))) {
          selfKind = "miss"; selfReason = `已经 ${Math.floor(absentDays)} 天没联系了`;
          selfCurve = Math.min(1, 0.5 + absentDays / 14 * 0.5);
          return "";
        }
      }
      // 由头一：上次裁决之后新开始了一条日程（严格模式还要求耗神/回血明显或有情绪余味）
      const tzMs = tzM * 60_000;
      const sameLocalDay = Number.isFinite(lastRecheckMs)
        && Math.floor((lastRecheckMs + tzMs) / 86_400_000) === Math.floor((nowMs + tzMs) / 86_400_000);
      const sinceHM = sameLocalDay ? guanianNow(day, lastRecheckMs, qs, qe).hm : "00:00";
      const weighty = now.done && String(now.done.time) > sinceHM
        && (live || Math.abs(Number(now.done.cost) || 0) >= 15 || !!now.done.mood);
      if (weighty) {
        selfReason = `刚${now.done!.title || "做完一件事"}`; selfKind = "done";
        // 事过 3 小时就不新鲜了
        const endHM = String(now.done!.end || now.done!.time), m = /^(\d{1,2}):(\d{2})$/.exec(endHM);
        const sinceMin = m ? (Number(now.hm.slice(0, 2)) * 60 + Number(now.hm.slice(3)) - (+m[1] * 60 + +m[2])) : 0;
        selfCurve = Math.max(0, 1 - Math.max(0, sinceMin) / 180);
        return "";
      }
      if (!Number.isFinite(lastAnyMs)) return quiet; // 从没聊过的不算「安静」
      // 由头五：昨天的余韵。每天只掷一次；昨天要真聊过几句，TA上一句也已过了 8 小时
      const localDay = Math.floor((nowMs + tzM * 60_000) / 86_400_000);
      if (Number(context.echoOn ?? 1) === 1 && daytime && absentDays <= 7 && Number(context.echoKey) !== localDay
        && (!Number.isFinite(lastMineMs) || nowMs - lastMineMs >= 8 * 3600_000)) {
        const dayStart = localDay * 86_400_000 - tzM * 60_000;
        const echoResponse = await rest(
          `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
          + `&character_id=eq.${encodeURIComponent(characterId)}`
          + `&message_at=gte.${encodeURIComponent(new Date(dayStart - 86_400_000).toISOString())}`
          + `&message_at=lt.${encodeURIComponent(new Date(dayStart).toISOString())}`
          + "&or=(media_type.is.null,media_type.neq.response_batch)&select=role,content,message_at&order=message_at.desc&limit=40",
        );
        const rows = echoResponse.ok ? (await echoResponse.json() as typeof echoRows).reverse() : [];
        const userSaid = rows.filter(r => r.role === "user").map(r => String(r.content || ""));
        // 昨天聊得沉重的不拿来当轻松的余韵——那是该关心的事，让用户开口或走临时起念
        const heavy = /低落|焦虑|难受|压力|紧张|失眠|疲惫|不舒服|担心|烦躁|委屈|害怕|心情不好|生病|发烧|吵架|分手/;
        if (userSaid.length >= 3 && !userSaid.some(v => heavy.test(v))) {
          selfMarks.echoKey = localDay;
          if (Math.random() < Math.min(0.6, 0.24 * fbMod(context.fb, "echo"))) { echoRows = rows; selfKind = "echo"; selfReason = "忽然想起昨天聊过的一件小事"; return ""; }
        }
      }
      // 由头二：双方都安静太久。断到「想念」那么久之后就不再按小时算安静，交给上面的骰子
      if (missDays > 0 && absentDays >= missDays) return `${quiet}，断了 ${Math.floor(absentDays)} 天，这段只想念一次`;
      const silentMs = nowMs - lastAnyMs;
      // 严格模式一段安静只起一次念；随用随判每过一个安静周期都可以再想一次
      if (silentMs >= silenceMs && (live || !Number.isFinite(lastRecheckMs) || lastRecheckMs < lastAnyMs + silenceMs)) {
        const mins = Math.round(silentMs / 60_000);
        selfKind = "quiet";
        selfReason = mins >= 120 ? `已经 ${Math.round(mins / 60)} 小时没联系` : `已经 ${mins} 分钟没联系`;
        return "";
      }
      return quiet;
    }
    const freshMs = gate("gateFreshMin") * 60_000;
    const lastMsgMs = Date.parse(freshRows[freshRows.length - 1]?.message_at || "");
    if (!promiseUpdate && freshMs > 0 && Number.isFinite(lastMsgMs) && nowMs - lastMsgMs < freshMs) return "你才刚说完，等一下再判";
    return "";
  })();

  // 额度紧时按分量卡槛：低分由头别把最后一两个额度用掉，留给约定到点、临时冒出来的要紧事
  if (!blocked && selfKind) {
    const remaining = Number(context.quota ?? 3) - litCount;
    const value = impulseValue(selfKind, selfCurve, context.fb);
    if (value < valueFloor(remaining)) {
      blocked = `额度只剩 ${remaining} 个，「${SELF_KIND[selfKind] || selfKind}」这种由头分量不够（${value.toFixed(2)}）`;
      selfReason = ""; selfKind = ""; threadNudged = null;
    }
  }
  if (wordSettled.length) {
    // 出自这几条账本的待发时刻一并撤掉：预约标 cancelled，items 带乐观锁写回（被 App 改过就交给 App 那边合并时撤）
    const cancelIds = new Set(wordSettled.map(w => w.id));
    let touched = 0;
    for (const it of items) {
      if (!it.from || !cancelIds.has(it.from) || !it.act || Number(it.fireAt) <= nowMs + LEAD_MS) continue;
      it.act = false; it.wakeId = ""; it.why = "这件事你说了结了"; touched += 1;
      priorDecisions.push({ at: nowMs, time: it.time, kind: "recheck", note: `取消——${it.why}`, by: "cloud" });
    }
    for (const w of wordSettled) priorDecisions.push({ at: nowMs, kind: "settle", note: `你说「${w.said}」，${w.how}了「${w.text}」`, by: "cloud" });
    await rest(
      touched && plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
      { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ context: { ...context, ...selfMarks }, decisions: priorDecisions.slice(-60), ...(touched ? { items } : {}) }) },
    ).catch(() => undefined);
    console.log("[push-recheck] 按用户原话了结账本：" + wordSettled.map(w => w.text).join("、"));
  } else if (Object.keys(selfMarks).length) {
    Object.assign(context, selfMarks);
    await rest(planFilter, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ context }) }).catch(() => undefined);
  }
  if (wordSettled.length) Object.assign(context, selfMarks);
  if (planWriteFailed) return failPlan("计划保存失败，等待恢复");
  if (planConflict) return new Response("plan changed; retry fresh snapshot", { status: 200 });

  if (blocked) {
    // 拦截原因写回 decisions：不带 time，App 合并裁决时会跳过它，只当诊断用。
    // 原因没变就不写——cron 每半小时来一次，没必要每次都动这一行。
    const prev = allDecisions.find(d => (d as { kind?: string }).kind === "gate") as { note?: string } | undefined;
    if (prev?.note !== blocked) {
      await rest(
        plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            decisions: [...priorDecisions, { at: nowMs, kind: "gate", note: blocked, by: "cloud" }].slice(-60),
          }),
        },
      ).catch(() => undefined);
    }
    return new Response(blocked, { status: 200 });
  }

  // 先占坑再干活：后面任何一步失败都不会让 cron 每 30 分钟原地重试同一份计划。
  const touch = (extra: Record<string, unknown> = {}, guard = false) => rest(
    // 乐观锁：这一轮手里的 items 是几十秒前读到的，期间 App 重新编排会整份覆盖这行，
    // 无条件写回就把新计划打回旧的。带上读到的 updated_at，被改过就一行也匹配不上。
    (guard && plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter)
      + (guard && judgeTask ? `&judge_token=eq.${encodeURIComponent(judgeTask.token)}` : ""),
    {
      method: "PATCH",
      headers: { Prefer: guard ? "return=representation" : "return=minimal" },
      // 只动 last_recheck_at：updated_at 留给「App 上传计划」，
      // 复核自己刷新它的话，cron 的 36 小时派发窗口就永远不会过期。
      body: JSON.stringify({ last_recheck_at: new Date().toISOString(), ...extra }),
    },
  ).catch(() => undefined);
  let judgeTask: { token: string; chatAt: number } | null = null;
  let judgeApplied = false;
  const armedKeys: string[] = [];

  const run = async (): Promise<void> => {
    if (planConflict) return;
    // 时区：计划里的 time 是用户本地 HH:MM，fireAt 是绝对毫秒。两者一减就还原出本地偏移，
    // 后面给临时起念算时刻直接复用，不必猜数据库时区。
    // 挑第一条 time 合法的当基准；一条都没有就退回 UTC，同时不许云端起念——
    // Use the verified timezone, never infer it from an old/deferred item's HH:MM.
    const anchor = { time: hhmm(nowMs, rowTz), fireAt: Math.floor(nowMs / 60000) * 60000 };
    const anchorTrusted = true;
    const anchorLocal = Number(anchor.time.split(":")[0]) * 60 + Number(anchor.time.split(":")[1]);
    const offsetMin = rowTz;

    // 快照模板：优先拿今天还没发的那几条预约。它们的 payload 里冻着上游地址和密钥，
    // 裁决调用和后面的点亮都靠它——本函数自己不持有任何模型凭据。
    // 哨兵预约（App 编排时挂的、48 小时后才到点的模板）也算在内：一个时刻都没点亮的日子全靠它。
    const sentinelWakeId = typeof context.sentinelWakeId === "string" ? context.sentinelWakeId : "";
    const wakeKeys = items.map(item => item.wakeId).concat(sentinelWakeId).filter(Boolean).map(id => `"timedwake:${id}"`);
    const judgeKey = typeof context.judgeTemplate === "string" ? context.judgeTemplate : "";
    if (judgeKey) wakeKeys.push(`"${judgeKey.replace(/[^A-Za-z0-9._:-]/g, "")}"`);
    let judgeTemplate: JobPayload | null = null;
    let found: JobPayload | null = null;
    const jobsByKey = new Map<string, JobRow>();
    let unreadableTemplates = 0;
    if (wakeKeys.length > 0) {
      const jobsResponse = await rest(
        `push_jobs?user_id=eq.${encodeURIComponent(userId)}`
        + `&trigger_key=in.(${encodeURIComponent(wakeKeys.join(","))})`
        + "&select=id,trigger_key,status,execute_at,payload",
      );
      if (!jobsResponse.ok) throw new Error(`聊天模板读取失败：HTTP ${jobsResponse.status}，请检查云端连接后重试`);
      const jobRows = await jobsResponse.json() as JobRow[];
      for (const row of jobRows) jobsByKey.set(row.trigger_key, row);
      // 待发的快照最新，已发过的是今早的上下文——克隆和裁决都优先用前者。
      jobRows.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
      for (const row of jobRows) {
        try {
          if (row.trigger_key === judgeKey) judgeTemplate = JSON.parse(await decryptPayload(row.payload, payloadKey)) as JobPayload;
          else if (!found) found = JSON.parse(await decryptPayload(row.payload, payloadKey)) as JobPayload;
        } catch { if (row.trigger_key !== judgeKey) unreadableTemplates++; }
      }
    }
    if (!found) throw new Error(unreadableTemplates
      ? "聊天模板解密失败：记录存在但无法解密，请在挂念后台重试同步以重建模板"
      : wakeKeys.some(key => key !== `"${judgeKey}"`)
        ? "缺少聊天模板：计划引用的聊天预约记录不存在，请在挂念后台重试同步"
        : "缺少聊天模板：计划没有关联聊天预约，请在挂念后台重试同步");
    const template = found;
    const judgeRequest = (judgeTemplate || template).request;

    const mirrorRows = cloudHistory.messages;

    // 免打扰和最小间隔在提示词里说过，但模型说了不算：和 App 本地一样再硬拦一道。
    const inQuiet = (hm: string) => {
      const qs = context.quietStart || "";
      const qe = context.quietEnd || "";
      if (day && guanianAsleep(day, hm, qs, qe)) return true; // 睡着的时段和免打扰一样硬拦
      if (!qs || !qe || qs === qe) return false;
      return qs < qe ? (hm >= qs && hm < qe) : (hm >= qs || hm < qe);
    };
    const tooClose = (fireAt: number, list: PlanItem[], self?: PlanItem) => {
      const gap = Number(context.minGapMin || 0) * 60_000;
      if (!gap) return false;
      return (guanianLastProactiveAt(cloudHistory) > 0 && Math.abs(fireAt - guanianLastProactiveAt(cloudHistory)) < gap)
        || list.some(other => other.kind !== "promise" && other.act && other !== self && Math.abs((other.generatedAt || other.fireAt) - fireAt) < gap);
    };
    const characterName = template.notify?.title || "TA";
    const chatLines = guanianHistoryText(cloudHistory, offsetMin, judgeLinesOf(context.judgeLines), context);
    const planLines = pending
      .map(item => `- ${item.time}｜${item.source}｜${item.act ? "已点亮" : "未点亮"}｜意图：${item.intent || "（无）"}｜理由：${item.why || "（无）"}`)
      .join("\n");

    // 自发起念这轮没有新聊天，判决无从谈起：只问「此刻TA自己想不想找用户」
    const judge = canJudge && !selfReason;
    const threadsOn = Array.isArray(context.threads);
    // 发朋友圈不占私聊额度，但有自己的每日上限；免打扰和睡觉由门禁那层先挡（自发那轮）或由用户在聊天这件事本身证明TA醒着
    const moBudget = momentsBudget(context, nowMs, rowTz);
    const canPost = !ledgerOnly && moBudget.ok;
    const threadLinesNow = threadsOn ? threadLines(context, nowMs, offsetMin) : [];
    const now = day ? guanianNow(day, nowMs, context.quietStart, context.quietEnd) : null;
    const stateLine = now
      ? `此刻的状态：${now.asleep ? "在睡觉" : "在" + (now.doing || "没什么特别的")}${now.step ? "（" + now.step + "）" : ""}，情绪「${now.mood}」，精力 ${now.energy}%${now.next ? "，接下来 " + now.next : ""}。`
      : (context.mood || context.energy ? `今天的状态：心情「${context.mood || "普通"}」，精力「${context.energy || "普通"}」。` : "");
    const prompt = [
      ledgerOnly ? "本轮仅核对角色的新承诺，只有 keep/settle 可非空，decisions/extra/post 必须为空。" : "",
      `你现在是「${characterName}」，在盘算今天剩下的时间要不要主动联系用户。现在是本地时间 ${hhmm(nowMs, offsetMin)}。`,
      context.bias ? `你的性格倾向：${context.bias}` : "",
      stateLine,
      affectionLine(context.affection),
      `规矩：今天最多主动 ${context.quota ?? 3} 次（已点亮 ${litCount} 次）；`
      + `${context.quietStart || "23:00"}–${context.quietEnd || "07:00"} 不打扰；两次之间至少隔 ${context.minGapMin ?? 90} 分钟。`,
      "",
      selfReason ? "最近和用户的对话（这之后没有新消息）：" : "刚刚和用户的对话：",
      chatLines || "（这段时间没有对话记录）",
      "",
      selfKind === "echo" && echoRows.length
        ? "昨天的对话：\n" + echoRows.map(row => `${row.role === "user" ? "用户" : characterName}（${hhmm(Date.parse(row.message_at), offsetMin)}）：${String(row.content || "").slice(0, 160)}`).join("\n") + "\n"
        : "",
      judge ? "今天剩下的计划时刻：" : (selfReason ? "" : "今天排好的时刻都已经过点了，没有要重判的。"),
      judge ? planLines : "",
      "",
      threadsOn && threadLinesNow.length ? "你心里还挂着的事：\n" + threadLinesNow.join("\n") : "",
      selfReason
        ? selfBrief(selfKind, selfReason) + fbLine(context.fb, selfKind) + "不想说就老实写 []，不要为了发而发。真要发的话时刻定在接下来 5 到 40 分钟之间。已经说过或已经解决的事不要重复起念。"
        : canJudge
        ? "根据刚才聊过的内容重新判断每个时刻：聊过的话题已经了了就别再提，"
          + "用户说了忙/情绪不好就收敛，聊到一半没说完或约好了要说的事可以点亮"
          + (canImpulse ? "甚至新加一个时刻。" : "。")
        : "只看刚才聊的内容里有没有值得临时起一个新念头的事：聊到一半没说完的话头、"
          + "约好了要说的、答应了要问的。只是随口聊到、没落实的事不算。",
      "只输出 JSON，不要任何解释：",
      "{"
      + (judge
        ? '"decisions":[{"time":"HH:MM","act":true,"sem":"关心|分享|约定|闲聊","topic":"一句话主题","why":"你为什么这么定","intent":"到点时你想说的事，一句话","defer":"只是这个点不合适、话还想说时填今天更晚的HH:MM，否则空字符串"}]'
        : '"decisions":[]')
      + ","
      + (canImpulse
        ? '"extra":[{"time":"HH:MM","about":"这个念头的由头（8字内）","intent":"想说的事","why":"为什么现在加","from":"出自账本里某件事就填它的 id，否则空字符串"}]'
        : '"extra":[]')
      + (threadsOn && !selfReason
        ? ',"keep":[{"id":"已有事件的id，新事件留空","subject":"user|character|both","status":"pending|completed|cancelled","sourceMessageId":"证据消息编号","kind":"topic或promise或date","text":"一句话（20字内）","when":"promise/date 必填：YYYY-MM-DD HH:MM、HH:MM 或 MM-DD；topic 留空","why":"为什么记它（15字内）"}],"settle":["已了结的账本 id"]'
        : "")
      + (canPost ? ',"post":{"hint":"想发的朋友圈由头或大意（30字内）"}或null' : "")
      + "}",
      threadsOn && !selfReason ? THREAD_TASK : "",
      judge ? "decisions 只写你要改的时刻（其余的保持原样就不用写）。" : "decisions 一律写 []。",
      judge ? `改约：act 写 false 时，如果只是这个时刻不合适（刚聊完太密、这话晚点说更合适、这会儿说了会打断对方），而话本身还想说，就在 defer 里填今天更晚的 HH:MM，整个念头挪过去、不占新额度；真的不想说了才把 defer 留空。到点正忙或在睡觉不用你操心，系统会自动顺延，别为这个改约。没有固定时间截止；等待会让发送概率逐渐降低。是否已说过或已失去意义，按最新聊天和事实判断。` : "",
      canImpulse ? "extra 最多 1 条，没有就写 []。" : "今日额度已满，extra 一律写 []。",
      canImpulse && threadsOn
        ? "明确约定一律进 keep，系统按约定时间预约。普通话头才按以下两条路选择：今天之内说得掉的走 extra 排个时刻；今天说不掉的（要等结果、要到某个日子、隔几天再问才自然）走 keep 记进账本，以后自己会想起来。extra 出自账本里已有的某件事时 from 填那条的 id，发出去之后系统会自动把账本那条了结或标成提过了，不用再写进 settle。"
        : "",
      canPost
        ? `post：如果此刻更想发一条朋友圈而不是私聊（晒一下刚做的事、随手记一句、发个感慨——给所有人看的，不是说给用户听的），就在 post.hint 里写想发的由头或大意（30字内），由系统按你的人设成文。这周已发 ${moBudget.weekN} 条。私聊和发圈可以只要一个，也可以都不要；不想发就写 null。`
        : "",
    ].filter(Boolean).join("\n");

    const chatAt = selfReason ? 0 : mirrorRows.reduce((at, m) => Math.max(at, Date.parse(m.message_at) || 0), 0);
    const token = "cloud-" + nowMs + "-" + Math.random().toString(36).slice(2);
    const claimResponse = await rest("rpc/push_recheck_judge", { method: "POST", body: JSON.stringify({
      p_user_id: userId, p_character_id: characterId, p_date: planDate, p_token: token, p_action: "claim", p_chat_at: chatAt,
    }) }).catch(() => undefined);
    if (!claimResponse?.ok) throw new Error("复核租约不可用，请检查 schema 12");
    const claim = claimResponse?.ok ? await claimResponse.json().catch(() => null) : null;
    if (!claim?.claimed) return;
    judgeTask = { token, chatAt };
    await touch({ recheck_count: (plan.recheck_count || 0) + 1 });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let judgeText = "";
    try {
      const response = await fetch(judgeRequest.url, {
        method: "POST",
        headers: judgeRequest.headers,
        body: JSON.stringify(buildJudgeBody(judgeRequest, prompt)),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`复核模型 HTTP ${response.status}`);
      const judgeData = await response.json();
      await usageAdd(rest, userId, budgetTz, "cloud-recheck", judgeRequest.providerKind, judgeData);
      judgeText = extractResponseText(judgeRequest.providerKind, judgeData);
      if (!parseModelJson(judgeText) || typeof parseModelJson(judgeText) !== "object") throw new Error("复核返回无效 JSON");
    } finally {
      clearTimeout(timeout);
    }

    // 模型请求期间可能已关闭复核；读不到仍启用的计划时，不再应用本轮结果。
    const stillEnabled = await rest(`${planFilter}&select=plan_date&limit=1`).catch(() => undefined);
    const activeRows = stillEnabled?.ok ? await stillEnabled.json().catch(() => []) : [];
    if (!Array.isArray(activeRows) || activeRows.length === 0) return;

    // 门禁只放行了其中一组时，另一组的返回一律丢掉——提示词里已经要求写 []，
    // 但模型不一定听话，这里是硬拦。
    const judged = parseJudgeJson(judgeText);
    const decisions = judge ? judged.decisions : [];
    const extra = canImpulse ? judged.extra : [];
    // 账本改动（自发起念那轮不让模型记账，只标「这个由头提过了」）
    let threadsNext: Thread[] | null = threadsOn && !selfReason ? applyThreads(context, judged.keep, judged.settle, nowMs, offsetMin, (s) => console.log("[push-recheck] " + s), cloudHistory.messages) : null;
    if (threadNudged) {
      const base = threadsNext || (Array.isArray(context.threads) ? context.threads.map(t => ({ ...t })) : []);
      const t = base.find(x => x.id === threadNudged!.id);
      if (t) { t.nudge = (String(t.nudge || "") + " " + threadNudged.mark).trim().slice(-200); t.at = nowMs; threadsNext = base; }
    }
    const ctxPatch: Record<string, unknown> = {};
    if (threadsNext) ctxPatch.threads = threadsNext;
    // 想发圈：云端发不了帖（帖子在手机里），只把起意和时间点记进 outbox，App 下次打开补成当时的帖子
    const post: Outbox | null = canPost && judged.post ? { id: "mo" + nowMs.toString(36), at: nowMs, hint: judged.post, by: "cloud" } : null;
    if (post) {
      ctxPatch.outbox = [...(Array.isArray(context.outbox) ? context.outbox : []).slice(-4), post];
      ctxPatch.momentsLast = nowMs;
      ctxPatch.momentsWeekStart = moBudget.weekStart;
      ctxPatch.momentsWeekN = moBudget.weekN + 1;
      console.log("[push-recheck] 起意发朋友圈：" + post.hint);
    }
    const postDecision = post ? { at: nowMs, kind: "post", note: `想发条朋友圈——${post.hint}`, by: "cloud" } : null;
    const ctxDirty = !!selfReason || !!threadsNext || !!post;
    if (decisions.length === 0 && extra.length === 0 && !threadsNext) {
      const saved = await touch({
        retry_count: 0, next_retry_at: null, retry_error: null, retry_stopped: false,
        judged_chat_at: Math.max(+plan.judged_chat_at || 0, judgeTask?.chatAt || 0), judged_at: Date.now(),
        recheck_count: (plan.recheck_count || 0) + 1,
        ...((postDecision || selfReason) ? { decisions: [...priorDecisions, ...(postDecision ? [postDecision] : []),
          ...(selfReason ? [{ at: nowMs, kind: "self", note: `自发起念（${selfReason}）——本轮没有新增念头`, by: "cloud" }] : [])].slice(-60) } : {}),
        ...(ctxDirty ? { context: { ...context, ...ctxPatch, ...(selfReason ? { selfUsed: selfUsed + 1 } : {}) } } : {}),
      }, true);
      if (!saved?.ok && saved?.status !== 409) throw new Error("复核结果保存失败");
      const rows = saved?.ok ? await saved.json().catch(() => []) : [];
      judgeApplied = Array.isArray(rows) && rows.length > 0;
      if (judgeApplied) await reconcilePromises();
      return;
    }

    const applied: Record<string, unknown>[] = [];
    const nextItems = items.map(item => ({ ...item }));
    let lit = litCount;

    // 预约 id 必须带 App 上传的前缀：宿主的 push.cancelWake 只认自家 APP 的 id，
    // 前缀对不上，用户下次打开就撤不掉云端点亮的这条。
    const wakePrefix = context.wakePrefix || "";
    const armJob = async (fireAt: number, intent: string): Promise<string> => {
      if (!wakePrefix) return "";
      const wakeId = `${wakePrefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const clone = JSON.parse(JSON.stringify(template)) as JobPayload;
      delete clone.generatedResponse; // Never inherit a completed template reply.
      const note = `[系统备忘：这不是对方发来的消息。到点了，你现在想主动跟对方说的是——${intent}。`
        + "顺着你们刚才聊的往下说，别重复已经说过的话，也别提起这条备忘。]";
      if (!appendIntentNote(clone.request.body, clone.request.providerKind, note)) return "";
      retuneWakeSnapshot(clone.request.body, clone.request.providerKind, intent,
        Math.max(1, Math.round((fireAt - Date.now()) / 60_000)));
      const insert = await rest("push_jobs", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          id: `job_${crypto.randomUUID()}`,
          user_id: userId,
          trigger_key: `timedwake:${wakeId}`,
          kind: "timed_task",
          execute_at: new Date(fireAt + 15_000).toISOString(),
          status: "pending",
          payload: await encryptPayload(JSON.stringify(clone), payloadKey),
        }]),
      });
      if (!insert.ok) return "";
      armedKeys.push(`"timedwake:${wakeId}"`);
      return wakeId;
    };

    for (const decision of decisions) {
      const time = typeof decision.time === "string" ? decision.time.trim() : "";
      const index = nextItems.findIndex(item => item.kind !== "promise" && item.time === time && item.fireAt > nowMs + LEAD_MS);
      if (index < 0) continue;
      const item = nextItems[index];
      if (item.kind === "promise") continue;
      const why = String(decision.why || "").slice(0, 200);

      if (decision.act === false && item.act) {
        // 改约：话还想说、只是这个点不合适的，整条挪走而不是丢掉。挪不动就退回取消。
        const deferHM = typeof decision.defer === "string" && /^\d{1,2}:\d{2}$/.test(decision.defer.trim())
          ? decision.defer.trim().padStart(5, "0")
          : "";
        const deferAt = deferHM && anchorTrusted
          ? anchor.fireAt + ((Number(deferHM.split(":")[0]) * 60 + Number(deferHM.split(":")[1])) - anchorLocal) * 60_000
          : 0;
        // 保留最初起念时刻，改约不重置等待概率；没有固定截止。
        const deferOrig = Number(item.origFireAt) || item.fireAt;
        if (
          deferAt > nowMs + LEAD_MS && !inQuiet(deferHM)
          && !nextItems.some(other => other.kind !== "promise" && other !== item && other.time === deferHM)
          && !tooClose(deferAt, nextItems, item)
        ) {
          const deferWakeId = await armJob(deferAt, item.intent || String(decision.intent || ""));
          if (deferWakeId) {
            const from = item.time;
            item.time = deferHM;
            item.fireAt = deferAt;
            item.wakeId = deferWakeId;
            item.origFireAt = deferOrig;
            item.why = why || "这个点不合适";
            // App 合并时按 time 找本地那条，再按 to 去云端 items 里取新时刻和新预约
            applied.push({ at: Date.now(), time: from, to: deferHM, kind: "defer", note: `改约到 ${deferHM}——${item.why}`, by: "cloud" });
            continue;
          }
          // 新预约没挂上，下面取消旧时刻；提交成功后数据库才撤旧任务。
        }
        item.act = false;
        item.wakeId = "";
        item.why = why || "聊过之后TA改了主意";
        lit -= 1;
        applied.push({ at: Date.now(), time, kind: "recheck", note: `取消——${item.why}`, by: "cloud" });
        continue;
      }

      if (decision.act === true && !item.act) {
        if (lit >= (context.quota ?? 3)) continue;
        if (inQuiet(item.time) || tooClose(item.fireAt, nextItems, item)) continue;
        const intent = String(decision.intent || `刚${item.source}，想到用户`).slice(0, 200);
        const wakeId = await armJob(item.fireAt, intent);
        if (!wakeId) continue;
        item.act = true;
        item.wakeId = wakeId;
        item.intent = intent;
        item.why = why;
        item.sem = String(decision.sem || item.sem).slice(0, 40);
        item.topic = String(decision.topic || item.topic).slice(0, 200);
        lit += 1;
        applied.push({ at: Date.now(), time, kind: "lit", note: `云端点亮——${intent}`, by: "cloud" });
      }
    }

    for (const one of (anchorTrusted ? extra.slice(0, 1) : [])) {
      if ((context.threads || []).some(t => t.kind === "promise" && t.id === String(one.from || "").replace(/[\[\]\s]/g, ""))) continue;
      if (lit >= (context.quota ?? 3)) break;
      const raw = typeof one.time === "string" ? one.time.trim() : "";
      if (!/^\d{1,2}:\d{2}$/.test(raw)) continue;
      // 模型可能给 "9:30"：免打扰是字典序比较，去重也按 "09:30" 存，不补零两处都会错。
      const time = raw.padStart(5, "0");
      if (inQuiet(time)) continue;
      // extra 的 HH:MM 是本地时刻：用同一天已有时刻的绝对毫秒当基准换算，避开时区。
      const localMin = Number(time.split(":")[0]) * 60 + Number(time.split(":")[1]);
      const fireAt = anchor.fireAt + (localMin - anchorLocal) * 60_000;
      if (fireAt <= nowMs + LEAD_MS) continue;
      if (nextItems.some(item => item.kind !== "promise" && item.time === time)) continue;
      if (tooClose(fireAt, nextItems)) continue;
      const intent = String(one.intent || one.about || "").slice(0, 200);
      if (!intent) continue;
      const wakeId = await armJob(fireAt, intent);
      if (!wakeId) continue;
      const exUhm = typeof one.until === "string" && /^\d{1,2}:\d{2}$/.test(one.until.trim()) ? one.until.trim().padStart(5, "0") : "";
      const exUms = exUhm && anchorTrusted
        ? anchor.fireAt + ((Number(exUhm.split(":")[0]) * 60 + Number(exUhm.split(":")[1])) - anchorLocal) * 60_000
        : 0;
      nextItems.push({
        time,
        fireAt,
        until: exUms > fireAt ? Math.min(exUms, fireAt + 6 * 3600_000) : 0,
        source: `${selfReason ? "自发" : "临时"}·${String(one.about || (selfReason ? (SELF_KIND[selfKind] || "想起你") : "未完话题")).slice(0, 10)}`,
        act: true,
        kind: selfReason ? selfKind : "extra",
        intent,
        why: String(one.why || "").slice(0, 200),
        sem: "",
        topic: "",
        wakeId,
        // 出自账本某条：App 那边发出去之后按它回写账本（话头了结、约定标提过了）
        from: threadNudged ? threadNudged.id : (() => {
          const id = String(one.from || "").replace(/[\[\]\s]/g, "");
          return id && (Array.isArray(context.threads) ? context.threads : []).some(t => t.id === id) ? id : "";
        })(),
      });
      lit += 1;
      applied.push({ at: Date.now(), time, kind: "extra", note: `云端临时起念——${intent}`, by: "cloud" });
    }

    nextItems.sort((a, b) => a.fireAt - b.fireAt);
    // 自发起念不管有没有起成都记一笔：既扣次数，也让 App 的诊断里看得到「TA想了想，没找你」
    if (selfReason) applied.push({ at: Date.now(), kind: "self", note: `自发起念（${SELF_KIND[selfKind] ? SELF_KIND[selfKind] + "：" : ""}${selfReason}）——${lit > litCount ? "起了一个念头" : "想了想，没找你"}`, by: "cloud" });
    if (postDecision) applied.push(postDecision);
    const saved = await touch({
      retry_count: 0, next_retry_at: null, retry_error: null, retry_stopped: false,
        judged_chat_at: Math.max(+plan.judged_chat_at || 0, judgeTask?.chatAt || 0), judged_at: Date.now(),
      items: nextItems,
      decisions: [...priorDecisions, ...applied].slice(-60),
      recheck_count: (plan.recheck_count || 0) + 1,
      ...(ctxDirty ? { context: { ...context, ...ctxPatch, ...(selfReason ? { selfUsed: selfUsed + 1 } : {}) } } : {}),
    }, true);
    if (!saved?.ok && saved?.status !== 409) throw new Error("复核结果保存失败");
    const rows = saved?.ok ? await saved.json().catch(() => []) as unknown[] : [];
    if (Array.isArray(rows) && rows.length > 0) { judgeApplied = true; await reconcilePromises(); return; }

  };

  const work = run().catch(async e => { await failPlan("复核失败：" + String(e instanceof Error ? e.message : e)); }).finally(async () => {
    if (!judgeApplied && armedKeys.length) await rest(`push_jobs?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending&trigger_key=in.(${encodeURIComponent(armedKeys.join(","))})`, {
      method: "PATCH", body: JSON.stringify({ status: "cancelled", result_note: "plan commit not confirmed" }),
    }).catch(() => undefined);
    if (!judgeTask) return;
    await rest("rpc/push_recheck_judge", { method: "POST", body: JSON.stringify({
      p_user_id: userId, p_character_id: characterId, p_date: planDate, p_token: judgeTask.token,
      p_action: "finish", p_chat_at: judgeTask.chatAt, p_success: judgeApplied,
    }) }).catch(() => undefined);
  });
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work);
  else await work;
  return new Response("accepted", { status: 200 });
});

// BEGIN GUANIAN CLOUD HISTORY
// Shared by both self-contained cloud workers; injected by push:build-dist.
type GuanianCloudMessage = { id: string; role: string; content: string; message_at: string; response_batch_id?: string; media_type?: string };
type GuanianCloudOutput = { id: string; trigger_key?: string; raw_text: string; created_at: string; consumed_at?: string; meta?: Record<string, unknown> };
type GuanianCloudHistory = { messages: GuanianCloudMessage[]; outputs: GuanianCloudOutput[]; lastGeneratedAt: number;
  uncertainLegacy?: { message: GuanianCloudMessage; outputIds: string[]; exactText: boolean }[] };
type GuanianHistoryWindow = { onlineRounds?: unknown; offlineRounds?: unknown };
function guanianRoundLimit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(1, Math.round(n))) : 40;
}
function guanianHasWindow(window?: GuanianHistoryWindow): boolean {
  return window?.onlineRounds != null || window?.offlineRounds != null;
}
function guanianOnlineRounds(messages: GuanianCloudMessage[]): GuanianCloudMessage[][] {
  const rounds: GuanianCloudMessage[][] = [];
  for (const m of [...messages].filter(m => m.media_type !== "offline_summary")
    .sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id))) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const current = rounds[rounds.length - 1];
    const last = current?.[current.length - 1];
    const batch = m.response_batch_id || (m.id.startsWith("push-outbox:") ? m.id : "");
    const previousBatch = last?.response_batch_id || (last?.id.startsWith("push-outbox:") ? last.id : "");
    const separateReply = last?.role === "assistant" && m.role === "assistant"
      && (batch && previousBatch ? batch !== previousBatch : Date.parse(m.message_at) - Date.parse(last.message_at) > 180000);
    if (!current || m.role === "user" || separateReply) rounds.push([m]);
    else current.push(m);
  }
  return rounds;
}
function selectGuanianHistory(messages: GuanianCloudMessage[], window: GuanianHistoryWindow): GuanianCloudMessage[] {
  const online = guanianOnlineRounds(messages).slice(-guanianRoundLimit(window.onlineRounds)).flat();
  const offline = messages.filter(m => m.media_type === "offline_summary" && m.content.trim())
    .sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id))
    .slice(-guanianRoundLimit(window.offlineRounds));
  return [...online, ...offline].sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id));
}

/** Absence, null, booleans and invalid offsets are not UTC. Explicit zero is. */
function guanianTimezone(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value !== "number" && !(typeof value === "string" && value.trim())) continue;
    const n = Number(value);
    if (Number.isInteger(n) && n >= -840 && n <= 840) return n;
  }
  return null;
}
function guanianContextTimezone(context: Record<string, unknown>, at: number): number | null {
  const day = context.day as { tz?: unknown } | undefined;
  const kit = context.genKit as { tz?: unknown } | undefined;
  const explicit = guanianTimezone(day?.tz, kit?.tz, context.tzOffsetMin);
  if (explicit !== null) return explicit;
  // Old gateways defaulted missing userSleepTz to zero. Only the actual IANA
  // zone is trustworthy in such a legacy row; never use that defaulted zero.
  if (typeof context.userSleepTimeZone === "string" && context.userSleepTimeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: context.userSleepTimeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
      const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
      return guanianTimezone((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - Math.floor(at / 60000) * 60000) / 60000);
    } catch { /* Invalid zone: require a new phone snapshot. */ }
  }
  return null;
}
async function readGuanianCloudHistory(
  rest: (path: string, init?: RequestInit) => Promise<Response>, userId: string, sessionId: string,
  window?: GuanianHistoryWindow,
): Promise<GuanianCloudHistory> {
  if (!sessionId) throw new Error("缺少聊天会话，不能核对云端消息");
  const scope = `user_id=eq.${encodeURIComponent(userId)}&session_id=eq.${encodeURIComponent(sessionId)}`;
  const responses = await Promise.all([
    rest(`push_chat_mirror?${scope}&select=id,role,content,message_at,response_batch_id,media_type&or=(media_type.is.null,and(media_type.neq.response_batch,media_type.neq.offline_summary))&order=message_at.desc,id.desc&limit=200`),
    rest(`push_outbox?${scope}&meta->>pushGenerated=eq.true&select=id,trigger_key,raw_text,created_at,consumed_at,meta&order=created_at.desc&limit=200`),
  ]);
  if (responses.some(r => !r.ok)) throw new Error("云端聊天读取失败，请检查 schema 11 与云函数部署；稍后重试");
  const [mirrors, outputs] = await Promise.all(responses.map(r => r.json())) as [GuanianCloudMessage[], GuanianCloudOutput[]];
  if (!Array.isArray(mirrors) || !Array.isArray(outputs)) throw new Error("云端聊天数据格式错误");
  if (guanianHasWindow(window)) {
    // Fetch enough complete online rounds; summary traffic cannot displace them.
    let pageSize = mirrors.length;
    while (pageSize === 200 && guanianOnlineRounds(mirrors).length <= guanianRoundLimit(window?.onlineRounds)) {
      if (mirrors.length >= 5000) throw new Error("最近对话气泡过多，请减少线上回看轮数");
      const response = await rest(`push_chat_mirror?${scope}&select=id,role,content,message_at,response_batch_id,media_type&or=(media_type.is.null,and(media_type.neq.response_batch,media_type.neq.offline_summary))&order=message_at.desc,id.desc&limit=200&offset=${mirrors.length}`);
      if (!response.ok) throw new Error("线上历史分页读取失败");
      const page = await response.json() as GuanianCloudMessage[];
      if (!Array.isArray(page)) throw new Error("线上历史分页格式错误");
      mirrors.push(...page); pageSize = page.length;
    }
    const response = await rest(`push_chat_mirror?${scope}&media_type=eq.offline_summary&select=id,role,content,message_at,media_type&order=message_at.desc,id.desc&limit=${guanianRoundLimit(window?.offlineRounds)}`);
    if (!response.ok) throw new Error("线下摘要读取失败");
    const summaries = await response.json() as GuanianCloudMessage[];
    if (!Array.isArray(summaries)) throw new Error("线下摘要格式错误");
    mirrors.push(...summaries);
  }
  const records = new Map<string, GuanianCloudMessage>();
  const cloudIds = new Set(outputs.map(o => `push-outbox:${o.id}`));
  const snapshots = new Map<string, GuanianCloudMessage[]>();
  // Fetch snapshots by batch, independently of the recent 200-bubble window.
  // Each row is an atomic full replacement; an empty list is a deletion.
  const batchIds = [...cloudIds];
  for (let start = 0; start < batchIds.length; start += 50) {
    const ids = batchIds.slice(start, start + 50).map(id => JSON.stringify(id)).join(",");
    const response = await rest(`push_chat_mirror?${scope}&media_type=eq.response_batch&response_batch_id=in.(${encodeURIComponent(ids)})&select=id,content,response_batch_id,media_type&limit=50`);
    if (!response.ok) throw new Error("整轮聊天镜像读取失败，保留任务等待重试");
    for (const row of await response.json() as GuanianCloudMessage[]) {
      if (row.media_type !== "response_batch" || !row.response_batch_id || !cloudIds.has(row.response_batch_id)) continue;
      const value = JSON.parse(row.content) as { v?: number; messages?: GuanianCloudMessage[] };
      if (value.v !== 1 || !Array.isArray(value.messages) || value.messages.some(m =>
        typeof m.id !== "string" || typeof m.content !== "string" || !Number.isFinite(Date.parse(m.message_at)))) {
        throw new Error("整轮聊天镜像格式异常，请重新同步镜像");
      }
      snapshots.set(row.response_batch_id, value.messages);
    }
  }
  for (const m of mirrors) {
    if (!m || !["user", "assistant"].includes(m.role) || !Number.isFinite(Date.parse(m.message_at))) continue;
    if (m.media_type === "response_batch") continue;
    // A single mirrored bubble never proves a full response. Use the atomic
    // batch snapshot when available, otherwise retain the original whole reply.
    if (m.response_batch_id && cloudIds.has(m.response_batch_id)) continue;
    records.set(`mirror:${m.id}`, m);
  }
  // Pre-batch hosts stamped imported bubbles with consumption time. Match only a
  // complete, unique consecutive sequence at that receipt time; never dedupe by
  // an isolated phrase or by the latest mirror timestamp.
  const compact = (s: string) => s.replace(/\s+/g, "").trim();
  const legacy = mirrors.filter(m => records.has(`mirror:${m.id}`) && !m.response_batch_id && m.media_type !== "offline_summary")
    .sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id));
  const candidates = new Map<string, { groups: GuanianCloudMessage[][]; output: GuanianCloudOutput }>();
  for (const o of outputs) {
    const receivedAt = Date.parse(o.consumed_at || "");
    if (!Number.isFinite(receivedAt)) continue;
    const raw = String(o.raw_text || "");
    const forms = new Set([compact(raw), compact(raw.split(/\[(?:内心|心声)\]/)[0])].filter(Boolean));
    const matches: GuanianCloudMessage[][] = [];
    for (let start = 0; start < legacy.length; start++) {
      const group: GuanianCloudMessage[] = []; let text = "";
      for (const m of legacy.slice(start, start + 40)) {
        if (m.role !== "assistant" || !records.has(`mirror:${m.id}`) || Math.abs(Date.parse(m.message_at) - receivedAt) > 120_000) break;
        group.push(m); text += compact(m.content);
        if (forms.has(text)) matches.push([...group]);
        if (![...forms].some(f => f.startsWith(text))) break;
      }
    }
    candidates.set(o.id, { groups: matches, output: o });
  }
  // Resolve across ALL outputs before removing anything. Two identical outputs
  // may otherwise both claim the same mirror sequence in iteration order.
  const owners = new Map<string, Set<string>>();
  for (const [id, candidate] of candidates) for (const group of candidate.groups) for (const m of group) {
    if (!owners.has(m.id)) owners.set(m.id, new Set());
    owners.get(m.id)!.add(id);
  }
  const uncertainLegacy: NonNullable<GuanianCloudHistory["uncertainLegacy"]> = [];
  for (const candidate of candidates.values()) {
    if (candidate.groups.length === 1 && candidate.groups[0].every(m => owners.get(m.id)?.size === 1)) {
      for (const m of candidate.groups[0]) records.delete(`mirror:${m.id}`);
    }
  }
  for (const m of legacy) {
    if (m.role !== "assistant" || !records.has(`mirror:${m.id}`)) continue;
    const exact = [...(owners.get(m.id) || [])];
    // Receipt-time proximity is not identity. Unrelated old-format utterances
    // stay in the factual history and can open the promise-update gate.
    const possible = exact;
    if (!possible.length) continue;
    // Insufficient old metadata cannot establish a separate utterance. Keep
    // the evidence in an explicitly uncertain appendix, never as a fresh turn
    // or as evidence for automatic unanswered-round cancellation.
    uncertainLegacy.push({ message: m, outputIds: possible, exactText: exact.length > 0 });
    records.delete(`mirror:${m.id}`);
  }
  let lastGeneratedAt = 0;
  for (const o of outputs) {
    const at = Date.parse(o.created_at);
    if (!Number.isFinite(at)) continue;
    lastGeneratedAt = Math.max(lastGeneratedAt, at);
    const id = `push-outbox:${o.id}`;
    const snapshot = snapshots.get(id);
    if (snapshot && !snapshot.length) continue; // Explicit whole-batch deletion.
    records.set(id, { id, role: "assistant", content: snapshot
      ? snapshot.map(m => m.content).join("\n") : String(o.raw_text || ""), message_at: o.created_at });
  }
  return { messages: [...records.values()].sort((a, b) => Date.parse(a.message_at) - Date.parse(b.message_at) || a.id.localeCompare(b.id)), outputs, lastGeneratedAt, uncertainLegacy };
}
function guanianHistoryText(history: GuanianCloudHistory, tz: number, limit = 80, window?: GuanianHistoryWindow): string {
  const selected = guanianHasWindow(window) ? selectGuanianHistory(history.messages, window!) : history.messages.filter(m => m.media_type !== "offline_summary").slice(-limit);
  const main = selected.map(m => {
    const local = new Date(Date.parse(m.message_at) + tz * 60_000).toISOString().slice(0, 16).replace("T", " ");
    return `[${m.id}] ${local} ${m.media_type === "offline_summary" ? "线下摘要（概述双方互动，非角色原话）" : m.role === "user" ? "用户" : "你"}：${m.content.slice(0, m.media_type === "offline_summary" ? 500 : 4000)}`;
  }).join("\n");
  const uncertain = (history.uncertainLegacy || []).slice(-20);
  if (!uncertain.length) return main;
  return main + "\n[旧镜像待核对资料：可能是补收副本，不能当作新发言、新承诺或新增未回应轮次；不推断用户已读。原始记录未删除。]\n"
    + uncertain.map(({ message: m, outputIds, exactText }) => `[mirror:${m.id}] 记录时间 ${m.message_at}；可能对应 ${outputIds.map(id => "push-outbox:" + id).join(",")}；`
      + (exactText ? "正文已见对应云端输出，不重复列出。" : "待核对原文：" + m.content.slice(0, 4000))).join("\n");
}
function guanianHistoryRounds(history: GuanianCloudHistory, nowMs: number): number {
  let rounds = 0, last = Infinity;
  for (const m of [...history.messages].filter(m => m.media_type !== "offline_summary").reverse()) {
    if (m.role === "user") break;
    const at = Date.parse(m.message_at);
    if (last - at > 3 * 60_000 && nowMs - at >= 30 * 60_000) rounds++;
    last = at;
  }
  return rounds;
}

/** Explicit timed wakes drive proactive spacing; passive replies never consume it. */
function guanianLastProactiveAt(history: GuanianCloudHistory): number {
  return history.outputs.reduce((at, o) => {
    if (!o.trigger_key?.startsWith("timedwake:")) return at;
    const event = o.meta?.guanianPromise as { id?: string } | undefined;
    const context = o.meta?.guanianContext as { revision?: number | null } | undefined;
    if (event?.id || context?.revision) return at;
    return Math.max(at, Date.parse(o.created_at) || 0);
  }, 0);
}
// END GUANIAN CLOUD HISTORY

// BEGIN GUANIAN PROMISES
// Pure event rules, shared by the app and self-contained cloud workers.
function promiseSubject(value) {
  return ["user", "character", "both"].includes(value) ? value : "user";
}
function promiseSubjectLabel(value) {
  return { user: "用户", character: "角色", both: "双方" }[promiseSubject(value)];
}
function promiseAgreementRule() {
  return "标注为线下摘要的记录是双方互动的概述，不是角色原话；可引用摘要编号核对约定，但必须区分摘要中用户的明确同意或拒绝与角色的要求。不能因为摘要由模型生成，就把其全部内容归为角色承诺。用户自己的事情以用户最新明确意愿为准。角色的要求、劝说、坚持、替用户安排时间不等于用户答应，不能建立或恢复 user/both 约定，也不能改记为角色的跟进承诺来继续催。用户明确拒绝或取消时，已有同一件事必须通过 keep 的 id + status=cancelled 更新，不能只在 why 里写取消而仍保留 pending；没有已有事件则不创建。只有用户后来明确重新同意才能恢复，沉默不是同意。sourceMessageId 必须引用下方真实聊天编号：用户或双方约定的成立、改期、恢复要引用用户本人同意的消息；角色自己的承诺要引用角色本人消息；取消引用明确取消的消息。取消优先于同轮旧的同意或角色坚持，相关普通跟进时刻也应取消，不再为同一件事加 extra。";
}
// A cheap wake-up hint, not a parser: the model still checks whether a promise exists.
function hasPromiseUpdate(messages, threads) {
  return messages.some(m => {
    const text = String(m.content || m.c || "");
    // Only opens semantic review; never cancels a possibly unrelated event by keyword.
    if (m.role === "user" && threads.some(t => t.kind === "promise" && !t.done)
      && /取消|算了|不(?:再|想|用|做|去|需要)|别(?:再|提醒|催|提)/.test(text)) return true;
    return /(?:\d{1,2}[:：]\d{2}|[一二三四五六七八九十两\d]{1,3}[点时]|明天|后天|周[一二三四五六日天])/.test(text)
      && /回|到|约|等|一起|见|答应|记得|提醒|陪|去|再说|联系|找你/.test(text)
      || threads.some(t => t.kind === "promise" && !t.done && text.includes(String(t.text || ""))
        && /改|不去|不回|取消|算了|完成|好了|到了|办完/.test(text));
  });
}
// New assistant messages may update promises, but cannot open the ordinary impulse gate.
function recheckEvidence(messages, threads, since) {
  const fresh = messages.filter(m => Number(m.t ?? Date.parse(m.message_at || "")) > since);
  const users = fresh.filter(m => m.role === "user");
  const summaries = fresh.filter(m => m.media_type === "offline_summary");
  const updates = [...users, ...summaries];
  const promiseUpdate = hasPromiseUpdate(fresh, threads) || summaries.length > 0;
  return { fresh, users, updates, promiseUpdate, ledgerOnly: updates.length === 0 && promiseUpdate };
}
function ordinaryQuota(items) {
  return items.filter(w => w.kind !== "promise" && w.act).length;
}
function updatePromiseThreads(threads, changes, nowMs, by, messages = null) {
  const list = threads.map(t => ({ ...t }));
  for (const k of changes) {
    const id = String(k.id || "").replace(/[\[\]\s]/g, "");
    const text = String(k.text || "").trim().slice(0, 60);
    const subject = promiseSubject(k.subject);
    const old = id ? list.find(t => t.id === id && t.kind === "promise")
      : list.find(t => t.kind === "promise" && promiseSubject(t.subject) === subject && t.text === text);
    // Explicit unknown IDs cannot silently create a second event.
    if (id && !old) continue;
    // Model-produced changes need real speaker evidence. Manual edits use their own UI path.
    if (Array.isArray(messages)) {
      const source = messages.find(m => String(m.id || "") === String(k.sourceMessageId || "") && m.id);
      if (!source) continue;
      const closing = k.status === "completed" || k.status === "cancelled";
      const owner = old ? promiseSubject(old.subject) : subject;
      const nextOwner = k.subject ? subject : owner;
      const summaryEvidence = source.media_type === "offline_summary";
      if (!closing && (owner !== "character" || nextOwner !== "character") && source.role !== "user" && !summaryEvidence) continue;
      if (!closing && owner === "character" && nextOwner === "character" && source.role !== "assistant" && !summaryEvidence) continue;
      if (closing && owner !== "character" && source.role !== "user" && !summaryEvidence) continue;
      // A previously closed event cannot be revived from the same old agreement.
      const sourceAt = Number(source.t ?? Date.parse(source.message_at || ""));
      if (!closing && old?.done && !(sourceAt > Number(old.at || 0))) continue;
    }
    if (k.status === "completed" || k.status === "cancelled") {
      if (old) Object.assign(old, { status: k.status, done: true, at: nowMs, by });
      continue;
    }
    const due = Number(k.due) || Number(old?.due);
    if (!(due > 0) || (!text && !old)) continue;
    if (old) {
      const changed = due !== old.due || (k.subject && subject !== promiseSubject(old.subject)) || old.done;
      Object.assign(old, { text: text || old.text, due, subject: k.subject ? subject : promiseSubject(old.subject),
        sourceMessageId: String(k.sourceMessageId || old.sourceMessageId || "").slice(0, 100),
        status: changed ? "pending" : (old.status || "pending"), done: false, at: nowMs, by,
        revision: (Number(old.revision) || 1) + (changed ? 1 : 0),
        ...(changed ? { nudge: "", mentionedAt: 0 } : {}) });
    } else {
      // Stable within a judgment; no implicit clock or random state.
      let n = list.length;
      let newId;
      do { newId = "p" + nowMs.toString(36) + (n++).toString(36); } while (list.some(t => t.id === newId));
      list.push({ id: newId, kind: "promise", text, due, subject, revision: 1, status: "pending", done: false,
        sourceMessageId: String(k.sourceMessageId || "").slice(0, 100), since: nowMs, at: nowMs, by,
        why: String(k.why || "").slice(0, 40) });
    }
  }
  return list;
}
function promiseNeedsTask(t, items, nowMs, endMs) {
  return t.kind === "promise" && !t.done && t.status !== "completed" && t.status !== "cancelled"
    && !(Number(t.mentionedAt) > 0) && !/said:/.test(String(t.nudge || ""))
    && Number(t.due) > nowMs - 86400000 && Number(t.due) < endMs
    && !items.some(w => w.from === t.id && w.kind === "promise" && w.act
      && Number(w.promiseRevision || 1) === Number(t.revision || 1));
}
function promiseIntent(t, localDue) {
  return `核对约定 [${t.id}]：${promiseSubjectLabel(t.subject)}约好在 ${localDue} ${t.text}。`
    + "这是明确约定，到点核对最新时间、双方对话和当前行程。角色自己的承诺应交代进展；用户的事情只能询问，不能替用户宣称完成。"
    + "时间到了不等于事情已完成；有事实支持才能说到了或做完了，延误就按现在的情况说明，不能照搬旧时间。已改期、取消、完成且交代过则作罢。";
}
// END GUANIAN PROMISES
