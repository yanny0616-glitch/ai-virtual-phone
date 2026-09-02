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
  genKit?: GenKit | null;
  generatedBy?: string;
  genTries?: number;
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
    cost: Math.max(-40, Math.min(40, Math.round(+pickField(it, ["cost", "精力影响", "消耗"]) || 0))),
    busy: isTrue(pickField(it, ["busy", "顾不上", "忙"])),
  }));
  for (const it of existing) {
    const hit = sched.find((x) => x.time === it.startTime);
    if (!hit) sched.push({ time: String(it.startTime || ""), title: String(it.title || ""), place: it.location || "", note: it.location || "日程表上的安排", busy: it.lock === "busy" });
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
      energyDelta: Math.max(-20, Math.min(20, Math.round(+b.energy || 0))),
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
function buildImpulseInstruction(day: { mood: string; energy: number; schedule: unknown[] }, candRows: unknown[], lines: string[],
  settings: { quota: number; quietStart: string; quietEnd: string; minGapMin: number; moodGate: boolean }, biasLine: string): string {
  return [
    "【后台系统任务，不是聊天：不要以角色口吻说话、不要直接写消息内容，只输出判断 JSON】",
    "你是当前角色的内心。逐个判断：在下面每个候选时刻、做完那件事之后，TA会不会真的想给用户发消息？不是每个都要发——按TA的性格克制判断。",
    '输出严格 JSON，第一个字符必须是 {，字段名一字不差：{"decisions":[{"time":"HH:MM","act":true或false,"sem":"这次接触的类型，从 问候/关心/追话题/分享/惦记 里选一个","topic":"这次想聊的话题（8字内）","why":"判断理由（20字内）","intent":"act为true时TA当时的第一人称心理动机（40字内，不写台词），否则空字符串"}]}。decisions 与候选时刻一一对应、顺序一致。',
    "TA今天的生活面：", JSON.stringify({ mood: day.mood, energy: day.energy, schedule: day.schedule }),
    "（energy 是TA刚醒时的基线；下面每个候选时刻另给了那一刻的剩余精力和做完那件事之后的情绪，精力越低越懒得开口，情绪决定TA想说什么样的话）",
    lines.length ? "\n最近和用户的聊天（「我」=用户，「TA」=角色，从旧到新）：\n" + lines.join("\n") : null,
    lines.length ? "结合聊天氛围判断：正聊得火热就不必刻意再约时刻；有没接完的话头、刚闹过别扭、或很久没联系，都会真实影响TA想不想主动、以及动机的内容。动机要能接上最近聊的事，不要凭空另起炉灶。" : null,
    "", "候选时刻（判断每个时刻做完这件事后，TA会不会想给用户发消息）：",
    JSON.stringify(candRows),
    "", "约束：今天最多真的发 " + settings.quota + " 条；免打扰时段 " + settings.quietStart + "–" + settings.quietEnd
      + (settings.minGapMin > 0 ? "；相邻两次起念至少隔 " + settings.minGapMin + " 分钟" : "") + "。",
    (settings.moodGate && day.energy < 30) ? "TA今天精力只有 " + day.energy + "%，很低。这种时候TA更想缩着，明显减少主动。" : null,
    biasLine || null,
  ].filter((s) => s !== null).join("\n");
}
// App 同名 chatExcerpt / unansweredStreak
function chatExcerpt(msgs: { role: string; c: string }[], maxLines: number): string[] {
  return msgs.slice(-(maxLines || 20)).map((m) =>
    (m.role === "user" ? "我：" : "TA：") + (m.c.length > 60 ? m.c.slice(0, 60) + "…" : m.c));
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
// App 同名 buildCandidates：本地 timeToMs/fmtHM 换成按 tz 的 UTC 算术
function buildCandidates(day: GenDay, planDate: string, tz: number, nowMs: number,
  settings: { quietStart: string; quietEnd: string; anchorMorning: boolean; anchorSleep: boolean }) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(planDate);
  const dayUtc = dm ? Date.UTC(+dm[1], +dm[2] - 1, +dm[3]) : NaN;
  const timeToMs = (hm: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
    if (!m || !Number.isFinite(dayUtc)) return null;
    return dayUtc + (+m[1] * 60 + +m[2] - tz) * 60_000;
  };
  const fmtHM = (ms: number) => hhmm(ms, tz);
  const inQuiet = (hm: string) => {
    const qs = settings.quietStart, qe = settings.quietEnd;
    if (!qs || !qe || qs === qe) return false;
    return qs < qe ? (hm >= qs && hm < qe) : (hm >= qs || hm < qe);
  };
  const sleepWindow = () => {
    const bed = normHM(day.bed) || settings.quietStart || "";
    const wake = normHM(day.wake) || settings.quietEnd || "";
    return bed && wake && bed !== wake ? { bed, wake, overnight: bed < wake } : null;
  };
  const asleepAt = (hm: string) => {
    const w = sleepWindow();
    if (!w) return false;
    return w.overnight ? (hm >= w.bed && hm < w.wake) : (hm >= w.bed || hm < w.wake);
  };
  const now = nowMs + 3 * 60000;
  const seen = new Set<string>();
  const cands: { time: string; source: string; fireAt: number; mood?: string }[] = [];
  const drift = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo)) * 60000;
  for (const it of day.schedule) {
    const base = timeToMs(it.time);
    const ms = base ? base + drift(1, 12) : null;
    if (!ms || ms < now || seen.has(it.time)) continue;
    const hm = fmtHM(ms);
    if (inQuiet(hm) || asleepAt(hm)) continue;
    seen.add(it.time);
    cands.push({ time: hm, source: it.title, fireAt: ms, mood: it.mood || "" });
  }
  if (settings.anchorMorning) {
    const ms = timeToMs(settings.quietEnd) || timeToMs("08:00");
    const gm = ms ? ms + drift(25, 55) : null;
    if (gm && gm > now) {
      const hm = fmtHM(gm);
      if (!seen.has(hm) && !inQuiet(hm)) { seen.add(hm); cands.push({ time: hm, source: "早安", fireAt: gm }); }
    }
  }
  const sw = sleepWindow();
  if (settings.anchorSleep && sw) {
    const ms = sw.overnight ? timeToMs("23:50") : timeToMs(sw.bed);
    const gm = ms ? ms - drift(10, 30) : null;
    if (gm && gm > now) {
      const hm = fmtHM(gm);
      if (!seen.has(hm) && !inQuiet(hm) && !asleepAt(hm)) cands.push({ time: hm, source: "睡前", fireAt: gm });
    }
  }
  cands.sort((a, b) => a.fireAt - b.fireAt);
  return cands.slice(0, 8);
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
    const raw = await generateJsonWith(tplDaily, instruction, log, record);
    const dayFull = parseDayResult(raw, existing, settings, nowMs);
    const day: GuanianDay & Record<string, unknown> = {
      tz, mood: dayFull.mood, energy: dayFull.energy, location: dayFull.location, doing: dayFull.doing,
      wake: dayFull.wake, bed: dayFull.bed,
      schedule: dayFull.schedule.map(it => ({ time: it.time, end: it.end || "", title: it.title, place: it.place || "", cost: +(it.cost || 0), mood: it.mood || "", busy: !!it.busy })),
      conds: dayFull.conds.map(c => ({ startAt: c.startAt, halfLifeMin: c.halfLifeMin, intensity: c.intensity, energyDelta: c.energyDelta, mood: c.mood, cause: c.cause })),
    };
    log("生成今日生活面：" + dayFull.schedule.length + " 条日程（日程表已定 " + existing.length + " 条），作息 " + dayFull.wake + " 起 " + dayFull.bed + " 睡，心情「" + dayFull.mood + "」"
      + (dayFull.sleep ? "，昨晚" + dayFull.sleep : "") + (dayFull.conds.length ? "，身上：" + dayFull.conds.map(c => c.cause).join("、") : "")
      + (dayFull.mood ? "" : "（心情为空，模型顶层字段：" + Object.keys(raw || {}).slice(0, 10).join("/") + "）"));

    // ── 编排心动时刻（与 App orchestrate 同一套候选、同一份判断指令、同一套数值约束）
    const cands = buildCandidates(dayFull, planDate, tz, nowMs, settings);
    const items: Record<string, unknown>[] = [];
    let chatUsed = 0;
    if (!cands.length) {
      log("编排：无未来候选时刻（已过时段或全部落在免打扰内）");
    } else {
      log("候选时刻：" + cands.map(c => c.time + "·" + c.source).join("，"));
      const mirrorResponse = await rest(
        `push_chat_mirror?user_id=eq.${encodeURIComponent(userId)}`
        + `&character_id=eq.${encodeURIComponent(characterId)}`
        + "&select=role,content,message_at&order=message_at.desc&limit=60",
      );
      const mirrorRows = mirrorResponse.ok ? (await mirrorResponse.json() as { role: string; content: string; message_at: string }[]).reverse() : [];
      const chat = mirrorRows
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({ role: m.role, t: Date.parse(m.message_at) || 0, c: String(m.content || "").replace(/\s+/g, " ").trim() }))
        .filter(m => m.c)
        .sort((a, b) => a.t - b.t);
      const streak0 = unansweredStreak(chat, nowMs);
      const lines = chatExcerpt(chat, 20);
      chatUsed = lines.length;
      if (lines.length) log("已读入最近 " + lines.length + " 句聊天作为判断上下文" + (streak0 ? "（当前连续 " + streak0 + " 轮未回）" : ""));
      const candRows = cands.map(c => ({ time: c.time, justFinished: c.source, mood: c.mood || "", energy: guanianNow(day, c.fireAt, settings.quietStart, settings.quietEnd).energy }));
      const parsed = await generateJsonWith(tplImpulse, buildImpulseInstruction(dayFull, candRows, lines, settings, String(context.bias || "")), log, record);
      const decisions: Decision[] = Array.isArray(parsed?.decisions) ? parsed.decisions : [];

      const wakePrefix = String(context.wakePrefix || "");
      const armWake = async (fireAt: number, intent: string): Promise<{ id: string; reason: string }> => {
        if (!tplChat) return { id: "", reason: "云端没有可借的聊天模板（哨兵预约不在了）" };
        if (!wakePrefix) return { id: "", reason: "没有预约 id 前缀" };
        const wakeId = `${wakePrefix}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const clone = JSON.parse(JSON.stringify(tplChat)) as JobPayload;
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

      const armedAt: number[] = [];
      let armedCount = 0;
      const prevArmed = (t: number) => armedAt.filter(x => x < t).sort((a, b) => b - a)[0] || 0;
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        const d = decisions[i] || {};
        const item: Record<string, unknown> = {
          time: c.time, fireAt: c.fireAt, source: c.source, act: !!d.act,
          why: String(d.why || ""), intent: String(d.intent || ""), delivery: "", reason: "", wakeId: "",
          sem: String(d.sem || ""), topic: String(d.topic || ""),
          score: calcScore(c.fireAt, armedCount, streak0, prevArmed(c.fireAt), tz, settings),
        };
        if (item.act && armedCount >= settings.quota) { item.act = false; item.why = "超出今日额度"; }
        if (item.act && settings.minGapMin > 0 && armedAt.some(t => Math.abs(c.fireAt - t) < settings.minGapMin * 60000)) { item.act = false; item.why = "离上一个起念太近"; }
        if (item.act) {
          const intent = String(item.intent || ("刚" + c.source + "，忽然想到用户"));
          const res = await armWake(c.fireAt, intent);
          if (res.id) {
            item.wakeId = res.id; item.delivery = "push"; item.reason = "";
            armedCount++; armedAt.push(c.fireAt);
            log(c.time + " 起念 ✓ 已预约离线推送：" + intent);
          } else {
            // 和本地「仅本地」不同：云端没有本地路径可退，起念留着，App 打开时能看到原因
            item.delivery = ""; item.reason = res.reason;
            armedCount++; armedAt.push(c.fireAt);
            log(c.time + " 起念 ✓ 但没挂上预约（" + res.reason + "）：" + intent);
          }
        } else {
          log(c.time + " 未起念：" + (item.why || "TA这会儿不想"));
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

  // 云端生成：这一行还只是 App 寄来的生成原料（没有 day，也没有时刻），到点才动，
  // 生成之前不走下面的复核——没有生活面的复核和自发起念都无从判起。
  const kit = context.genKit && typeof context.genKit === "object" ? context.genKit : null;
  if (kit && context.generatedBy !== "cloud") {
    const tz = Number(kit.tz) || 0;
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
  // 过了日子的行还会在 cron 的 36 小时窗口里待一天：没有待发时刻，但起念门可能还开着，
  // 每轮都可能白调一次模型，产出又全因为不是今天而被丢掉。
  const dayTz = context.day && typeof context.day === "object" ? Number((context.day as { tz?: number }).tz) : NaN;
  const rowTz = Number.isFinite(dayTz) ? dayTz : (kit ? Number(kit.tz) || 0 : NaN);
  if (Number.isFinite(rowTz) && usageLocalDay(nowMs, rowTz) > planDate) {
    await rest(planFilter, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_recheck_at: new Date().toISOString() }) }).catch(() => undefined);
    return new Response("plan date passed", { status: 200 });
  }

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
    const over = usageExceeded(await usageBudget(rest, userId));
    if (over) return over;
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
      const judgeData = await response.json();
      await usageAdd(rest, userId, (await usageBudget(rest, userId)).tz, "cloud-recheck", template.request.providerKind, judgeData);
      judgeText = extractResponseText(template.request.providerKind, judgeData);
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
