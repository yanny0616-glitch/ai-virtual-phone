// 起念的分量、回音账、朋友圈节奏、判断提示词与解析。文案和数值从 push-recheck 原样搬来。

import { matterPrompt } from "./vendor/matters.mjs";
import { forkDay, guanianNow } from "./life.ts";
import { THREAD_TASK, threadsEnabled } from "./threads.ts";
import type { Ctx, Decision, Extra, FbBook, Keep, Outbox, PlanItem } from "./types.ts";
import type { CloudOutput } from "./history.ts";

// 门禁默认值，可被设置里的同名字段覆盖
export const GATE_DEF = {
  gateDailyCap: 8,
  gateGapMin: 25,
  gateHorizonMin: 240,
  gateFreshMin: 10,
  gateMinMsgs: 1,
  selfImpulseCap: 0,
};
// 还有不到 2 分钟就到点的时刻不再改动
export const LEAD_MS = 2 * 60_000;

export function gate(ctx: Ctx, key: keyof typeof GATE_DEF): number {
  const value = Number(ctx[key]);
  return Number.isFinite(value) && value >= 0 ? value : GATE_DEF[key];
}

export function cnum(ctx: Ctx, key: string, def: number): number {
  const v = Number(ctx[key]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

export const SELF_KIND: Record<string, string> = { thread: "惦记", done: "刚忙完", miss: "想念", echo: "余韵", quiet: "安静太久", fork: "碰上事" };

export function affectionLine(aff: Ctx["affection"]): string {
  if (!aff || (!aff.tier && !aff.relation)) return "";
  return `你对用户：${aff.tier || "说不上"}；两人现在的关系：${aff.relation || "没定"}。想不想找TA、找了说什么，都按这个分寸来。`;
}

// 沉默无法证明不喜欢：不把未接话次数交给模型当负反馈
export function fbLine(fb: FbBook | undefined, kind: string): string {
  const rec = fb && Array.isArray(fb[kind]) ? fb[kind] : [0, 0];
  const replied = Math.max(0, Math.min(Number(rec[0]) || 0, Number(rec[1]) || 0));
  if (replied < 3) return "没有足够的接话记录可判断偏好；用户可能在忙、睡觉或没有看到消息，未回复不代表不喜欢，不要因此责怪或催促。";
  return `这类由头之后记录到用户接话 ${replied} 次，可作为轻微的正向参考，不代表每次都想聊。未回复不作为负面偏好，不据此判断用户冷淡或不喜欢，也不要催回复。`;
}

export function selfBrief(kind: string, reason: string): string {
  if (kind === "miss") return `没有新对话。${reason}，最后一句是用户说的，不是你发了没人回。按你的性子和现在的关系想一想会不会有点想TA——本来就不主动的人、关系还生疏的，就不发。要发也只轻轻带一句想念或近况，不问「怎么不理我」，不催TA回。`;
  if (kind === "echo") return `没有新对话。由头是${reason}——从昨天的对话里挑一件轻松的小事（吃的、看的、随口说过的），像忽然想起来那样顺手提一句，不要求TA回应；昨天的事已经过去或已经说清楚了就别提，别翻旧账、别追问结果。`;
  if (kind === "thread") return `没有新对话。由头是心里挂着的事：${reason}。像朋友随口问起，不像提醒或查岗；上面聊到的事已经了了就写 []。`;
  return `没有新对话。由头是你自己这边的事：${reason}。想一想此刻的你会不会想找用户说点什么——分享刚发生的、忽然想起TA、单纯想搭句话都行；上面聊到的事已经了了就写 []。`;
}

// 由头的分量：三分值（要紧 / 温度 / 急迫）合成 0–1，再乘时间曲线和接话正反馈
const KIND_VAL: Record<string, [number, number, number]> = {
  thread: [0.7, 0.6, 0.7], done: [0.6, 0.5, 0.4], miss: [0.6, 0.9, 0.3], echo: [0.4, 0.7, 0.2],
  quiet: [0.3, 0.5, 0.2], extra: [0.7, 0.6, 0.6], plan: [0.5, 0.5, 0.4], fork: [0.8, 0.7, 0.8],
};

// 只用正反馈：至少 3 次接话后轻微加权，最多 1.2 倍
export function fbMod(fb: FbBook | undefined, kind: string): number {
  const rec = fb && Array.isArray(fb[kind]) ? fb[kind] : [0, 0];
  const replied = Math.max(0, Math.min(Number(rec[0]) || 0, Number(rec[1]) || 0));
  return replied < 3 ? 1 : 1 + Math.min(0.2, (replied - 2) * 0.04);
}

export function impulseValue(kind: string, curve: number, fb: FbBook | undefined): number {
  const [sal, warm, urg] = KIND_VAL[kind] || KIND_VAL.quiet;
  return Math.max(0, Math.min(1, (sal + urg * 0.9 + warm * 0.7) / 2.6 * Math.max(0, Math.min(1, curve)) * fbMod(fb, kind)));
}

// 额度快用完时只让分量够的由头过：剩 2 个要 0.45，剩 1 个要 0.65
export function valueFloor(remaining: number): number {
  return remaining <= 1 ? 0.65 : remaining === 2 ? 0.45 : 0;
}

// 发出后累积 3 小时非睡眠时间的回音窗口；未满返回 null。用户睡眠窗可选
export function feedbackWindowEnd(sentAt: number, ctx: Ctx, nowMs: number): number | null {
  const duration = 3 * 3600_000;
  const regularEnd = sentAt + duration;
  if (regularEnd > nowMs) return null;
  if (Number(ctx.userSleepOn) !== 1) return regularEnd;
  const parse = (value: unknown): number | null => {
    const m = /^(?:([01]\d|2[0-3])):([0-5]\d)$/.exec(String(value || ""));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = parse(ctx.userSleepStart), end = parse(ctx.userSleepEnd);
  if (start === null || end === null || start === end) return regularEnd;
  let format: Intl.DateTimeFormat | null = null;
  try {
    if (ctx.userSleepTimeZone) format = new Intl.DateTimeFormat("en-GB", { timeZone: ctx.userSleepTimeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch { /* 无效时区用偏移 */ }
  const offset = Math.max(-840, Math.min(840, Number(ctx.userSleepTz ?? ctx.tzOffsetMin) || 0));
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

// ─── 生活轮：TA自己想不想发朋友圈，不调模型。每小时掷一次
const MO_HOUR_W = [0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.6, 0.6, 0.6, 0.9, 0.9, 0.6, 0.6, 0.6, 0.7, 1.0, 1.2, 1.3, 1.3, 1.2, 0.8];
const MO_W_SUM = MO_HOUR_W.reduce((a, b) => a + b, 0);

function momentsWeekStart(nowMs: number, tzMin: number): number {
  const local = new Date(nowMs + tzMin * 60_000);
  const dow = (local.getUTCDay() + 6) % 7;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow) - tzMin * 60_000;
}

export function momentsBudget(ctx: Ctx, nowMs: number, tzMin: number): { weekStart: number; weekN: number; ok: boolean } {
  const weekStart = momentsWeekStart(nowMs, tzMin);
  const weekN = Number(ctx.momentsWeekStart) === weekStart ? Number(ctx.momentsWeekN) || 0 : 0;
  const ok = Number(ctx.momentsOn) === 1
    && weekN < Math.max(0, Number(ctx.momentsWeekly ?? 3))
    && nowMs - (Number(ctx.momentsLast) || 0) >= Math.max(0, Number(ctx.momentsGapH ?? 6)) * 3600_000;
  return { weekStart, weekN, ok };
}

export function lifeRoll(ctx: Ctx, nowMs: number, random: () => number): { patch: Partial<Ctx>; post: Outbox | null; note: string } | null {
  const day = ctx.day && typeof ctx.day === "object" ? forkDay(ctx.day, nowMs, ctx.affection) : null;
  if (Number(ctx.momentsOn) !== 1 || !day) return null;
  const tz = Number(day.tz) || 0;
  const hourKey = Math.floor((nowMs + tz * 60_000) / 3600_000);
  if (Number(ctx.momentsRollHour) === hourKey) return null;
  const budget = momentsBudget(ctx, nowMs, tz);
  const patch: Partial<Ctx> = { momentsRollHour: hourKey, momentsWeekStart: budget.weekStart, momentsWeekN: budget.weekN };
  if (!budget.ok) return { patch, post: null, note: "本周条数或间隔不够" };
  const now = guanianNow(day, nowMs, ctx.quietStart, ctx.quietEnd);
  if (now.asleep) return { patch, post: null, note: "睡着" };
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
  const p = Math.min(0.9, (Number(ctx.momentsWeekly ?? 3) / 7) * (slotW / MO_W_SUM) * boost);
  const r = random();
  const note = `${local.getUTCHours()}点 p=${p.toFixed(3)} roll=${r.toFixed(3)}`;
  if (r >= p) return { patch, post: null, note };
  const post: Outbox = { id: "mo" + nowMs.toString(36), at: nowMs, hint: ("可以顺着这些来，不用全提：" + hints.join("；")).slice(0, 120), by: "server" };
  patch.momentsLast = nowMs;
  patch.momentsWeekN = budget.weekN + 1;
  patch.outbox = [...(Array.isArray(ctx.outbox) ? ctx.outbox : []).slice(-4), post];
  return { patch, post, note };
}

// ─── 判断提示词
export type PromptInput = {
  ctx: Ctx; nowMs: number; tz: number; characterName: string; items: PlanItem[]; outputs: CloudOutput[];
  pending: PlanItem[]; litCount: number; chatLines: string; threadLinesNow: string[];
  echoLines: string; ledgerOnly: boolean; judge: boolean; canJudge: boolean; canImpulse: boolean; canPost: boolean;
  selfKind: string; selfReason: string; momentsWeekN: number; hm: string;
};

export function buildJudgePrompt(p: PromptInput): string {
  const { ctx } = p;
  const threadsOn = threadsEnabled(ctx);
  const day = ctx.day ? forkDay(ctx.day, p.nowMs, ctx.affection) : null;
  const now = day ? guanianNow(day, p.nowMs, ctx.quietStart, ctx.quietEnd) : null;
  const stateLine = now
    ? `此刻的状态：${now.asleep ? "在睡觉" : "在" + (now.doing || "没什么特别的")}${now.step ? "（" + now.step + "）" : ""}，情绪「${now.mood}」，精力 ${now.energy}%${now.next ? "，接下来 " + now.next : ""}。`
    : "";
  const planLines = p.pending
    .map(item => `- ${item.time}｜${item.source}｜${item.act ? "已点亮" : "未点亮"}｜意图：${item.intent || "（无）"}｜理由：${item.why || "（无）"}`)
    .join("\n");
  const selfReason = p.selfReason;
  return [
    matterPrompt(p.items, ctx.threads || [], p.outputs),
    p.ledgerOnly ? "本轮仅核对角色的新承诺，只有 keep/settle 可非空，decisions/extra/post 必须为空。" : "",
    `你现在是「${p.characterName}」，在盘算今天剩下的时间要不要主动联系用户。现在是本地时间 ${p.hm}。`,
    ctx.bias ? `你的性格倾向：${ctx.bias}` : "",
    stateLine,
    affectionLine(ctx.affection),
    `规矩：今天最多主动 ${ctx.quota ?? 3} 次（已点亮 ${p.litCount} 次）；`
    + `${ctx.quietStart || "23:00"}–${ctx.quietEnd || "07:00"} 不打扰；两次之间至少隔 ${ctx.minGapMin ?? 90} 分钟。`,
    "",
    selfReason ? "最近和用户的对话（这之后没有新消息）：" : "刚刚和用户的对话：",
    p.chatLines || "（这段时间没有对话记录）",
    "",
    p.echoLines ? "昨天的对话：\n" + p.echoLines + "\n" : "",
    p.judge ? "今天剩下的计划时刻：" : (selfReason ? "" : "今天排好的时刻都已经过点了，没有要重判的。"),
    p.judge ? planLines : "",
    "",
    threadsOn && p.threadLinesNow.length ? "惦记账本（已了结项仅供判重）：\n" + p.threadLinesNow.join("\n") : "",
    selfReason
      ? selfBrief(p.selfKind, selfReason) + fbLine(ctx.fb, p.selfKind) + "不想说就老实写 []，不要为了发而发。真要发的话时刻定在接下来 5 到 40 分钟之间。已经说过或已经解决的事不要重复起念。"
      : p.canJudge
      ? "根据刚才聊过的内容重新判断每个时刻：聊过的话题已经了了就别再提，"
        + "用户说了忙/情绪不好就收敛，聊到一半没说完或约好了要说的事可以点亮"
        + (p.canImpulse ? "甚至新加一个时刻。" : "。")
      : "只看刚才聊的内容里有没有值得临时起一个新念头的事：聊到一半没说完的话头、"
        + "约好了要说的、答应了要问的。只是随口聊到、没落实的事不算。",
    "只输出 JSON，不要任何解释：",
    '{"links":[{"itemId":"已有念头编号","matterId":"归属的已有事项编号","relation":"same或followup","sourceMessageId":"新进展消息编号，无则空"}],'
    + (p.judge
      ? '"decisions":[{"time":"HH:MM","act":true,"sem":"关心|分享|约定|闲聊","topic":"一句话主题","why":"你为什么这么定","intent":"到点时你想说的事，一句话","defer":"只是这个点不合适、话还想说时填今天更晚的HH:MM，否则空字符串"}]'
      : '"decisions":[]')
    + ","
    + (p.canImpulse
      ? '"extra":[{"matterId":"已有编号或new:1","relation":"new或same或followup","sourceMessageId":"新进展消息编号，无则空","time":"HH:MM","about":"这个念头的由头（8字内）","intent":"想说的事","why":"为什么现在加","from":"出自账本里某件事就填它的 id，否则空字符串"}]'
      : '"extra":[]')
    + (threadsOn && !selfReason
      ? ',"keep":[{"matterId":"已有编号或new:1","id":"已有事件的id，新事件留空","subject":"user|character|both","status":"pending|completed|cancelled","sourceMessageId":"证据消息编号","kind":"topic或promise或date","text":"一句话（20字内）","when":"promise/date 必填：YYYY-MM-DD HH:MM、HH:MM 或 MM-DD；topic 留空","why":"为什么记它（15字内）"}],"settle":["已了结的账本 id"]'
      : "")
    + (!selfReason && !p.ledgerOnly && day ? ',"feel":{"mood":"聊天带来的此刻情绪，8字内","cause":"依据，12字内","energy":0,"intensity":50,"hours":3},"sched":[{"op":"add或move或drop","time":"原时刻HH:MM","newTime":"目标HH:MM","title":"新增标题","note":"细节","mood":"做完情绪","cost":0,"why":"聊天依据"}]' : "")
    + (p.canPost ? ',"post":{"hint":"想发的朋友圈由头或大意（30字内）"}或null' : "")
    + "}",
    threadsOn && !selfReason ? THREAD_TASK : "",
    !selfReason && !p.ledgerOnly && day ? "feel 只描述聊天带来的变化，不改今天的底色；平淡聊天降低 intensity，没有变化给 null。energy 为 -20 到 20，intensity 为 0 到 100，hours 为 1 到 12。" : "",
    !selfReason && !p.ledgerOnly && day ? (ctx.chatEditsDay !== false
      ? "sched 只按最新聊天里已明确说定或取消的安排改今天未来的日程，最多2条；过去或正在进行的不改。共同安排须用户明确同意，不把角色单方面要求当约定。没有依据给空数组。未来日程：" + JSON.stringify((day.schedule || []).filter(s => String(s.time) > p.hm))
      : "用户关闭了聊天改日程，sched 必须为空数组；feel 仍可更新。") : "",

    p.judge ? "decisions 只写你要改的时刻（其余的保持原样就不用写）。" : "decisions 一律写 []。",
    p.judge ? `改约：act 写 false 时，如果只是这个时刻不合适（刚聊完太密、这话晚点说更合适、这会儿说了会打断对方），而话本身还想说，就在 defer 里填今天更晚的 HH:MM，整个念头挪过去、不占新额度；真的不想说了才把 defer 留空。到点正忙或在睡觉不用你操心，系统会自动顺延，别为这个改约。没有固定时间截止；等待会让发送概率逐渐降低。是否已说过或已失去意义，按最新聊天和事实判断。` : "",
    p.canImpulse ? "extra 最多 1 条，没有就写 []。" : "今日额度已满，extra 一律写 []。",
    p.canImpulse && threadsOn
      ? "明确约定一律进 keep，系统按约定时间预约。普通话头才按以下两条路选择：今天之内说得掉的走 extra 排个时刻；今天说不掉的（要等结果、要到某个日子、隔几天再问才自然）走 keep 记进账本，以后自己会想起来。extra 出自账本里已有的某件事时 from 填那条的 id，发出去之后系统会自动把账本那条了结或标成提过了，不用再写进 settle。"
      : "",
    p.canPost
      ? `post：如果此刻更想发一条朋友圈而不是私聊（晒一下刚做的事、随手记一句、发个感慨——给所有人看的，不是说给用户听的），就在 post.hint 里写想发的由头或大意（30字内），由系统按你的人设成文。这周已发 ${p.momentsWeekN} 条。私聊和发圈可以只要一个，也可以都不要；不想发就写 null。`
      : "",
  ].filter(Boolean).join("\n");
}

export type Judged = { links: Record<string, unknown>[]; decisions: Decision[]; extra: Extra[]; keep: Keep[]; settle: string[]; post: string; feel: unknown; sched: unknown[] };

export function parseJudgeJson(text: string): Judged {
  const empty: Judged = { links: [], decisions: [], extra: [], keep: [], settle: [], post: "", feel: null, sched: [] };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const post = parsed.post && typeof parsed.post === "object" ? (parsed.post as { hint?: unknown }).hint : null;
    return {
      feel: parsed.feel ?? null, sched: Array.isArray(parsed.sched) ? parsed.sched.slice(0, 2) : [],
      links: Array.isArray(parsed.links) ? parsed.links.slice(0, 40) : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 12) : [],
      extra: Array.isArray(parsed.extra) ? parsed.extra.slice(0, 1) : [],
      keep: Array.isArray(parsed.keep) ? parsed.keep.slice(0, 2) : [],
      settle: Array.isArray(parsed.settle) ? parsed.settle.slice(0, 6).map(x => String(x)) : [],
      post: typeof post === "string" ? post.trim().slice(0, 120) : "",
    };
  } catch {
    return empty;
  }
}
