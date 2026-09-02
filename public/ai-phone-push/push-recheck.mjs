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

type PlanItem = {
  time: string;
  fireAt: number;
  source: string;
  act: boolean;
  intent: string;
  why: string;
  sem: string;
  topic: string;
  wakeId: string;
};
type PlanContext = {
  mood?: string;
  energy?: string;
  quota?: number;
  quietStart?: string;
  quietEnd?: string;
  minGapMin?: number;
  maxUnanswered?: number;
  chatCandidates?: string;
  bias?: string;
  wakePrefix?: string;
  gateDailyCap?: number;
  gateGapMin?: number;
  gateHorizonMin?: number;
  gateFreshMin?: number;
  gateMinMsgs?: number;
  selfImpulseCap?: number;
  selfUsed?: number;
  /** 聊天插件「好感与关系」算出来的分寸，App 编排时寄来；没装插件就没有 */
  affection?: { score?: number; tier?: string; relation?: string } | null;
  day?: GuanianDay;
  [key: string]: unknown;
};
// 挂念寄存的当天原料：日程带 cost/情绪，conds 是还在起作用的聊天情绪。算法与挂念 index.html
// 的 energyAt / moodNow 一致，改一处要同步另一处（push-generate 里也有一份）。
type GuanianSched = { time?: string; end?: string; title?: string; cost?: number; mood?: string; steps?: { time?: string; what?: string }[] };
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
  // 与面板 energyAt 同步：cost 按进度记账、状况负向合计封顶 -25、缓降从起床时刻起算
  for (const it of sched) {
    if (h >= 5 && String(it.time) > hm) continue;
    const a = hmNum(it.time), b = hmNum(it.end);
    const prog = a != null && b != null && b > a ? Math.max(0, Math.min(1, (h - a) / (b - a))) : 1;
    energy += (Number(it.cost) || 0) * prog;
  }
  let cd = 0;
  for (const x of conds) cd += (Number(x.c.energyDelta) || 0) * x.w;
  energy += Math.max(-25, cd);
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
  session_id: string;
  context: PlanContext;
  items: PlanItem[];
  decisions: unknown[];
  last_recheck_at: string | null;
  recheck_count: number;
  updated_at: string | null;
};

type Decision = { time?: string; act?: boolean; sem?: string; topic?: string; why?: string; intent?: string };
type Extra = { time?: string; about?: string; intent?: string; why?: string };

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
const SELF_SILENCE_MS = 3 * 3600_000;
// 还有不到 2 分钟就到点的时刻不再改动，免得和 push-generate 抢同一条预约。
const LEAD_MS = 2 * 60_000;

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

/** 裁决只要一段 JSON：借快照的 url/headers/model，但不重放整份角色提示词。 */
function buildJudgeBody(template: JobPayload["request"], prompt: string): Record<string, unknown> {
  const model = template.body.model;
  if (template.providerKind === "anthropic") {
    return { model, max_tokens: 900, messages: [{ role: "user", content: prompt }] };
  }
  if (template.providerKind === "gemini") {
    return {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 900, temperature: 0.8 },
    };
  }
  return { model, messages: [{ role: "user", content: prompt }], temperature: 0.8, max_tokens: 900, stream: false };
}

/** 模型爱把 JSON 裹在解释或 ``` 里，取最外层的一对花括号。 */
function parseJudgeJson(text: string): { decisions: Decision[]; extra: Extra[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { decisions: [], extra: [] };
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { decisions?: unknown; extra?: unknown };
    return {
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 12) as Decision[] : [],
      extra: Array.isArray(parsed.extra) ? parsed.extra.slice(0, 1) as Extra[] : [],
    };
  } catch {
    return { decisions: [], extra: [] };
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

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 200 });

  const { userId, characterId, planDate, token } = await req.json().catch(() => ({})) as {
    userId?: string; characterId?: string; planDate?: string; token?: string;
  };
  if (!userId || !characterId || !planDate || !token) return new Response("bad request", { status: 400 });

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });

  const secretResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key&limit=1");
  const secretRows = secretResponse.ok
    ? await secretResponse.json() as { cron_secret?: string | null; payload_key?: string | null }[]
    : [];
  const cronSecret = secretRows[0]?.cron_secret || "";
  const payloadKey = secretRows[0]?.payload_key || "";
  if (!cronSecret || String(token) !== cronSecret) return new Response("forbidden", { status: 403 });
  if (!payloadKey) return new Response("payload_key missing", { status: 200 });

  const planFilter = `push_recheck_plans?user_id=eq.${encodeURIComponent(userId)}`
    + `&character_id=eq.${encodeURIComponent(characterId)}`
    + `&plan_date=eq.${encodeURIComponent(planDate)}`;

  const planResponse = await rest(
    `${planFilter}&select=session_id,context,items,decisions,last_recheck_at,recheck_count,updated_at&limit=1`,
  );
  const planRows = planResponse.ok ? await planResponse.json() as PlanRow[] : [];
  const plan = planRows[0];
  if (!plan) return new Response("no plan", { status: 200 });

  const nowMs = Date.now();
  const lastRecheckMs = plan.last_recheck_at ? Date.parse(plan.last_recheck_at) : NaN;
  const context = plan.context || {};
  const gate = (key: keyof typeof GATE_DEF): number => {
    const value = Number(context[key]);
    return Number.isFinite(value) && value >= 0 ? value : GATE_DEF[key];
  };

  const items = Array.isArray(plan.items) ? plan.items : [];
  const pending = items.filter(item => Number(item.fireAt) > nowMs + LEAD_MS);
  const allDecisions = Array.isArray(plan.decisions) ? plan.decisions : [];
  const priorDecisions = allDecisions.filter(d => (d as { kind?: string }).kind !== "gate");

  // 门禁：全部过了才轮到下面那一次裁决调用。每一道都只读已有数据，不调模型，
  // 所以可以放心让 cron 派得勤，甚至将来由客户端逐条消息触发。
  //
  // 分两组：判决是重判已排好的时刻，没有待发时刻就无从判起；起念是新开一个时刻，
  // 跟有没有待发时刻无关——日程走完的晚上恰恰最该起念，两者共用一道闸时它永远轮不上。
  // 频率仍然共享（间隔、每日上限）：两组共用同一次裁决调用，分开算等于放开调用次数。
  const litCount = items.filter(item => item.act).length;
  const horizon = gate("gateHorizonMin") * 60_000;
  const nearest = pending.length > 0 ? Math.min(...pending.map(item => Number(item.fireAt))) - nowMs : Infinity;
  const canJudge = pending.length > 0 && (horizon <= 0 || nearest <= horizon);
  const canImpulse = litCount < Number(context.quota ?? 3);
  // 自发起念：没有新聊天也可以起念，由头是TA自己这一天里的事——刚做完一件有分量的日程，
  // 或者双方安静太久。每一次都是一次裁决调用，所以另有每日上限（selfImpulseCap），
  // 用掉的次数记在 context.selfUsed，App 上传计划时会原样带回来，重新编排才清零。
  const day = context.day && typeof context.day === "object" ? context.day : null;
  const selfUsed = Number(context.selfUsed) || 0;
  let selfReason = "";
  const blocked = await (async (): Promise<string> => {
    if (Number.isFinite(lastRecheckMs) && nowMs - lastRecheckMs < gate("gateGapMin") * 60_000) return "离上次裁决还不够久";
    if ((plan.recheck_count || 0) >= gate("gateDailyCap")) return "今天的裁决次数用完了";
    if (!canJudge && !canImpulse) {
      if (pending.length === 0) return "今天没有还没到点的时刻，今日额度也满了";
      return `最近的时刻还在 ${Math.round(nearest / 60_000)} 分钟以外，今日额度也满了`;
    }

    // 没新消息就没有新信息，再判一次只是烧额度。首次复核回看 6 小时，
    // 别把开机前的对话全算成"新"。
    const sinceMs = Number.isFinite(lastRecheckMs) ? lastRecheckMs : nowMs - 6 * 3600_000;
    const freshResponse = await rest(
      `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
      + `&character_id=eq.${encodeURIComponent(characterId)}`
      + "&role=eq.user"
      + `&message_at=gt.${encodeURIComponent(new Date(sinceMs).toISOString())}`
      + "&select=message_at&order=message_at.desc&limit=20",
    );
    const freshRows = freshResponse.ok ? await freshResponse.json() as { message_at: string }[] : [];
    if (freshRows.length < Math.max(1, gate("gateMinMsgs"))) {
      const quiet = "上次裁决之后你没说几句";
      if (!canImpulse || !day || gate("selfImpulseCap") <= 0) return quiet;
      if (selfUsed >= gate("selfImpulseCap")) return `${quiet}，今天的自发起念也用完了`;
      const qs = String(context.quietStart || ""), qe = String(context.quietEnd || "");
      const now = guanianNow(day, nowMs, qs, qe);
      if (qs && qe && qs !== qe && (qs < qe ? (now.hm >= qs && now.hm < qe) : (now.hm >= qs || now.hm < qe))) return `${quiet}，现在是免打扰时段`;
      if (now.asleep) return `${quiet}，TA在睡觉`;
      // 由头一：上次裁决之后新开始了一条有分量的日程（耗神/回血明显，或有情绪余味）
      const tzMs = (Number(day.tz) || 0) * 60_000;
      const sameLocalDay = Number.isFinite(lastRecheckMs)
        && Math.floor((lastRecheckMs + tzMs) / 86_400_000) === Math.floor((nowMs + tzMs) / 86_400_000);
      const sinceHM = sameLocalDay ? guanianNow(day, lastRecheckMs, qs, qe).hm : "00:00";
      const weighty = now.done && String(now.done.time) > sinceHM
        && (Math.abs(Number(now.done.cost) || 0) >= 15 || !!now.done.mood);
      if (weighty) { selfReason = `刚${now.done!.title || "做完一件事"}`; return ""; }
      // 由头二：双方都安静太久。要有过对话才算，从没聊过的不算「安静」
      const lastAnyResponse = await rest(
        `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
        + `&character_id=eq.${encodeURIComponent(characterId)}`
        + "&select=message_at&order=message_at.desc&limit=1",
      );
      const lastAny = lastAnyResponse.ok ? await lastAnyResponse.json() as { message_at: string }[] : [];
      const lastAnyMs = Date.parse(lastAny[0]?.message_at || "");
      const silentMs = Number.isFinite(lastAnyMs) ? nowMs - lastAnyMs : 0;
      if (silentMs >= SELF_SILENCE_MS && (!Number.isFinite(lastRecheckMs) || lastRecheckMs < lastAnyMs + SELF_SILENCE_MS)) {
        selfReason = `已经 ${Math.round(silentMs / 3600_000)} 小时没联系`;
        return "";
      }
      return quiet;
    }
    const freshMs = gate("gateFreshMin") * 60_000;
    const lastMsgMs = Date.parse(freshRows[0]?.message_at || "");
    if (freshMs > 0 && Number.isFinite(lastMsgMs) && nowMs - lastMsgMs < freshMs) return "你才刚说完，等一下再判";
    return "";
  })();

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
    guard && plan.updated_at ? `${planFilter}&updated_at=eq.${encodeURIComponent(plan.updated_at)}` : planFilter,
    {
      method: "PATCH",
      headers: { Prefer: guard ? "return=representation" : "return=minimal" },
      // 只动 last_recheck_at：updated_at 留给「App 上传计划」，
      // 复核自己刷新它的话，cron 的 36 小时派发窗口就永远不会过期。
      body: JSON.stringify({ last_recheck_at: new Date().toISOString(), ...extra }),
    },
  ).catch(() => undefined);
  await touch();

  const run = async (): Promise<void> => {
    // 时区：计划里的 time 是用户本地 HH:MM，fireAt 是绝对毫秒。两者一减就还原出本地偏移，
    // 后面给临时起念算时刻直接复用，不必猜数据库时区。
    // 挑第一条 time 合法的当基准；一条都没有就退回 UTC，同时不许云端起念——
    // 临时起念的绝对时刻全靠这个基准换算，基准不可信只会把消息发到错的钟点。
    // 用 items 而不是 pending：日程走完的晚上 pending 是空的，但今天已经过点的时刻
    // 一样能还原出时区偏移，起念照样算得出绝对时刻。
    const anchor = items.find(item => /^\d{1,2}:\d{2}$/.test(item.time)) || items[0];
    if (!anchor) return;
    const anchorTrusted = /^\d{1,2}:\d{2}$/.test(anchor.time);
    const anchorLocal = anchorTrusted
      ? Number(anchor.time.split(":")[0]) * 60 + Number(anchor.time.split(":")[1])
      : new Date(anchor.fireAt).getUTCHours() * 60 + new Date(anchor.fireAt).getUTCMinutes();
    const anchorUtc = new Date(anchor.fireAt).getUTCHours() * 60 + new Date(anchor.fireAt).getUTCMinutes();
    let offsetMin = anchorLocal - anchorUtc;
    if (offsetMin > 720) offsetMin -= 1440;
    if (offsetMin < -720) offsetMin += 1440;

    // 快照模板：优先拿今天还没发的那几条预约。它们的 payload 里冻着上游地址和密钥，
    // 裁决调用和后面的点亮都靠它——本函数自己不持有任何模型凭据。
    // 哨兵预约（App 编排时挂的、48 小时后才到点的模板）也算在内：一个时刻都没点亮的日子全靠它。
    const sentinelWakeId = typeof context.sentinelWakeId === "string" ? context.sentinelWakeId : "";
    const wakeKeys = items.map(item => item.wakeId).concat(sentinelWakeId).filter(Boolean).map(id => `"timedwake:${id}"`);
    let found: JobPayload | null = null;
    const jobsByKey = new Map<string, JobRow>();
    if (wakeKeys.length > 0) {
      const jobsResponse = await rest(
        `push_jobs?user_id=eq.${encodeURIComponent(userId)}`
        + `&trigger_key=in.(${encodeURIComponent(wakeKeys.join(","))})`
        + "&select=id,trigger_key,status,execute_at,payload",
      );
      const jobRows = jobsResponse.ok ? await jobsResponse.json() as JobRow[] : [];
      for (const row of jobRows) jobsByKey.set(row.trigger_key, row);
      // 待发的快照最新，已发过的是今早的上下文——克隆和裁决都优先用前者。
      jobRows.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
      for (const row of jobRows) {
        if (found) break;
        try {
          found = JSON.parse(await decryptPayload(row.payload, payloadKey)) as JobPayload;
        } catch { /* 单条解不开就换下一条 */ }
      }
    }
    if (!found) return;
    const template = found;

    const mirrorResponse = await rest(
      `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
      + `&character_id=eq.${encodeURIComponent(characterId)}`
      + "&select=role,content,message_at&order=message_at.desc&limit=24",
    );
    const mirrorRows = mirrorResponse.ok
      ? (await mirrorResponse.json() as { role: string; content: string; message_at: string }[]).reverse()
      : [];

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
      return list.some(other => other.act && other !== self && Math.abs(other.fireAt - fireAt) < gap);
    };
    const characterName = template.notify?.title || "TA";
    const chatLines = mirrorRows
      .map(row => `${row.role === "user" ? "用户" : characterName}（${hhmm(Date.parse(row.message_at), offsetMin)}）：${String(row.content || "").slice(0, 200)}`)
      .join("\n");
    const planLines = pending
      .map(item => `- ${item.time}｜${item.source}｜${item.act ? "已点亮" : "未点亮"}｜意图：${item.intent || "（无）"}｜理由：${item.why || "（无）"}`)
      .join("\n");

    // 自发起念这轮没有新聊天，判决无从谈起：只问「此刻TA自己想不想找用户」
    const judge = canJudge && !selfReason;
    const now = day ? guanianNow(day, nowMs, context.quietStart, context.quietEnd) : null;
    const stateLine = now
      ? `此刻的状态：${now.asleep ? "在睡觉" : "在" + (now.doing || "没什么特别的")}${now.step ? "（" + now.step + "）" : ""}，情绪「${now.mood}」，精力 ${now.energy}%${now.next ? "，接下来 " + now.next : ""}。`
      : (context.mood || context.energy ? `今天的状态：心情「${context.mood || "普通"}」，精力「${context.energy || "普通"}」。` : "");
    const prompt = [
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
      judge ? "今天剩下的计划时刻：" : (selfReason ? "" : "今天排好的时刻都已经过点了，没有要重判的。"),
      judge ? planLines : "",
      "",
      selfReason
        ? `没有新对话。由头是你自己这边的事：${selfReason}。想一想此刻的你会不会想找用户说点什么——`
          + "分享刚发生的、忽然想起TA、单纯想搭句话都行；但不想说、或者上面聊到的事已经了了，就老实写 []，"
          + "不要为了发而发。真要发的话时刻定在接下来 5 到 40 分钟之间。"
        : canJudge
        ? "根据刚才聊过的内容重新判断每个时刻：聊过的话题已经了了就别再提，"
          + "用户说了忙/情绪不好就收敛，聊到一半没说完或约好了要说的事可以点亮"
          + (canImpulse ? "甚至新加一个时刻。" : "。")
        : "只看刚才聊的内容里有没有值得临时起一个新念头的事：聊到一半没说完的话头、"
          + "约好了要说的、答应了要问的。只是随口聊到、没落实的事不算。",
      "只输出 JSON，不要任何解释：",
      "{"
      + (judge
        ? '"decisions":[{"time":"HH:MM","act":true,"sem":"关心|分享|约定|闲聊","topic":"一句话主题","why":"你为什么这么定","intent":"到点时你想说的事，一句话"}]'
        : '"decisions":[]')
      + ","
      + (canImpulse
        ? '"extra":[{"time":"HH:MM","about":"临时起念的由头","intent":"想说的事","why":"为什么现在加"}]'
        : '"extra":[]')
      + "}",
      judge ? "decisions 只写你要改的时刻（其余的保持原样就不用写）。" : "decisions 一律写 []。",
      canImpulse ? "extra 最多 1 条，没有就写 []。" : "今日额度已满，extra 一律写 []。",
    ].filter(Boolean).join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let judgeText = "";
    try {
      const response = await fetch(template.request.url, {
        method: "POST",
        headers: template.request.headers,
        body: JSON.stringify(buildJudgeBody(template.request, prompt)),
        signal: controller.signal,
      });
      if (!response.ok) return;
      judgeText = extractResponseText(template.request.providerKind, await response.json());
    } catch {
      return;
    } finally {
      clearTimeout(timeout);
    }

    // 门禁只放行了其中一组时，另一组的返回一律丢掉——提示词里已经要求写 []，
    // 但模型不一定听话，这里是硬拦。
    const judged = parseJudgeJson(judgeText);
    const decisions = judge ? judged.decisions : [];
    const extra = canImpulse ? judged.extra : [];
    if (decisions.length === 0 && extra.length === 0) {
      await touch({ recheck_count: (plan.recheck_count || 0) + 1 });
      return;
    }

    const applied: Record<string, unknown>[] = [];
    const nextItems = items.map(item => ({ ...item }));
    let lit = litCount;

    // 预约 id 必须带 App 上传的前缀：宿主的 push.cancelWake 只认自家 APP 的 id，
    // 前缀对不上，用户下次打开就撤不掉云端点亮的这条。
    const wakePrefix = context.wakePrefix || "";
    const armedKeys: string[] = [];
    const armJob = async (fireAt: number, intent: string): Promise<string> => {
      if (!wakePrefix) return "";
      const wakeId = `${wakePrefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const clone = JSON.parse(JSON.stringify(template)) as JobPayload;
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
      const index = nextItems.findIndex(item => item.time === time && item.fireAt > nowMs + LEAD_MS);
      if (index < 0) continue;
      const item = nextItems[index];
      const why = String(decision.why || "").slice(0, 200);

      if (decision.act === false && item.act) {
        const job = item.wakeId ? jobsByKey.get(`timedwake:${item.wakeId}`) : undefined;
        if (job && job.status === "pending") {
          await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.pending`, {
            method: "PATCH",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ status: "cancelled", result_note: "cloud recheck cancel", updated_at: new Date().toISOString() }),
          }).catch(() => undefined);
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
      if (nextItems.some(item => item.time === time)) continue;
      if (tooClose(fireAt, nextItems)) continue;
      const intent = String(one.intent || one.about || "").slice(0, 200);
      if (!intent) continue;
      const wakeId = await armJob(fireAt, intent);
      if (!wakeId) continue;
      nextItems.push({
        time,
        fireAt,
        source: `${selfReason ? "自发" : "临时"}·${String(one.about || (selfReason ? "想起你" : "未完话题")).slice(0, 10)}`,
        act: true,
        intent,
        why: String(one.why || "").slice(0, 200),
        sem: "",
        topic: "",
        wakeId,
      });
      lit += 1;
      applied.push({ at: Date.now(), time, kind: "extra", note: `云端临时起念——${intent}`, by: "cloud" });
    }

    nextItems.sort((a, b) => a.fireAt - b.fireAt);
    // 自发起念不管有没有起成都记一笔：既扣次数，也让 App 的诊断里看得到「TA想了想，没找你」
    if (selfReason) applied.push({ at: Date.now(), kind: "self", note: `自发起念（${selfReason}）——${lit > litCount ? "起了一个念头" : "想了想，没找你"}`, by: "cloud" });
    const saved = await touch({
      items: nextItems,
      decisions: [...priorDecisions, ...applied].slice(-60),
      recheck_count: (plan.recheck_count || 0) + 1,
      ...(selfReason ? { context: { ...context, selfUsed: selfUsed + 1 } } : {}),
    }, true);
    const rows = saved?.ok ? await saved.json().catch(() => []) as unknown[] : [];
    if (Array.isArray(rows) && rows.length > 0) return;
    // 没写进去 = App 在这轮期间换了计划，我们的裁决作废。刚挂上的预约必须一起撤掉：
    // 新计划里没有它们的 wakeId，留着就是任何界面都查不到出处的孤儿，到点照发。
    if (armedKeys.length) {
      await rest(`push_jobs?user_id=eq.${encodeURIComponent(userId)}&status=eq.pending`
        + `&trigger_key=in.(${encodeURIComponent(armedKeys.join(","))})`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "cancelled" }),
      }).catch(() => undefined);
    }
  };

  const work = run().catch(() => undefined);
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work);
  else await work;
  return new Response("accepted", { status: 200 });
});
