// 离线推送·兜底生成执行器（Supabase Edge Function 版）
// 部署：Dashboard → Edge Functions → 新建函数 push-generate → 粘贴本文件 →
//      关闭 JWT 校验（Enforce JWT verification = off，本函数用 cron_secret 自校验）
// 职责：认领预约 → 解密快照 → 补齐快照之后本服务已发的消息 → 重放 LLM 请求 → 原始输出写 push_outbox →
//      分条推送（800ms 节奏）→ 标记完成。逻辑与 netlify 版一致。
// 注意：本文件为自包含移植，若改动 lib/llm-provider-adapter 的解析或
//      lib/push-preview-split 的分条规则，需同步更新这里。

type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

// ── 内嵌：Web Push 协议原生实现（RFC8291 aes128gcm + RFC8292 VAPID）──
// npm:web-push 依赖 Node 加密接口，在 Deno Edge 运行时不可靠，这里用 WebCrypto 手写。

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as unknown as BufferSource, info: info as unknown as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptWebPushPayload(p256dhB64: string, authB64: string, payload: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as unknown as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const ikm = await hkdf(authSecret, ecdh, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
  const plaintext = concatBytes(utf8(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as unknown as BufferSource },
    aesKey,
    plaintext as unknown as BufferSource,
  ));

  // aes128gcm 头：salt(16) + rs(4, 4096) + idlen(1) + as_public(65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

async function buildVapidAuth(endpoint: string, subject: string, publicKeyB64: string, privateKeyB64: string): Promise<string> {
  const pub = b64urlToBytes(publicKeyB64);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateKeyB64,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(utf8(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput) as unknown as BufferSource,
  ));
  return `vapid t=${signingInput}.${bytesToB64url(signature)}, k=${publicKeyB64}`;
}

/** 发送一条 Web Push；返回 HTTP 状态码（201=成功，404/410=订阅失效）。 */
async function sendWebPushRaw(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttl: number,
): Promise<number> {
  const body = await encryptWebPushPayload(sub.p256dh, sub.auth, payload);
  const authorization = await buildVapidAuth(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  const response = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
    },
    body: body as unknown as BodyInit,
  });
  await response.text().catch(() => "");
  return response.status;
}

// ── 内嵌：lib/llm-provider-adapter 的响应文本提取 ──
function stripHallucinatedTimestamps(text: string): string {
  return text
    .replace(/[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*/g, "")
    .replace(/\(system\s*time\s*[:：][^)]*\)\s*/gi, "");
}

function textFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
      if (typeof item.text === "string") return item.text;
      return "";
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
    return stripHallucinatedTimestamps(text);
  }
  if (providerKind === "gemini") {
    const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      const item = part as { text?: string; thought?: boolean; functionCall?: unknown };
      if (!item.functionCall && !item.thought) text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  const d = data as { choices?: Array<{ message?: { content?: unknown }; text?: string }>; output?: { text?: string }; response?: string };
  const messageText = textFromUnknownContent(d.choices?.[0]?.message?.content).trim();
  const text = messageText
    || (typeof d.choices?.[0]?.text === "string" ? d.choices[0].text.trim() : "")
    || (typeof d.output?.text === "string" ? d.output.text.trim() : "")
    || (typeof d.response === "string" ? d.response.trim() : "");
  return stripHallucinatedTimestamps(text);
}

// ── 内嵌：lib/push-preview-split 的弹窗预览分条 ──
const RICH_MEDIA_NAMES = new Set(["红包", "转账", "照片", "位置", "表情包", "引用", "语音", "音乐"]);

function stripStateValues(text: string): string {
  const regex = /\[([^\[\]:：]+)[：:](\d+(?:\.\d+)?)\]/g;
  return text.replace(regex, (m, rawName: string) => {
    const name = rawName.trim();
    if (!name || /^\d+$/.test(name) || RICH_MEDIA_NAMES.has(name)) return m;
    return "";
  });
}

function stripBracketBlock(text: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)\\[\\/${escaped}\\]`, "g"), "");
}

function humanizeSegment(segment: string): string {
  const marker = segment.match(/^\[([^\][：:]{1,12})[：:]([\s\S]*?)\]$/);
  if (!marker) return segment;
  const kind = marker[1];
  if (/表情包/.test(kind)) return "[表情包]";
  if (/图片|照片|图片描述/.test(kind)) return `发了一张照片: ${marker[2].slice(0, 40)}`;
  if (/语音通话/.test(kind)) return "发起了语音通话";
  if (/视频通话/.test(kind)) return "发起了视频通话";
  if (/语音/.test(kind)) return "[语音]";
  if (/红包/.test(kind)) return "[红包]";
  if (/转账/.test(kind)) return "[转账]";
  if (/位置/.test(kind)) return "[位置]";
  if (/拍一拍|拍了拍/.test(kind)) return "拍了拍你";
  return segment;
}

function splitResponseForPushPreview(rawText: string): string[] {
  let text = stripStateValues(rawText);
  text = stripBracketBlock(text, "状态栏");
  text = stripBracketBlock(text, "内心");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text
    .split(/\n\n+/)
    .map(segment => humanizeSegment(segment.trim()))
    .map(segment => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// ── 内嵌：lib/server/push-job-crypto 的解密（Web Crypto 实现，格式兼容） ──
type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
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
  const ct = combined.slice(0, combined.length - 16);
  const tag = combined.slice(combined.length - 16);
  const toB64 = (bytes: Uint8Array) => {
    let raw = "";
    for (const b of bytes) raw += String.fromCharCode(b);
    return btoa(raw);
  };
  return { v: 1, iv: toB64(iv), tag: toB64(tag), ct: toB64(ct) };
}

async function decryptPayload(payload: EncryptedPayload, serviceKey: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${serviceKey}:push-job-v1`));
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

// ── 主流程 ──
type JobRow = { result_note?: string | null; id: string; user_id: string; trigger_key: string; kind: string; payload: EncryptedPayload };
type SubscriptionRow = { endpoint: string; p256dh: string; auth: string };
// BEGIN DEFERRED REPLY TIMING
/** Pure, absolute-time rules. Embedded in push-generate by push:build-dist. */
type CloudReplyTiming = {
    disabled?: boolean;
    expiresAt?: number;
    nextAt: number;
    reason?: "busy" | "sleep";
    windowKey?: string;
    availableUntil?: number;
    check?: boolean;
    note: string;
    peekMin: number;
    adaptive: boolean;
    probability: number;
    windows: { from: number; to: number; title: string; key: string; focused: boolean; breaks: { from: number; to: number }[] }[];
    sleeps: { from: number; to: number }[];
    sleepBufferMin: number;
    sleepWakeProbability: number;
};

function advanceCloudReplyTiming(input: CloudReplyTiming, now: number, random: () => number = Math.random): CloudReplyTiming & { ready: boolean } {
    const t = { ...input };
    if (t.disabled || (t.expiresAt != null && now >= t.expiresAt)) return { ...t, ready: true, check: false, note: "现在可以回复对方，把等待期间的消息合起来自然回复。" };
    if (t.nextAt > now) return { ...t, ready: false };
    const wait = (minutes: number) => minutes * (0.6 + random() * 0.8) * 60_000;
    const sleep = t.sleeps.find(w => w.from <= now && now < w.to);
    if (sleep && t.reason !== "sleep" && t.sleepWakeProbability > 0 && random() * 100 < t.sleepWakeProbability) {
        return { ...t, ready: true, check: false, note: "你正睡着，被消息吵醒了，迷迷糊糊，只回一两句短的，之后还要接着睡。" };
    }
    if (sleep) return { ...t, ready: false, reason: "sleep", check: false, windowKey: undefined,
        nextAt: sleep.to + wait(t.sleepBufferMin), note: "你刚起床，才看到等待期间对方发来的消息。把消息合起来自然回复。" };
    const win = t.peekMin > 0 ? t.windows.find(w => w.from <= now && now < w.to) : undefined;
    if (!win) return { ...t, ready: true, check: false, note: t.reason === "sleep" ? t.note : "你现在才有空看手机。把等待期间对方的消息合起来回复，不要说还在先前的活动里偷空。" };
    const pause = win.breaks.find(w => w.from <= now && now < w.to);
    const futurePause = win.breaks.find(w => w.from > now);
    const nextCheck = () => Math.min(now + wait(t.peekMin), futurePause?.from ?? win.to);
    const same = t.reason === "busy" && t.windowKey === win.key && (!t.availableUntil || now < t.availableUntil);
    if (!same) {
        t.reason = "busy"; t.windowKey = win.key; t.availableUntil = undefined; t.check = false;
        if (t.adaptive && win.focused) {
            if (pause || (t.probability <= 0 && futurePause)) {
                const rest = pause ?? futurePause!;
                const start = Math.max(now, rest.from);
                t.nextAt = start + Math.min(wait(t.peekMin), (rest.to - start) / 2);
                t.availableUntil = rest.to;
            } else if (t.probability > 0) { t.nextAt = nextCheck(); t.check = true; }
            else t.nextAt = win.to + Math.min(wait(t.peekMin), 300_000);
        } else t.nextAt = Math.min(now + wait(t.peekMin), win.to + 60_000);
        return { ...t, ready: false };
    }
    if (t.check && !pause && random() * 100 >= t.probability) return { ...t, ready: false, nextAt: nextCheck() };
    return { ...t, ready: true, check: false, note: pause
        ? `你正在${win.title}的休息间隙。把等待期间对方的消息合起来简短回复，之后还要继续忙。`
        : `你还在${win.title || "忙事情"}，刚抽出一点空看手机。把等待期间对方的消息合起来简短回复，之后还要继续忙；不要声称活动结束，也不要虚构正式休息。` };
}
// END DEFERRED REPLY TIMING

// BEGIN CHAT SILENCE PROTOCOL
// Shared by the browser and personal-cloud worker; no storage or clock access.
const CHAT_SILENCE_TOKEN = "[本轮不回复]";

function silenceThinkingTags(thinkingTag?: string): string {
    return ["think", "thinking", ...(thinkingTag && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(thinkingTag) ? [thinkingTag] : [])].join("|");
}

function stripSilenceThinking(text: string, thinkingTag?: string): string {
    return text.replace(new RegExp(`<(${silenceThinkingTags(thinkingTag)})>[\\s\\S]*?<\\/\\1>`, "gi"), "");
}

/** A dedicated first-line decision may be followed by normal metadata/update instructions. */
function isChatSilenceResponse(text: string, thinkingTag?: string): boolean {
    const candidate = stripSilenceThinking(text, thinkingTag).trim();
    return candidate === CHAT_SILENCE_TOKEN || candidate.startsWith(`${CHAT_SILENCE_TOKEN}\n`)
        || candidate.startsWith(`${CHAT_SILENCE_TOKEN}\r\n`);
}

function stripChatSilenceMarker(text: string, thinkingTag?: string): string {
    if (!isChatSilenceResponse(text, thinkingTag)) return text;
    return stripSilenceThinking(text, thinkingTag).trim().slice(CHAT_SILENCE_TOKEN.length).trim();
}

/** Hold only the possible protocol prefix; normal prose continues streaming immediately. */
function createChatSilenceStreamFilter(emit: (text: string) => void | Promise<void>, thinkingTag?: string) {
    let pending = "";
    let released = false;
    return {
        async push(delta: string) {
            if (released) { await emit(delta); return; }
            pending += delta;
            const candidate = stripSilenceThinking(pending, thinkingTag).trimStart();
            if (!candidate || isChatSilenceResponse(pending, thinkingTag) || CHAT_SILENCE_TOKEN.startsWith(candidate.trimEnd())
                || new RegExp(`^(?:<(?:${silenceThinkingTags(thinkingTag)})>[\\s\\S]*|<\\/?[a-zA-Z0-9_-]*)$`, "i").test(candidate)) return;
            released = true;
            await emit(pending);
            pending = "";
        },
        async flush() {
            if (pending && !isChatSilenceResponse(pending, thinkingTag)) await emit(pending);
            pending = "";
        },
    };
}
// END CHAT SILENCE PROTOCOL

// 挂念旧预约没有解析配置：兼容标准标签；新预约尊重冻结时的线上配置。
function guanianVisibleResponse(text: string, config: unknown): { text: string; reasoningText?: string } {
  const settings = config as { enabled?: boolean; tag?: string } | undefined;
  if (settings?.enabled === false) return { text: text.trim() };
  const tags = settings?.enabled === true
    ? [typeof settings.tag === "string" && settings.tag.trim() ? settings.tag.trim() : "thinking"]
    : ["thinking", "think", "thought"];
  const thoughts: string[] = [];
  for (const tag of tags) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "gi"), (_block, thought: string) => {
      if (thought.trim()) thoughts.push(thought.trim());
      return "";
    });
    // 不完整标签不能把剩余分析作为台词交付，也不能冒充成功作罢。
    if (new RegExp(`</?${escaped}>`, "i").test(text)) throw new Error("guanian incomplete thinking block");
  }
  return { text: text.trim(), reasoningText: thoughts.join("\n\n") || undefined };
}

type JobPayload = {
  generatedResponse?: { rawText: string; createdAt: string; processingStarted?: boolean;
    delivery?: { rawText: string; deliverAsCall: boolean; marker: { text: string; insertAt: number; name: string } | null; [key: string]: unknown } };
  allowSilence?: boolean;
  silenceThinkingTag?: string;
  deferredReply?: { revision: number; timing: CloudReplyTiming };
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  shortcut?: {
    commandId: string;
    actionName: string;
    resultMode: "none" | "text" | "image";
    resultMarker: string;
    imageMarker?: string;
    style: "text" | "native";
  };
  notify?: { title?: string; url?: string; characterId?: string };
  /** 角色绑定的微信 bot：force 用于真实微信快捷动作结果续跑，保证第二轮仍回到微信。 */
  weixin?: { botId?: string; force?: boolean };
  /** 离线快捷动作的结果续跑快照：客户端预挂，AI 调用需回传的动作时武装 shortcut_resume */
  shortcutContinuation?: {
    request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
    replyMarker: string;
    resultMarker: string;
    imageMarker?: string;
    /** 角色 API 的图像识别开关（客户端挂快照时写入）；缺省视为开，兼容老快照 */
    visionEnabled?: boolean;
  };
  merge?: Record<string, unknown> & { sessionId?: string };
};

type ShortcutCommandRow = {
  id: string;
  status: "pending" | "claimed" | "succeeded" | "failed" | "expired" | "cancelled";
  action_name: string;
  result_mode: "none" | "text" | "image";
  result: Record<string, unknown> | null;
  error: string | null;
  expires_at: string;
};

// 【快捷动作：名称】与带参数的【快捷动作：名称({...})】都要认。参数允许换行
// （模型爱把 JSON 展开写），所以参数段用 [\s\S] 而不是 [^\n]。
/** 识图关着时代替截图进上下文的说明：不留这句话，模型面对的是空白，
 *  既不知道图回没回来，也不知道自己为什么看不见。 */
const SHORTCUT_VISION_OFF_NOTE = "（系统记录：未配置或未启用图像识别，本轮回传的图片没有交给你；请结合上一条的文字内容回应。）";

const SHORTCUT_MARKER_RE = /【快捷动作[：:]\s*([^(（）)】\n]{1,60}?)\s*(?:[(（]([\s\S]{0,2000}?)[)）])?\s*】/;
const SHORTCUT_MARKER_STRIP_RE = new RegExp(SHORTCUT_MARKER_RE.source, "g");

/** 标记括号里的 JSON 参数。写坏了就当没带参数——宁可少传，也不要整条动作失败。 */
function parseShortcutMarkerArgs(raw: string | undefined): Record<string, unknown> {
  const text = (raw ?? "").trim();
  if (!text) return {};
  // 模型爱用全角标点（中文引号/冒号/逗号），原文解析失败就按归一化后的再试一次
  const candidates = [text, text.replace(/[\u201c\u201d\u201e\u201f]/g, '"').replace(/\uff1a/g, ":").replace(/\uff0c/g, ",")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try next */ }
  }
  console.warn(`[push-generate] 快捷动作参数解析失败 raw=${text.slice(0, 200)}`);
  return {};
}

function shortcutResultText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const text = record.text ?? record.message ?? record.value;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  try { return JSON.stringify(value ?? {}); } catch { return String(value ?? ""); }
}

function formatShortcutResult(command: ShortcutCommandRow, style: "text" | "native"): string {
  const actionName = String(command.action_name || "快捷动作").replace(/"/g, "&quot;");
  const success = command.status === "succeeded";
  const detail = success
    ? shortcutResultText(command.result) || "快捷指令已执行成功。"
    : command.error || (command.status === "expired" ? "等待手机执行超时。" : `命令状态：${command.status}`);
  if (style === "native") {
    return [
      `<action_result name="${actionName}" success="${success ? "true" : "false"}">`,
      detail,
      "</action_result>",
      "工具结果已经返回给你，不要重复你之前已经说过的内容，不要再次执行相同的动作。",
    ].join("\n");
  }
  const resultTag = success
    ? `<action_result name="${actionName}">${detail}</action_result>`
    : `<action_result name="${actionName}" error="${detail.replace(/"/g, "&quot;")}"></action_result>`;
  return `以下是系统处理结果：\n${resultTag}\n请基于以上结果，继续以角色身份回复用户。不要重复你之前已经说过的内容，不要再次执行相同的动作。`;
}

function replaceMarker(value: unknown, marker: string, replacement: string): boolean {
  if (!value || typeof value !== "object") return false;
  let replaced = false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === marker) {
        value[index] = replacement;
        replaced = true;
      } else if (replaceMarker(value[index], marker, replacement)) {
        replaced = true;
      }
    }
    return replaced;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (item === marker) {
      record[key] = replacement;
      replaced = true;
    } else if (replaceMarker(item, marker, replacement)) {
      replaced = true;
    }
  }
  return replaced;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(raw);
}

/** 与网关 encryptPayload 同格式：武装续跑任务时给快照加密落库。 */
async function encryptJobPayload(plain: string, secret: string): Promise<EncryptedPayload> {
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

function injectShortcutImage(
  body: Record<string, unknown>,
  providerKind: ProviderKind,
  marker: string,
  image: { mimeType: string; base64: string } | null,
): void {
  const text = image ? "系统记录：这是快捷指令刚刚回传的截图。" : "系统记录：快捷指令截图读取失败。";
  if (providerKind === "anthropic") {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const content = (message as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;
      const index = content.findIndex(part => (part as { text?: unknown })?.text === marker);
      if (index < 0) continue;
      content.splice(index, 1,
        { type: "text", text },
        ...(image ? [{ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } }] : []),
      );
      return;
    }
  } else if (providerKind === "gemini") {
    for (const message of Array.isArray(body.contents) ? body.contents : []) {
      const parts = (message as { parts?: unknown[] }).parts;
      if (!Array.isArray(parts)) continue;
      const index = parts.findIndex(part => (part as { text?: unknown })?.text === marker);
      if (index < 0) continue;
      parts.splice(index, 1,
        { text },
        ...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }] : []),
      );
      return;
    }
  } else {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const record = message as { content?: unknown };
      if (record.content !== marker) continue;
      record.content = image ? [
        { type: "text", text },
        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "low" } },
      ] : text;
      return;
    }
  }
  replaceMarker(body, marker, text);
}

/** 在冻结请求的消息列表末尾追加一条 user 角色的系统备忘（按 provider 格式）。 */
type RecheckPlanRow = {
  plan_date: string;
  context?: Record<string, unknown>;
  decisions?: unknown[];
  items?: { kind?: string; promiseRevision?: number; time?: string; wakeId?: string; act?: boolean; intent?: string; fireAt?: number; origFireAt?: number; from?: string }[];
};

/** 挂念寄存的计划：靠 trigger_key 里的 wakeId 回查最近 32 份计划，包括历史哨兵；最新一份可能已是次日。 */
async function loadRecheckPlan(
  rest: (path: string, init?: RequestInit) => Promise<Response>,
  userId: string,
  characterId: string,
  wakeId: string,
): Promise<{ row: RecheckPlanRow | null; item: NonNullable<RecheckPlanRow["items"]>[number] | null }> {
  if (!characterId || !wakeId) return { row: null, item: null };
  const response = await rest(
    `push_recheck_plans?user_id=eq.${encodeURIComponent(userId)}`
    + `&character_id=eq.${encodeURIComponent(characterId)}`
    + "&select=plan_date,context,decisions,items&order=plan_date.desc&limit=32",
  );
  if (!response.ok) throw new Error("约定计划读取失败");
  const rows = await response.json() as RecheckPlanRow[];
  const sentinel = rows.find(row => row.context?.sentinelWakeId === wakeId);
  if (sentinel) return { row: sentinel, item: null };
  for (const row of rows) {
    const hit = (row.items || []).find(item => item.wakeId === wakeId);
    if (hit) {
      if (hit.kind !== "promise") return { row, item: hit };
      const threads = new Map<string, Record<string, unknown>>();
      for (const p of rows) for (const t of Array.isArray(p.context?.threads) ? p.context.threads : []) {
        const previous = threads.get(t.id);
        if (!previous || Number(t.revision || 1) > Number(previous.revision || 1)
          || Number(t.revision || 1) === Number(previous.revision || 1) && Number(t.at || 0) > Number(previous.at || 0)) threads.set(t.id, t);
      }
      return { row: { ...row, context: { ...row.context, ...rows[0]?.context, threads: [...threads.values()] } }, item: hit };
    }
  }
  return { row: rows[0] || null, item: null };
}

// ── 挂念：TA此刻的状态。预约里冻着的是编排那会儿的样子，到点了按寄存的日程和「情况」
// 重算一遍。算法与挂念 index.html 的 energyAt / moodNow / currentStep 一致，改一处要同步另一处。
type GuanianSched = { time?: string; end?: string; title?: string; place?: string; cost?: number; mood?: string; busy?: boolean; steps?: { time?: string; what?: string }[] };
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

// 忙与睡：TA此刻正做着顾不上看手机的事，返回那件事的结束时刻；否则空串。
// 新日程由生成时模型标 busy；老日程按标题猜（词表来自陪伴插件的 busy_reply_gate）。
const GUANIAN_BUSY_RE = /上课|课堂|听课|自习|复习|预习|写作业|做作业|赶作业|做题|考试|测验|开会|会议|值班|实习|训练|排练|实验|赶稿|写稿|编程|写代码|专注|集中精神|通勤|赶路|开车|面试|汇报|手术|门诊/;
const GUANIAN_NOT_BUSY_RE = /睡觉|睡眠|午睡|午休|补觉|休息|发呆|摸鱼|放松|吃饭|用餐|散步|刷视频|看番|打游戏|玩游戏|聊天|自由时间|准备睡|洗漱|刚醒|起床|看剧|逛/;
function guanianBusyUntil(day: GuanianDay, hm: string): string {
  const sched = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");
  let cur: GuanianSched | null = null;
  for (const it of sched) if (String(it.time) <= hm) cur = it;
  if (!cur) return "";
  const end = typeof cur.end === "string" && cur.end > String(cur.time) ? cur.end : "";
  if (!end || hm >= end) return "";
  const title = String(cur.title || "");
  const busy = typeof cur.busy === "boolean" ? cur.busy : (GUANIAN_BUSY_RE.test(title) && !GUANIAN_NOT_BUSY_RE.test(title));
  return busy ? end : "";
}
// 本地 HH:MM → 下一次到达它的 UTC 毫秒（已过就算明天的）
function guanianLocalHMToMs(hm: string, tzMin: number, nowMs: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return 0;
  const local = new Date(nowMs + tzMin * 60_000);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(m[1]), Number(m[2])) - tzMin * 60_000;
  if (t <= nowMs) t += 86_400_000;
  return t;
}
function guanianRoll(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) % 100;
}

type GuanianAffection = { score?: number; tier?: string; relation?: string } | null | undefined;
type GuanianThread = { kind?: string; text?: string; due?: number; yearly?: boolean; done?: boolean };
// 惦记账本里还活着的几件，到点发消息时让TA带着（精简版：只看没了结、没过期的）
function guanianThreadLines(threads: unknown, nowMs: number, tzMin: number): string[] {
  if (!Array.isArray(threads)) return [];
  const kindName: Record<string, string> = { topic: "话头", promise: "约定", date: "日子" };
  const out: string[] = [];
  for (const t of threads as GuanianThread[]) {
    if (!t || t.done || !t.text) continue;
    let due = Number(t.due) || 0;
    if (due && t.yearly) {
      const d = new Date(due + tzMin * 60_000), n = new Date(nowMs + tzMin * 60_000);
      d.setUTCFullYear(n.getUTCFullYear());
      if (d.getTime() - tzMin * 60_000 < nowMs - 86_400_000) d.setUTCFullYear(n.getUTCFullYear() + 1);
      due = d.getTime() - tzMin * 60_000;
    }
    if (due && nowMs > due + 86_400_000) continue;
    const local = due ? new Date(due + tzMin * 60_000) : null;
    const n = new Date(nowMs + tzMin * 60_000);
    const sameDay = local && local.getUTCFullYear() === n.getUTCFullYear() && local.getUTCMonth() === n.getUTCMonth() && local.getUTCDate() === n.getUTCDate();
    const when = !local ? "" : sameDay
      ? (t.kind === "date" ? "今天" : (due < nowMs ? "今天 " : "今天 ") + `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}` + (due < nowMs ? "，已经过了" : ""))
      : `${local.getUTCMonth() + 1}/${local.getUTCDate()}`;
    out.push(`${kindName[String(t.kind)] || "话头"}·${t.text}${when ? "（" + when + "）" : ""}`);
    if (out.length >= 4) break;
  }
  return out;
}
function guanianStateNote(day: GuanianDay, nowMs: number, quietStart?: string, quietEnd?: string, affection?: GuanianAffection, threads?: string[]): string {
  const tz = Number.isFinite(Number(day.tz)) ? Number(day.tz) : 0;
  const local = new Date(nowMs + tz * 60_000);
  const h = local.getUTCHours() + local.getUTCMinutes() / 60;
  const nowHM = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const sched = (Array.isArray(day.schedule) ? day.schedule : []).filter(it => it && typeof it.time === "string");

  const condWeight = (c: GuanianCond) => {
    const half = Math.max(10, Number(c.halfLifeMin) || 180) * 60_000;
    return Math.pow(0.5, Math.max(0, nowMs - (Number(c.startAt) || 0)) / half);
  };
  const conds = (Array.isArray(day.conds) ? day.conds : [])
    .map(c => ({ c, w: condWeight(c) }))
    .filter(x => x.w > 0.08 && (Number(x.c.startAt) || 0) <= nowMs)
    .sort((a, b) => (b.w * (Number(b.c.intensity) || 50)) - (a.w * (Number(a.c.intensity) || 50)));

  let done: GuanianSched | null = null;
  for (const it of sched) if (String(it.time) <= nowHM) done = it;
  const next = sched.find(it => String(it.time) > nowHM) || null;
  const asleep = guanianAsleep(day, nowHM, quietStart, quietEnd);
  // 与 App 端 phaseAt / currentDoing 同步（过零点还没睡的那段也是睡前）
  const bedHM = /^\d{2}:\d{2}$/.test(String(day.bed || "")) ? String(day.bed) : String(quietStart || "");
  const wakeHM = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(quietEnd || "");
  const lateNight = !done && !!bedHM && !!wakeHM && bedHM < wakeHM && nowHM < bedHM;
  const over = lateNight || !!(done && done.end && done.end > String(done.time) && nowHM >= done.end);
  const doing = lateNight ? "睡前自己待着，准备睡了"
    : !done ? (day.doing || "起床后的时间")
    : !over ? String(done.title || "")
    : next ? `歇着（刚忙完${done.title || ""}）` : "睡前自己待着，准备睡了";
  let step = "";
  if (done && !over && !asleep && Array.isArray(done.steps)) {
    for (const x of done.steps) if (x && typeof x.time === "string" && x.time <= nowHM) step = String(x.what || "");
  }
  // 与 App 端 currentPlace 同步：地点跟着最后一件已开始的日程走，第一件没开始才用早上的
  const place = String((done && done.place) || day.location || "");

  const hh = h < 5 ? h + 24 : h;
  let energy = Number.isFinite(Number(day.energy)) ? Number(day.energy) : 60;
  const hmNum = (v: unknown): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ""));
    return m ? Number(m[1]) + Number(m[2]) / 60 : null;
  };
  // 与面板 energyAt 同步：cost 按进度记账、状况负向合计封顶 -12、缓降从起床时刻起算
  for (const it of sched) {
    if (h >= 5 && String(it.time) > nowHM) continue;
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

  const cand: { text: string; from: string; w: number }[] = [];
  const top = conds[0];
  if (top && top.c.mood) cand.push({ text: String(top.c.mood), from: String(top.c.cause || "刚才聊的"), w: top.w * (Number(top.c.intensity) || 50) / 100 });
  if (done && done.mood) {
    const [dh, dm] = String(done.time).split(":").map(Number);
    const agoMs = Math.max(0, (h * 60 - (dh * 60 + dm)) * 60_000);
    cand.push({ text: String(done.mood), from: String(done.title || ""), w: Math.pow(0.5, agoMs / (90 * 60_000)) * 0.6 });
  }
  cand.sort((a, b) => b.w - a.w);
  const hit = cand.find(x => x.text && x.w > 0.15);
  const base = String(day.mood || "");
  const moodLine = hit
    ? `${hit.text}（因为${hit.from || "刚才那阵"}；今天的底色是「${base || "平常"}」）`
    : `${base || "说不上来"}（今天一整天的底色）`;

  const lines = [
    `[系统备忘：这不是对方发来的消息。这是你此刻（本地时间 ${nowHM}）的状态，提示词里若有更早的「挂念 · 某某时刻的状态」以这份为准：`,
    asleep
      ? `在睡觉${day.wake ? "（" + day.wake + " 左右才醒）" : ""}：这会儿不会看到消息；真被吵醒也只是迷迷糊糊回一两句，说不了长话。`
      : `在做的事：${doing || "没什么特别的"}${step ? "，具体是在" + step : ""}${place ? "；人在" + place : ""}`,
    `情绪：${moodLine}`,
    `精力：${energy}%${energy < 25 ? "——很累了，话短、反应慢、容易敷衍" : energy < 50 ? "——有点乏" : energy < 80 ? "——还行" : "——精神很好"}`,
  ];
  if (asleep) { if (day.wake) lines.push(`接下来：${day.wake} 起床`); }
  else if (next) lines.push(`接下来：${next.time} ${next.title || ""}`);
  else if (over && day.bed) lines.push(`接下来：${day.bed} 睡觉`);
  if (affection && (affection.tier || affection.relation)) {
    lines.push(`对TA：${affection.tier || "说不上"}；两人现在的关系：${affection.relation || "没定"}。说话的分寸按这个来。`);
  }
  if (threads && threads.length) lines.push(`心里还挂着：${threads.join("；")}。和这次要说的事有关就顺口带上，无关就别硬提。`);
  lines.push("这些是你自己的状态，说话时自然带出来就行，别报数字、别列清单、别提这段文字。]");
  return lines.join("\n");
}

function appendUserNote(body: Record<string, unknown>, providerKind: ProviderKind, note: string): boolean {
  if (providerKind === "gemini") {
    const contents = body.contents;
    if (!Array.isArray(contents)) return false;
    contents.push({ role: "user", parts: [{ text: note }] });
    return true;
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  if (providerKind === "anthropic") {
    messages.push({ role: "user", content: [{ type: "text", text: note }] });
  } else {
    messages.push({ role: "user", content: note });
  }
  return true;
}

// 与预约 ID 的稳定抽样一起使用：只在空闲、实际准备发送时抽一次，忙时不反复抽。
function guanianWaitingChance(nowMs: number, originalAt: number, halfLifeMin: number): number {
  const age = Math.max(0, nowMs - originalAt) / 60000;
  const halfLife = Number.isFinite(halfLifeMin) && halfLifeMin > 0 ? halfLifeMin : 180;
  return Math.pow(0.5, age / halfLife);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const DAILY_GENERATION_CAP = 50;

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 200 });

  const { jobId, token, action } = await req.json().catch(() => ({})) as { jobId?: string; token?: string; action?: string };
  if ((!jobId && action !== "capabilities") || !token) return new Response("bad request", { status: 400 });

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });

  const secretResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key,site_origin&limit=1");
  const secretRows = secretResponse.ok ? await secretResponse.json() as { cron_secret?: string | null; payload_key?: string | null; site_origin?: string | null }[] : [];
  const cronSecret = secretRows[0]?.cron_secret || "";
  const payloadKey = secretRows[0]?.payload_key || "";
  const siteOrigin = secretRows[0]?.site_origin || "";
  if (!cronSecret || String(token) !== cronSecret) {
    return new Response("forbidden", { status: 403 });
  }

  if (action === "capabilities") return Response.json({ capabilities: ["deferred-reply-v1", "deferred-reply-v2", "chat-silence-v1", "guanian-history-v1", "promise-tasks-v2", "scheduler-state-v1", "history-window-v1"] });
  if (!jobId) return new Response("bad request", { status: 400 });

  const claim = await rest(`push_jobs?id=eq.${encodeURIComponent(jobId)}&status=eq.pending&kind=neq.bridge_scan&execute_at=lte.${encodeURIComponent(new Date().toISOString())}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() }),
  });
  const claimed = claim.ok ? await claim.json() as JobRow[] : [];
  const job = claimed[0];
  if (!job) return new Response("already claimed", { status: 200 });

  const previousRetries = Number(/^\[retry:(\d+)\]/.exec(String(job.result_note || ""))?.[1]) || 0;
  let deferredReceipt: { revision?: number; acceptedMessageId?: string } | undefined;
  let resultStored = false;
  const finish = (status: "done" | "failed", note: string) => rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status, result_note: note.slice(0, 300), updated_at: new Date().toISOString(),
      ...(job.trigger_key.startsWith("deferred:") && status === "done" ? { payload: { receipt: deferredReceipt } } : {}) }),
  }).catch(() => undefined);

  // 分段进度：卡死时 result_note 会停在最后完成的一步，精确定位死点
  const startedAt = Date.now();
  const progress = (note: string) => rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ result_note: `[retry:${previousRetries}] [${Math.round((Date.now() - startedAt) / 1000)}s] ${note}`.slice(0, 300), updated_at: new Date().toISOString() }),
  }).catch(() => undefined);

  // pg_net 的请求超时只有几秒：必须立即响应，重活放进 waitUntil 后台继续。
  let generationLease: { sessionId: string; token: string } | null = null;
  const retry = async (note: string, waitUntil?: number, permanent = false) => {
    const count = waitUntil ? previousRetries : previousRetries + 1;
    if (permanent || count >= 6) return finish("failed", `[retry:${count}] stopped: ${note}；修复后重试任务，已保存正文保留`);
    return rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.running`, { method: "PATCH", body: JSON.stringify({
      status: "pending", execute_at: new Date(waitUntil || Date.now() + Math.min(30, 2 ** (count - 1)) * 60000).toISOString(),
      result_note: `[retry:${count}] ${note}`, updated_at: new Date().toISOString(),
    }) });
  };
  const runJob = async (): Promise<void> => {
  try {
    if (!payloadKey) {
      await finish("failed", "payload_key missing (open push settings once to bootstrap)");
      return;
    }
    const payload = JSON.parse(await decryptPayload(job.payload, payloadKey)) as JobPayload;
    deferredReceipt = payload.deferredReply ? { revision: payload.deferredReply.revision, acceptedMessageId: String(payload.merge?.replyAfterLocalMessageId || "") } : undefined;
    resultStored = !!payload.generatedResponse;
    // Saved tasks can later supply templates: keep transient history/state notes out.
    const templateRequest = JSON.parse(JSON.stringify(payload.request)) as JobPayload["request"];
    const saveGeneratedResponse = async () => {
      const encrypted = await encryptPayload(JSON.stringify({ ...payload, request: templateRequest }), payloadKey);
      for (let attempt = 0; attempt < 3; attempt++) {
        const saved = await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.running`, {
          method: "PATCH", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ payload: encrypted, updated_at: new Date().toISOString() }),
        }).catch(() => null);
        if (saved?.ok && (await saved.json()).length) { resultStored = true; return; }
      }
      throw new Error("生成结果暂存未确认；暂停自动生成，请检查云端存储");
    };

    if (job.kind !== "template" && payload.merge?.sessionId) {
      const sessionId = String(payload.merge.sessionId), token = job.id + ":" + crypto.randomUUID();
      const lease = await rest("rpc/push_generation_lease", { method: "POST", body: JSON.stringify({
        p_user_id: job.user_id, p_session_id: sessionId, p_token: token, p_action: "claim",
      }) });
      if (!lease.ok) { await retry("会话租约不可用；请执行最新 schema 12", undefined, [400,404].includes(lease.status)); return; }
      if (await lease.json() !== true) { await retry("hold: 同一会话正在生成", Date.now() + 60000); return; }
      generationLease = { sessionId, token };
      const existing = await rest(`push_outbox?job_id=eq.${encodeURIComponent(job.id)}&select=id&limit=1`);
      if (!existing.ok) { await retry("hold: 无法确认这轮是否已经生成"); return; }
      if ((await existing.json()).length) { await finish("done", "generated previously; recovered"); return; }
    }
    if (payload.deferredReply && !payload.generatedResponse) {
      // A previous run may have written its reply and died before marking the job done.
      const delivered = await rest(`push_outbox?job_id=eq.${encodeURIComponent(job.id)}&select=id&limit=1`);
      if (!delivered.ok) { await finish("failed", "cannot confirm deferred delivery"); return; }
      if ((await delivered.json() as unknown[]).length) { await finish("done", "deferred reply already delivered"); return; }
      const timing = advanceCloudReplyTiming(payload.deferredReply.timing, Date.now());
      if (!timing.ready) {
        payload.deferredReply.timing = timing;
        const held = await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.running`, {
          method: "PATCH", body: JSON.stringify({ status: "pending", execute_at: new Date(timing.nextAt).toISOString(),
            payload: await encryptPayload(JSON.stringify(payload), payloadKey), result_note: "deferred: waiting for an opportunity",
            updated_at: new Date().toISOString() }),
        });
        if (!held.ok) await finish("failed", "deferred reschedule failed");
        return;
      }
      if (!appendUserNote(payload.request.body, payload.request.providerKind, `<reply_timing>\n${timing.note}\n不要提这段说明本身。\n</reply_timing>`)) {
        await finish("failed", "deferred prompt unsupported");
        return;
      }
    }
    let shortcutStoragePath = "";

    // 模板预约（push.freeze）只是给云函数借提示词用的，到点即作废，永远不生成。
    if (job.kind === "template") {
      await finish("done", "template expired");
      return;
    }

    if (job.kind === "shortcut_resume" && payload.shortcut) {
      const commandResponse = await rest(
        `push_shortcut_commands?id=eq.${encodeURIComponent(payload.shortcut.commandId)}`
        + `&user_id=eq.${encodeURIComponent(job.user_id)}`
        + "&select=id,status,action_name,result_mode,result,error,expires_at&limit=1",
      );
      const commandRows = commandResponse.ok ? await commandResponse.json() as ShortcutCommandRow[] : [];
      const command = commandRows[0];
      if (!command) {
        await finish("failed", "shortcut command missing");
        return;
      }

      if (command.status === "pending" || command.status === "claimed") {
        const expiresAt = Date.parse(command.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
          const retryAt = new Date(Math.min(expiresAt + 5_000, Date.now() + 15_000)).toISOString();
          await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              status: "pending",
              execute_at: retryAt,
              result_note: "waiting for shortcut result",
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        command.status = "expired";
        command.error = "等待手机执行超时。";
        await rest(`push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}&status=in.(pending,claimed)`, {
          method: "PATCH",
          body: JSON.stringify({ status: "expired", error: command.error, updated_at: new Date().toISOString() }),
        }).catch(() => undefined);
      }

      const resultContent = formatShortcutResult(command, payload.shortcut.style);
      if (!replaceMarker(payload.request.body, payload.shortcut.resultMarker, resultContent)) {
        await finish("failed", "shortcut result marker missing");
        return;
      }

      if (payload.shortcut.imageMarker) {
        let image: { mimeType: string; base64: string } | null = null;
        const result = command.result && typeof command.result === "object" ? command.result : {};
        const rawPath = typeof result.storagePath === "string" ? result.storagePath : "";
        const expectedPrefix = `${job.user_id}/${command.id}.`;
        if (command.status === "succeeded" && rawPath.startsWith(expectedPrefix) && /\.(?:jpg|png|webp)$/.test(rawPath)) {
          const storagePath = rawPath.split("/").map(encodeURIComponent).join("/");
          const file = await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${storagePath}`, {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
          });
          if (file.ok) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length > 0 && bytes.length <= 8 * 1024 * 1024) {
              image = {
                mimeType: file.headers.get("content-type") || String(result.mimeType || "image/jpeg"),
                base64: bytesToBase64(bytes),
              };
              shortcutStoragePath = storagePath;
            }
          }
        }
        injectShortcutImage(payload.request.body, payload.request.providerKind, payload.shortcut.imageMarker, image);
      }
    }

    const subsResponse = await rest(`push_subscriptions?user_id=eq.${encodeURIComponent(job.user_id)}&select=endpoint,p256dh,auth`);
    const subs = subsResponse.ok ? await subsResponse.json() as SubscriptionRow[] : [];
    if (subs.length === 0 && payload.weixin?.force !== true && !payload.generatedResponse) {
      await finish("done", "no_subscription");
      return;
    }

    // 硬闸：每账号每天最多 50 条服务端兜底生成，超出只存任务记录不烧 token。
    // 只统计 push-generate 真正生成的回箱行，不让现实桥的纯存档行占用额度。
    const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const capResponse = await rest(
      `push_outbox?user_id=eq.${encodeURIComponent(job.user_id)}&created_at=gte.${encodeURIComponent(dayStart)}&meta->>pushGenerated=eq.true&select=id&limit=${DAILY_GENERATION_CAP + 1}`,
    );
    const todayRows = capResponse.ok ? await capResponse.json() as unknown[] : [];
    if (todayRows.length >= DAILY_GENERATION_CAP && !payload.generatedResponse) {
      await finish("done", `daily cap (${DAILY_GENERATION_CAP}) reached`);
      return;
    }

    let cloudHistory: GuanianCloudHistory | null = null;
    if ((job.kind === "timed_task" || job.kind === "followup" || payload.deferredReply) && payload.merge?.sessionId) {
      try {
        cloudHistory = await readGuanianCloudHistory(rest, job.user_id, String(payload.merge.sessionId));
        if (payload.deferredReply && !payload.generatedResponse) {
          const latestUser = [...cloudHistory.messages].reverse().find(m => m.role === "user");
          if (latestUser && Date.parse(latestUser.message_at) > Date.parse(String(payload.merge.replyAfterCreatedAt || "1970-01-01"))) {
            payload.merge.replyAfterLocalMessageId = latestUser.id;
            payload.merge.replyAfterCreatedAt = latestUser.message_at;
            deferredReceipt = { revision: payload.deferredReply.revision, acceptedMessageId: latestUser.id };
          }
        }
      } catch { await retry("hold: 最新聊天读取失败，稍后核对"); return; }
    }

    // ── 发送前复核：到点了再综合判一次「这条现在发合不合适」。三个信号全部只读已有
    // 数据、不调模型：未回应轮数、你是不是正聊着、离TA上一条主动多久。加权成「不合时宜度」，
    // 过阈值就取消这次生成。判据写回挂念的计划，面板点开那条时刻就能展开看。
    // 阈值来自挂念上传的 push_recheck_plans.context.presend*；匹配不到挂念的计划
    // （不是它挂的预约）就只跑老的未回应硬规则。镜像没开（查不到会话记录）则一道都不拦。
    // 轮数口径与挂念本地一致：用户最后一条之后角色的连续主动按「轮」算（相邻 3 分钟归一轮），
    // 最新一轮要晾满 30 分钟才计数。数据源是聊天镜像 + 离线期间本服务代发的 push_outbox。
    const guanianCharacterId = job.kind === "timed_task" ? (payload.notify?.characterId || "") : "";
    const guanianWakeId = job.kind === "timed_task" && job.trigger_key.startsWith("timedwake:") ? job.trigger_key.slice(10) : "";
    let guanianPlan: Awaited<ReturnType<typeof loadRecheckPlan>>;
    try { guanianPlan = await loadRecheckPlan(rest, job.user_id, guanianCharacterId, guanianWakeId); }
    catch { await retry("hold: 约定计划读取失败"); return; }
    // 挂念任务必须仍属于有效计划。不能把丢失关联的旧预约当成普通定时消息放行。
    const isGuanianWake = /^timed_wake_capp_(?:app_)?gua\.nian_/.test(guanianWakeId);
    if (guanianWakeId && (guanianPlan.row?.context?.sentinelWakeId === guanianWakeId
      || isGuanianWake && /_sentinel_\d+_[a-z0-9]+$/i.test(guanianWakeId))) {
      await finish("done", "guanian skip: 后台模板预约，不生成聊天消息"); return;
    }
    if (isGuanianWake && !guanianPlan.item) {
      await finish("done", "guanian skip: 未找到有效计划，旧预约已停止"); return;
    }
    if (guanianHasWindow(guanianPlan.row?.context) && payload.merge?.sessionId) {
      try { cloudHistory = await readGuanianCloudHistory(rest, job.user_id, String(payload.merge.sessionId), guanianPlan.row?.context); }
      catch { await retry("hold: 线上轮次或线下摘要读取失败，稍后核对"); return; }
    }
    const planTz = guanianContextTimezone((guanianPlan.row?.context || {}) as Record<string, unknown>, Date.now());
    const historyTz = guanianTimezone(planTz, payload.merge?.tzOffsetMin, (payload.merge?.quietWin as { tzOffsetMin?: number } | undefined)?.tzOffsetMin);
    if (guanianPlan.row && historyTz === null) { await retry("时区资料缺失：请打开挂念重新同步计划", undefined, true); return; }
    if (guanianPlan.row?.context?.day && historyTz !== null) (guanianPlan.row.context.day as GuanianDay).tz = historyTz;
    if (cloudHistory && !payload.generatedResponse) appendUserNote(payload.request.body, payload.request.providerKind,
      `[最新云端聊天事实，非用户消息；${historyTz === null ? "当地时区未知，下方仅以 UTC 标示，不得推断当地钟点" : `统一时区 UTC${historyTz >= 0 ? "+" : ""}${historyTz / 60}，当前当地时间 ${new Date(Date.now() + historyTz * 60000).toISOString().slice(0,16)}`}。以下时间是生成时间，不代表用户已读；与旧快照冲突时以这里为准。]\n`
      + guanianHistoryText(cloudHistory, historyTz ?? 0, 80, guanianPlan.row?.context));
    // decisions 是读-改-写，手里这份是任务开头读到的，push-recheck 可能同时在写。
    // 落库前重取一次，把丢记录的窗口从整个任务时长缩到一次请求。
    const appendDecision = async (entry: Record<string, unknown>): Promise<void> => {
      const row = guanianPlan.row;
      if (!row || !guanianCharacterId) return;
      await rest("rpc/push_append_recheck_decision", { method: "POST", body: JSON.stringify({
        p_user_id: job.user_id, p_character_id: guanianCharacterId, p_date: row.plan_date,
        p_entry: { ...entry, wakeId: guanianWakeId },
      }) }).catch(() => undefined);
    };
    if (guanianPlan.item?.act === false) {
      await finish("done", "guanian skip: 这条念头已在复核中作罢");
      return;
    }
    const frozenPromise = payload.merge?.guanianPromise as { id?: string; revision?: number } | undefined;
    const isPromise = guanianPlan.item?.kind === "promise" || !!frozenPromise?.id;
    const promiseIsCurrent = (p: Awaited<ReturnType<typeof loadRecheckPlan>>) => {
      if (!isPromise) return true;
      if (!p.item || p.item.kind !== "promise" || p.item.act === false) return false;
      const ts = p.row?.context?.threads;
      const id = frozenPromise?.id || guanianPlan.item?.from;
      const revision = Number(frozenPromise?.revision || guanianPlan.item?.promiseRevision || 1);
      const t = Array.isArray(ts) ? ts.find(t => t.id === id) : null;
      return !!t && !t.done && !["completed", "cancelled"].includes(t.status)
        && Number(t.revision || 1) === revision && p.item.from === id && Number(p.item.promiseRevision || 1) === revision
        && !(Number(t.mentionedAt) > 0) && !/said:/.test(String(t.nudge || ""))
        && !(cloudHistory?.outputs || []).some(o => {
          const event = o.meta?.guanianContext as { eventId?: string; revision?: number } | undefined;
          return event?.eventId === id && Number(event.revision || 1) === revision;
        });
    };
    if (!promiseIsCurrent(guanianPlan)) { await finish("done", "promise skip: 约定已改期、完成或取消"); return; }
    if (!payload.generatedResponse && guanianPlan.item?.kind !== "promise" && cloudHistory && guanianPlan.item) {
      const gap = Math.max(0, Number(guanianPlan.row?.context?.minGapMin) || 0) * 60000;
      const nextAt = guanianLastProactiveAt(cloudHistory) + gap;
      if (Date.now() < nextAt) {
        await appendDecision({ at: Date.now(), kind: "hold", time: guanianPlan.item.time, by: "cloud", note: "主动消息间隔未到，等待至 " + new Date(nextAt).toISOString() });
        await retry("hold: 等待主动消息间隔", nextAt); return;
      }
    }
    if (!payload.generatedResponse && job.kind === "timed_task" && guanianPlan.item?.kind !== "promise") {
      const cooldownRounds = Number(payload.merge?.cooldownRounds);
      const coolTarget = Number.isFinite(cooldownRounds) && cooldownRounds > 0 ? cooldownRounds : 0;
      const mirrorSessionId = typeof payload.merge?.sessionId === "string" ? payload.merge.sessionId : "";
      if (mirrorSessionId) {
        try {
          const mirrorRows = [...(cloudHistory?.messages || [])].reverse();
          if (mirrorRows.length > 0) {
            const nowMs = Date.now();
            const rounds = cloudHistory ? guanianHistoryRounds(cloudHistory, nowMs) : 0;
            const lastProactiveAt = cloudHistory ? guanianLastProactiveAt(cloudHistory) : 0;
            const newestUser = mirrorRows.find(row => row.role === "user");
            const lastUserAt = newestUser ? Date.parse(newestUser.message_at) : NaN;

            // 挂念的这条时刻：顺带拿到用户调的阈值
            const planRow = guanianPlan.row;
            const planItem = guanianPlan.item;
            const planContext = planRow?.context || {};
            const cfg = (key: string, def: number): number => {
              const value = Number(planContext[key]);
              return Number.isFinite(value) && value >= 0 ? value : def;
            };
            // 落在窗口内就按剩余比例给压力：刚说完话是 100，窗口边缘是 0
            const closeness = (elapsedMs: number, windowMin: number): number => {
              const span = windowMin * 60_000;
              if (!(span > 0) || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= span) return 0;
              return Math.round((1 - elapsedMs / span) * 100);
            };
            const pr = coolTarget > 0 ? Math.min(100, Math.round(rounds / coolTarget * 100)) : 0;
            const pt = Number.isFinite(lastUserAt) ? closeness(nowMs - lastUserAt, cfg("presendTalkingMin", 15)) : 0;
            const pg = lastProactiveAt ? closeness(nowMs - lastProactiveAt, cfg("presendGapMin", 60)) : 0;
            const press = Math.round(pr * 0.4 + pt * 0.4 + pg * 0.2);
            const maxPress = cfg("presendMax", 70);
            const hardSkip = coolTarget > 0 && rounds >= coolTarget;
            const blocked = hardSkip
              ? `连续 ${rounds} 轮没等到你回`
              : (planItem && press >= maxPress ? `此刻不合时宜（${press}%）` : "");

            // 判据写回计划：不管发没发都写，面板要能看到"通过"的那次是几分过的
            if (planRow && planItem) {
              await appendDecision({
                at: nowMs,
                kind: "presend",
                time: planItem.time || "",
                by: "cloud",
                note: blocked || `到点复核通过（不合时宜度 ${press}%）`,
                blocked: !!blocked,
                scores: { pr, pt, pg, press, rounds, max: maxPress },
              });
            }

            if (blocked) {
              await finish("done", `presend skip: ${blocked} (press ${press}%, rounds ${rounds})`);
              return;
            }
          }
        } catch { /* 复核查询失败不阻塞生成，按原计划发 */ }
      }
    }

    // ── 挂念：到点了把TA此刻的状态补进请求。只对挂念挂的预约（计划里查得到 wakeId）生效，
    // 计划里没寄 day 的老版本 App 照旧。
    // 挂念的哨兵预约只是给云端复核当凭据模板的，到点不生成。真到了这一步说明挂念两天没编排过，
    // 计划早已过了 cron 的派发窗口，作废就好。
    if (!payload.generatedResponse && guanianPlan.item && guanianPlan.row?.context?.day && typeof guanianPlan.row.context.day === "object") {
      // 编排时排开了睡眠窗，但聊天改日程或别的路径挂上的时刻可能落在TA睡着之后：睡着的人不发消息。
      const ctxQuiet = guanianPlan.row.context as { quietStart?: unknown; quietEnd?: unknown };
      const qs = typeof ctxQuiet.quietStart === "string" ? ctxQuiet.quietStart : undefined;
      const qe = typeof ctxQuiet.quietEnd === "string" ? ctxQuiet.quietEnd : undefined;
      const day = guanianPlan.row.context.day as GuanianDay;
      const tzMin = Number.isFinite(Number(day.tz)) ? Number(day.tz) : 0;
      const localNow = new Date(Date.now() + tzMin * 60_000);
      const localHM = `${String(localNow.getUTCHours()).padStart(2, "0")}:${String(localNow.getUTCMinutes()).padStart(2, "0")}`;
      const ctx = guanianPlan.row.context as Record<string, unknown>;
      const cnum = (key: string, def: number): number => {
        const v = Number(ctx[key]);
        return Number.isFinite(v) && v >= 0 ? v : def;
      };
      const nowMs = Date.now();
      // 旧 busyMaxHoldMin 现在表示等待概率的半衰期；until 不再是强制截止。
      const pi = guanianPlan.item;
      const origFireAt = Number(pi.origFireAt) || Number(pi.fireAt) || nowMs;
      // 忙完 / 醒来再等多久不取整：按设定值上下浮动四成，种子用任务 id，同一条重判不会漂
      const bufferMs = cnum("busyBufferMin", 10) * 60_000 * (0.6 + guanianRoll(job.id + ":buffer") / 100 * 0.8);
      // 押后 = 这条任务改回 pending、到点时刻往后挪；判据记进计划，面板能看到「押后到几点」
      const hold = async (untilMs: number, note: string): Promise<void> => {
        await appendDecision({ at: nowMs, kind: "hold", time: guanianPlan.item?.time || "", by: "cloud", note, until: untilMs, blocked: false });
        await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "pending", execute_at: new Date(untilMs).toISOString(), result_note: `hold: ${note}`.slice(0, 300), updated_at: new Date().toISOString() }),
        }).catch(() => undefined);
      };
      let sleepy = false;
      if (guanianAsleep(day, localHM, qs, qe)) {
        const mode = pi.kind === "promise" ? 1 : cnum("sleepMode", 0);
        if (mode === 1) {
          const wakeHM = /^\d{2}:\d{2}$/.test(String(day.wake || "")) ? String(day.wake) : String(qe || "");
          const untilMs = guanianLocalHMToMs(wakeHM, tzMin, nowMs) + bufferMs;
          if (untilMs > nowMs) {
            await hold(untilMs, `TA睡着了，押到起床后（${wakeHM}）再发`);
          } else {
            await finish("failed", "guanian wake time unavailable");
          }
          return;
        }
        if (mode === 2) {
          const roll = guanianRoll(job.id), prob = cnum("sleepWakeProb", 18);
          if (roll >= prob) {
            await finish("done", `guanian asleep (roll ${roll} >= ${prob})`);
            return;
          }
          sleepy = true;
        } else {
          await finish("done", "guanian asleep");
          return;
        }
      }
      if (!sleepy && cnum("busyHold", 0) > 0) {
        const busyEnd = guanianBusyUntil(day, localHM);
        if (busyEnd) {
          const untilMs = guanianLocalHMToMs(busyEnd, tzMin, nowMs) + bufferMs;
          await hold(untilMs, `TA正忙着顾不上，等 ${busyEnd} 忙完后再判断`);
          return;
        }
      }
      const chance = pi.kind === "promise" ? 1 : guanianWaitingChance(nowMs, origFireAt, cnum("busyMaxHoldMin", 180));
      const roll = guanianRoll(job.id + ":waiting") / 100;
      const cooled = roll >= chance;
      await appendDecision({ at: nowMs, kind: "freshness", time: pi.time || "", by: "cloud",
        note: `等待 ${Math.max(0, Math.round((nowMs - origFireAt) / 60000))} 分钟，保留发送概率 ${Math.round(chance * 100)}%` + (cooled ? "，这次念头淡去了" : "，继续核对事实"),
        blocked: cooled, chance: Math.round(chance * 100) });
      if (cooled) {
        await finish("done", "guanian skip: 等待后念头淡去了");
        return;
      }
      try {
        const aff = ctx.affection && typeof ctx.affection === "object" ? ctx.affection as GuanianAffection : null;
        let note = guanianStateNote(day, nowMs, qs, qe, aff, guanianThreadLines(ctx.threads, nowMs, tzMin));
        if (sleepy) note += "\n（TA本来睡着了，半夜迷迷糊糊醒了一下想起你：只说一两句、带着困意、说完就要接着睡。）";
        if (appendUserNote(payload.request.body, payload.request.providerKind, note)) {
          await progress("context patched: guanian state" + (sleepy ? " (sleepy)" : ""));
        }
      } catch { /* 状态算不出来就按冻结快照发 */ }
    }

    if (guanianPlan.item && !payload.generatedResponse) {
      const topic = guanianPlan.item;
      const threads = guanianPlan.row?.context?.threads;
      if (topic.from && Array.isArray(threads) && threads.some(t => t && t.id === topic.from && t.done === true)) {
        await finish("done", "guanian skip: 挂着的这件事已经了结");
        return;
      }
      // 最新聊天是判断事实的依据；读取失败时稍后重试，不能拿旧快照重复问。
      const sid = payload.merge?.sessionId;
      if (sid) {
        const tz = historyTz;
        appendUserNote(payload.request.body, payload.request.providerKind,
          `[挂念发送前的事实核对，不是用户消息]\n当前当地时间：${new Date(Date.now() + tz * 60000).toISOString().slice(0,16)}\n原念头：${topic.intent || "按上文预约意图"}\n最新聊天见上方唯一一份「最新云端聊天事实」，不可编造。\n`
          + "用户已拒绝或取消的事情，不因角色坚持而继续提醒、劝说或跟进；角色替用户安排不等于用户同意。最新聊天中没有用户重新明确答应，就按事情已发生变化作罢。\n"
          + "先核对这个念头是否仍有必要：如果你已经在聊天里问过、说过这件事，用户已经回答或事情已经解决，就不要再发，也不要换个话题凑消息。仅仅出现相关词不等于已经说过，按实际问答与语义判断。具体约定或事件是否过时也按事实判断，不因单纯经过多少分钟而认定失效。\n"
          + "无需再发时，只输出 [挂念作罢：聊天已提过] 或 [挂念作罢：事情已解决或发生变化]，不要输出台词、独白或其他标签；仍有未说过且符合当前事实的内容时，按原格式自然成文。双方最新事实优先于旧预约意图。角色说过到了就是已交代的事实，后续不能无故退回尚未到家；再次外出必须有明确依据。约定到点并不证明已完成；不能替用户宣布完成。");
      }
    }

    // 挂念挂的时刻受「一天最多调多少次模型」约束；聊天兜底之类不是挂念的不拦，只记账
    const usageSource = guanianPlan.item ? "cloud-wake" : "cloud-chat";
    const budget = await usageBudget(rest, job.user_id).catch(() => null);
    if (!payload.generatedResponse && guanianPlan.item && budget) {
      const over = usageExceeded(budget);
      if (over) {
        await finish("done", `usage cap: ${over}`);
        return;
      }
    }
    if (!payload.generatedResponse) {
      await progress("llm request started");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300_000);
      let llmResponse: Response;
      try {
        llmResponse = await fetch(payload.request.url, {
          method: "POST",
          headers: payload.request.headers,
          body: JSON.stringify(payload.request.body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!llmResponse.ok) {
        const errorText = await llmResponse.text().catch(() => "");
        await finish("failed", `api ${llmResponse.status}: ${errorText.slice(0, 200)}`);
        return;
      }
      const data = await llmResponse.json();
      const generatedText = extractResponseText(payload.request.providerKind, data).trim();
      if (!generatedText) {
        await finish("failed", "empty response");
        return;
      }

      payload.generatedResponse = { rawText: generatedText, createdAt: new Date().toISOString() };
      await saveGeneratedResponse();
      await usageAdd(rest, job.user_id, budget?.tz ?? 0, usageSource, payload.request.providerKind, data);
    }
    let rawText = payload.generatedResponse.rawText;
    let guanianReasoning: string | undefined;
    if (guanianPlan.item) {
      try {
        const parsed = guanianVisibleResponse(rawText, payload.merge?.onlineThinking);
        rawText = parsed.text; guanianReasoning = parsed.reasoningText;
      }
      catch { await finish("failed", "guanian incomplete thinking block"); return; }
      if (!rawText) { await finish("failed", "guanian empty visible response"); return; }
    }
    if (payload.allowSilence === true && isChatSilenceResponse(rawText, payload.silenceThinkingTag)) {
      if (stripChatSilenceMarker(rawText, payload.silenceThinkingTag)) {
        if (generationLease) {
          const valid = await rest("rpc/push_generation_lease", { method: "POST", body: JSON.stringify({
            p_user_id: job.user_id, p_session_id: generationLease.sessionId, p_token: generationLease.token, p_action: "renew",
          }) });
          if (!valid.ok || await valid.json() !== true) { await retry("hold: 沉默更新的会话生成租约失效"); return; }
        }
        // Retain updates for the normal client/plugin parser, without pushing a chat notification.
        const saved = await rest("push_outbox?on_conflict=id", {
          method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
          body: JSON.stringify([{
            id: `out_silence_${job.id}`, user_id: job.user_id, job_id: job.id,
            session_id: payload.merge?.sessionId ?? null, trigger_key: job.trigger_key,
            raw_text: `${CHAT_SILENCE_TOKEN}\n${stripChatSilenceMarker(rawText, payload.silenceThinkingTag)}`,
            created_at: payload.generatedResponse.createdAt,
            meta: { ...(payload.merge ?? {}), pushGenerated: true, silentUpdate: true },
          }]),
        });
        if (!saved.ok) { await retry("silence updates pending: outbox write failed"); return; }
      }
      await finish("done", "reply silenced");
      return;
    }

    const abandoned = guanianPlan.item && /^\[挂念作罢[：:]([^\]\r\n]{1,120})\]$/.exec(rawText);
    if (abandoned) {
      await appendDecision({ at: Date.now(), kind: "factcheck", time: guanianPlan.item?.time || "", by: "cloud", blocked: true, note: abandoned[1] });
      await finish("done", `guanian skip: ${abandoned[1]}`);
      return;
    }

    await progress(`llm ok, ${rawText.length} chars`);
    if (generationLease) {
      const valid = await rest("rpc/push_generation_lease", { method: "POST", body: JSON.stringify({
        p_user_id: job.user_id, p_session_id: generationLease.sessionId, p_token: generationLease.token, p_action: "renew",
      }) });
      if (!valid.ok || await valid.json() !== true) { await retry("hold: 会话生成租约失效，重新核对"); return; }
    }
    if (isPromise || guanianPlan.item) {
      let latest: Awaited<ReturnType<typeof loadRecheckPlan>>;
      try { latest = await loadRecheckPlan(rest, job.user_id, guanianCharacterId, guanianWakeId); }
      catch { await retry("hold: 成文后约定计划读取失败，等待恢复"); return; }
      if (!promiseIsCurrent(latest) || !isPromise && (!latest.item || latest.item.act === false)) { await finish("done", "plan skip: 成文期间时刻已撤销或替换"); return; }
    }
    if (payload.generatedResponse.processingStarted && !payload.generatedResponse.delivery) {
      await finish("failed", "回复已保存，外部动作执行结果未确认；需核对后恢复，避免重复执行"); return;
    }
    if (!payload.generatedResponse.delivery && (SHORTCUT_MARKER_RE.test(rawText) || payload.weixin?.force || rawText.includes("【发到微信】"))) {
      payload.generatedResponse.processingStarted = true;
      await saveGeneratedResponse();
    }
    // ── 离线来电：复用小手机既有的通话协议，并兼容已经预约的旧任务 ──
    // 仅在回复开头 200 字内识别严格的「我（向某人）发起了语音通话」标签，
    // 普通叙述中的“某人发起了通话”不会误触发。标签从正文剥离，不进聊天记录。
    const callMarkers = [
      /\[我向[^\]\r\n]{1,80}发起了语音通话\]/,
      /【我向[^】\r\n]{1,80}发起了语音通话】/,
      /\[我发起了语音通话\]/,
      /【我发起了语音通话】/,
      /【拨打电话】/,
    ];
    let deliverAsCall = false;
    {
      const head = rawText.slice(0, 200);
      const matched = callMarkers
        .map(pattern => {
          const match = pattern.exec(head);
          return match ? { marker: match[0], index: match.index } : null;
        })
        .filter((item): item is { marker: string; index: number } => item !== null)
        .sort((a, b) => a.index - b.index)[0];
      if (matched) {
        deliverAsCall = true;
        rawText = (rawText.slice(0, matched.index) + rawText.slice(matched.index + matched.marker.length)).trim();
        if (!rawText) rawText = "……";
      }
    }

    // ── 离线快捷动作：AI 输出【快捷动作：名称】则经本项目网关创建命令并推送运行通知 ──
    // 动作目录在 push_bridge_config.shortcut_actions（个人云由客户端同步；
    // 老库/站点库无此列时查询失败即视为无目录，不执行）。标记一律从正文剥离。
    let shortcutActionNote = "";
    // 实际执行过的快捷动作标记（原文+在剥离后正文中的位置）：随 outbox 带回
    // 小手机，在原始位置落一对 tool_call/tool_notice——上下文里是标记原文，
    // 角色下一轮才知道自己传过什么参数（否则「换一首歌」会换出同一首）
    let executedShortcutMarker: { text: string; insertAt: number; name: string } | null = null;
    let deferredShortcutCommandId = "";
    let deferredShortcutActionName = "";
    type DeferredShortcutEmail = {
      userId: string;
      commandId: string;
      resultUrl: string;
      actionId: string;
      actionName: string;
      args: Record<string, unknown>;
    };
    let deferredShortcutEmail: DeferredShortcutEmail | null = null;
    // 送达失败要让用户看得见：shortcutActionNote 只进任务日志（result_note），
    // 而角色已经说了"我去看一眼"。把失败摘要挂进 outbox meta 带回客户端，
    // 由客户端写进现实桥动态。成功则保持空串，不打扰。
    let shortcutDeliveryError = "";
    const noteShortcutDelivery = (actionName: string, note: string): string => {
      // 按「成功」反向判断，别去枚举失败关键词——投递路径的文案有中有英，
      // 加一句新的失败文案就会从关键词表里漏出去，静默丢掉本该给用户的提示。
      // 这里只在真正投递出去时收到含 delivered 的 note。
      if (!/delivered/.test(note)) {
        shortcutDeliveryError = `快捷动作「${actionName}」未能送达：${note.replace(/^, /, "")}`.slice(0, 300);
      }
      return note;
    };
    /**
     * 邮件模式的触发信请站点代发。个人云自己发不了信——RESEND_API_KEY 和
     * REALITY_BRIDGE_EMAIL_FROM 是站点的环境变量，用户的 Supabase 边缘函数里
     * 没有也不该有。命令行、结果回传、续跑快照全部留在本项目，站点只发那封信。
     * 失败一律只回一句 note：邮件没发出去不该让整个生成任务失败。
     */
    const deliverShortcutEmailViaSite = async (input: {
      userId: string;
      commandId: string;
      resultUrl: string;
      actionId: string;
      actionName: string;
      args: Record<string, unknown>;
    }): Promise<string> => {
      if (!siteOrigin) return ", shortcut email skipped: site origin unknown";
      if (!input.commandId || !input.resultUrl) return ", shortcut email skipped: command incomplete";
      try {
        const tokenResponse = await rest(
          `push_bridge_config?user_id=eq.${encodeURIComponent(input.userId)}&select=site_bridge_token&limit=1`,
        );
        const tokenRows = tokenResponse.ok
          ? await tokenResponse.json() as { site_bridge_token?: string | null }[]
          : [];
        const siteBridgeToken = String(tokenRows[0]?.site_bridge_token || "");
        // 令牌没同步上来，绝大多数是个人云还没跑过新版 schema（site_bridge_token
        // 是后加的列）。这句会经 outbox meta 显示给用户，所以要写成可操作的。
        if (!siteBridgeToken) {
          return ", 站点代发未启用：请到「设置 → 云服务部署」重新部署个人云";
        }

        const response = await fetch(`${siteOrigin}/api/push/shortcut-commands/deliver-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: siteBridgeToken,
            actionId: input.actionId,
            actionName: input.actionName,
            commandId: input.commandId,
            resultUrl: input.resultUrl,
            arguments: input.args,
          }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
        return response.ok && data.ok === true
          ? ", shortcut email delivered by site"
          : `, shortcut email failed: ${String(data.error || response.status).slice(0, 80)}`;
      } catch (error) {
        return `, shortcut email failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`;
      }
    };
    /**
     * 快捷动作投递失败时单独落一条诊断行，而不是往角色那条消息的 meta 上补写。
     *
     * 补写会输给一个竞态：消息行落库并推送之后，用户点开通知，客户端可能在服务端
     * PATCH 之前就把那行读走并 ACK 掉——恰好在"投递失败 + 用户立刻点通知"这种
     * 情况下丢掉错误。诊断行是在投递之后才创建的，不存在赶不上的问题。
     *
     * trigger_key 必须留空：客户端按 trigger_key 去重，跟消息行同键会被当成重复
     * 直接消费掉，根本走不到写动态那段。raw_text 只是占位（列是 NOT NULL），
     * 客户端认 meta.kind 后就短路了，不会生成聊天消息。
     */
    const writeShortcutDeliveryDiagnostic = async () => {
      if (!shortcutDeliveryError) return;
      await rest("push_outbox", {
        method: "POST",
        body: JSON.stringify([{
          id: `out_${crypto.randomUUID()}`,
          user_id: job.user_id,
          job_id: job.id,
          session_id: payload.merge?.sessionId ?? null,
          trigger_key: null,
          raw_text: shortcutDeliveryError,
          meta: { kind: "shortcut_delivery_error", shortcutDeliveryError },
        }]),
      }).catch(() => undefined);
    };

    const deliverDeferredShortcut = async () => {
      // 邮件命令绝不能落到下面的 shortcut-deliver：本网关只发 Web Push，
      // 邮件模式在那边是 409。这里改请站点代发。
      if (deferredShortcutEmail) {
        const pending = deferredShortcutEmail;
        deferredShortcutEmail = null;
        shortcutActionNote += noteShortcutDelivery(pending.actionName, await deliverShortcutEmailViaSite(pending));
        await progress(shortcutActionNote);
        return;
      }
      if (!deferredShortcutCommandId) return;
      const commandId = deferredShortcutCommandId;
      const actionName = deferredShortcutActionName || "快捷动作";
      deferredShortcutCommandId = "";
      deferredShortcutActionName = "";
      try {
        const response = await fetch(`${supabaseUrl}/functions/v1/ai-phone-push?action=shortcut-deliver`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ai-phone-service-key": serviceKey,
            "x-ai-phone-origin": siteOrigin,
          },
          body: JSON.stringify({ commandId }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; delivered?: boolean; error?: string };
        const delivered = response.ok && data.ok === true && data.delivered === true;
        shortcutActionNote += delivered
          ? ", shortcut delivered after first reply"
          : noteShortcutDelivery(actionName, `, shortcut delivery failed: ${String(data.error || response.status).slice(0, 80)}`);
        await progress(shortcutActionNote);
      } catch (error) {
        shortcutActionNote += noteShortcutDelivery(actionName, `, shortcut delivery failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`);
        await progress(shortcutActionNote);
      }
    };
    // shortcut_resume 已经是一次动作结果后的第二轮，禁止它再次解析动作标记，
    // 避免模型不守“不要重复执行”提示时形成递归快捷动作。
    if (!payload.shortcut && !payload.generatedResponse.delivery) {
      const markerMatch = rawText.match(SHORTCUT_MARKER_RE);
      if (markerMatch) {
        const markerText = markerMatch[0];
        // 标记在剥离后正文中的原始位置：对前缀做同一套清洗后取长度（尾部 trim 不影响前缀）
        const cleanedPrefix = rawText.slice(0, markerMatch.index ?? 0)
          .replace(SHORTCUT_MARKER_STRIP_RE, "")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/^\s+/, "");
        rawText = rawText.replace(SHORTCUT_MARKER_STRIP_RE, "").replace(/\n{3,}/g, "\n\n").trim();
        if (!rawText) rawText = "……";
        const markerInsertAt = Math.min(cleanedPrefix.length, rawText.length);
        const wanted = markerMatch[1].trim();
        const wantedArgs = parseShortcutMarkerArgs(markerMatch[2]);
        try {
          const catalogResponse = await rest(
            `push_bridge_config?user_id=eq.${encodeURIComponent(job.user_id)}&select=shortcut_actions&limit=1`,
          );
          const catalogRows = catalogResponse.ok ? await catalogResponse.json() as { shortcut_actions?: unknown }[] : [];
          const catalog = Array.isArray(catalogRows[0]?.shortcut_actions)
            ? catalogRows[0].shortcut_actions as Array<Record<string, unknown>>
            : [];
          const action = catalog.find(entry => String(entry.name ?? "") === wanted);
          if (action) {
            const resultMode = String(action.resultMode ?? "none");
            // 目录里没有 deliveryMode 的是同步过来的老快照（该字段是后加的）。
            // 退回推送仍然能用（只是要对方点一下通知，而不是自动执行），比不投递好；
            // 但要在任务日志里留痕，否则「提示词说自动执行、实际弹了通知」查不出原因。
            // 用户改动作或下一轮桥同步时目录会补上这个字段，属自愈。
            const catalogHasDeliveryMode = typeof action.deliveryMode === "string";
            const deliveryMode = String(action.deliveryMode ?? "push") === "email" ? "email" : "push";
            if (!catalogHasDeliveryMode) shortcutActionNote += ", catalog missing deliveryMode (fell back to push)";
            const continuation = payload.shortcutContinuation;
            const canContinue = resultMode !== "none"
              && Boolean(continuation?.request && continuation.replyMarker && continuation.resultMarker);
            const createResponse = await fetch(`${supabaseUrl}/functions/v1/ai-phone-push?action=shortcut-create`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-ai-phone-service-key": serviceKey,
                "x-ai-phone-origin": siteOrigin,
              },
              body: JSON.stringify({
                actionId: String(action.actionId ?? ""),
                actionName: String(action.name ?? ""),
                shortcutName: String(action.shortcutName ?? ""),
                arguments: wantedArgs,
                resultMode,
                deliveryMode,
                expiresInSeconds: Number(action.expiresInSeconds) || undefined,
                deferDelivery: canContinue,
              }),
            });
            const createData = await createResponse.json().catch(() => ({})) as {
              ok?: boolean;
              command?: { id?: string };
              resultUrl?: string;
            };
            shortcutActionNote = createResponse.ok && createData.ok
              ? `shortcut sent: ${wanted}`
              : `shortcut failed: http ${createResponse.status}`;
            if (createResponse.ok && createData.ok) {
              executedShortcutMarker = { text: markerText, insertAt: markerInsertAt, name: wanted };
            }

            // 邮件模式：个人云没有发信服务（RESEND_API_KEY 是站点的环境变量），
            // 请站点凭 site_bridge_token 代发那封信。命令行与结果回传仍留在本项目。
            // 有续跑的动作等续跑任务挂稳、首条回复送达之后再发（与推送模式同序），
            // 见下方 armed.ok 分支；这里只处理不回传结果、可以立刻触发的动作。
            const emailDelivery: DeferredShortcutEmail = {
              userId: job.user_id,
              commandId: String(createData.command?.id || ""),
              resultUrl: String(createData.resultUrl || ""),
              actionId: String(action.actionId ?? ""),
              actionName: String(action.name ?? ""),
              args: wantedArgs,
            };
            if (createResponse.ok && createData.ok && deliveryMode === "email" && !canContinue) {
              shortcutActionNote += noteShortcutDelivery(
                emailDelivery.actionName,
                await deliverShortcutEmailViaSite(emailDelivery),
              );
            }

            // 需回传结果的动作：武装 shortcut_resume 续跑任务——把刚生成的
            // 回复代入续跑快照的回复占位；结果回传后由本函数把结果代入生成下一轮。
            const commandId = String(createData.command?.id || "");
            if (createResponse.ok && createData.ok && canContinue && commandId && continuation) {
              try {
                const contRequest = JSON.parse(JSON.stringify(continuation.request)) as JobPayload["request"];
                replaceMarker(contRequest.body, continuation.replyMarker, rawText);
                const isImage = resultMode === "image";
                // 识图关着就不送图：送了轻则被模型忽略，重则接口直接 400 让整个
                // 第二轮失败（角色说了"我去看一眼"然后没有下文）。图片位改放一句
                // 说明，OCR 之类的附带文字仍照常经 resultMarker 抵达。
                const canSendImage = isImage && continuation.visionEnabled !== false;
                if (!canSendImage && continuation.imageMarker) {
                  replaceMarker(
                    contRequest.body,
                    continuation.imageMarker,
                    isImage ? SHORTCUT_VISION_OFF_NOTE : "（该动作没有图片回传）",
                  );
                }
                const expiresIn = Math.max(30, Math.min(900, Number(action.expiresInSeconds) || 120));
                const contPayload = {
                  request: contRequest,
                  shortcut: {
                    commandId,
                    actionName: String(action.name ?? "快捷动作"),
                    resultMode,
                    resultMarker: continuation.resultMarker,
                    ...(canSendImage && continuation.imageMarker ? { imageMarker: continuation.imageMarker } : {}),
                    style: "text",
                  },
                  notify: payload.notify,
                  merge: { ...(payload.merge ?? {}), shortcutCommandId: commandId },
                };
                const triggerKey = `shortcut:${commandId}`;
                await rest(
                  `push_jobs?user_id=eq.${encodeURIComponent(job.user_id)}&trigger_key=eq.${encodeURIComponent(triggerKey)}`,
                  { method: "DELETE" },
                ).catch(() => undefined);
                const armed = await rest("push_jobs", {
                  method: "POST",
                  body: JSON.stringify([{
                    id: `job_${crypto.randomUUID()}`,
                    user_id: job.user_id,
                    trigger_key: triggerKey,
                    kind: "shortcut_resume",
                    execute_at: new Date(Date.now() + (expiresIn + 90) * 1000).toISOString(),
                    status: "pending",
                    result_note: "cloud_shortcut_resume",
                    payload: await encryptJobPayload(JSON.stringify(contPayload), payloadKey),
                  }]),
                });
                await armed.text().catch(() => "");
                // 挂载成功与否都要把命令投递出去——命令已经以 deferDelivery 建好，
                // 不投递它就只会静默过期：角色说了"我去看一下"，用户手机什么都收不到。
                // 挂载失败时降级为"没有第二轮"，动作照跑，只是结果不会自动交回角色。
                if (deliveryMode === "email") {
                  deferredShortcutEmail = emailDelivery;
                } else {
                  deferredShortcutCommandId = commandId;
                  deferredShortcutActionName = emailDelivery.actionName;
                }
                shortcutActionNote += armed.ok
                  ? ", continuation armed"
                  : ", continuation arm failed (degraded to one-shot)";
              } catch {
                if (deliveryMode === "email") {
                  deferredShortcutEmail = emailDelivery;
                } else {
                  deferredShortcutCommandId = commandId;
                  deferredShortcutActionName = emailDelivery.actionName;
                }
                shortcutActionNote += ", continuation arm failed (degraded to one-shot)";
              }
            }
          } else {
            shortcutActionNote = `shortcut unknown: ${wanted}`;
          }
        } catch {
          shortcutActionNote = "shortcut catalog unavailable";
        }
      }
    } else {
      // 结果续跑即使被模型诱导再次输出动作标记，也只剥离控制文本，不执行。
      rawText = rawText.replace(/【快捷动作[：:][^】\n]{1,60}】/g, "").replace(/\n{3,}/g, "\n\n").trim();
      if (!rawText) rawText = "……";
    }
    if (shortcutActionNote) await progress(shortcutActionNote);

    // ── 离线改送微信：普通任务由 AI 首行【发到微信】选择；真实微信快捷动作
    // 的结果续跑使用 force，保证第二轮无需模型再次决定渠道也回到同一 bot。 ──
    const WEIXIN_MARKER = "【发到微信】";
    let deliveredViaWeixin = false;
    if (!payload.generatedResponse.delivery) {
      const head = rawText.slice(0, 200);
      const markerAt = head.indexOf(WEIXIN_MARKER);
      const forceWeixin = payload.weixin?.force === true;
      if (markerAt >= 0 || forceWeixin) {
        if (markerAt >= 0) {
          rawText = (rawText.slice(0, markerAt) + rawText.slice(markerAt + WEIXIN_MARKER.length)).trim();
          if (!rawText) rawText = "……";
          // 微信标记被剥掉后，快捷动作标记的还原位置要跟着前移（消费端还会钳位兜底）
          if (executedShortcutMarker && markerAt < executedShortcutMarker.insertAt) {
            executedShortcutMarker.insertAt = Math.max(0, executedShortcutMarker.insertAt - WEIXIN_MARKER.length);
          }
        }
        const weixinBotId = typeof payload.weixin?.botId === "string" ? payload.weixin.botId : "";
        if (!weixinBotId) await progress(`${forceWeixin ? "forced weixin" : "weixin marker"} but no bot in snapshot`);
        if (weixinBotId) {
          try {
            const secretResponse = await fetch(
              `${supabaseUrl}/storage/v1/object/ai-phone-backup/weixin-cloud/cron-secret.json`,
              { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
            );
            const secret = secretResponse.ok
              ? String(((await secretResponse.json().catch(() => ({}))) as { token?: unknown }).token || "")
              : "";
            if (secret) {
              const sendResponse = await fetch(`${supabaseUrl}/functions/v1/weixin-assistant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "send-text",
                  token: secret,
                  bot: weixinBotId,
                  text: rawText,
                  ...(typeof payload.merge?.replyAfterLocalMessageId === "string"
                    && typeof payload.merge?.replyAfterCreatedAt === "string"
                    ? {
                        replyAfterLocalMessageId: payload.merge.replyAfterLocalMessageId,
                        replyAfterCreatedAt: payload.merge.replyAfterCreatedAt,
                      }
                    : {}),
                }),
              });
              const sendData = await sendResponse.json().catch(() => ({})) as { ok?: boolean; error?: string };
              deliveredViaWeixin = sendResponse.ok && sendData.ok === true;
              await progress(deliveredViaWeixin
                ? "delivered via weixin"
                : `weixin send failed: ${String(sendData.error || sendResponse.status).slice(0, 120)}`);
            } else {
              await progress("weixin secret missing");
            }
          } catch (err) {
            await progress(`weixin send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
          }
        }
      }
    }
    if (deliveredViaWeixin) {
      if (shortcutStoragePath) {
        await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${shortcutStoragePath}`, {
          method: "DELETE",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        }).catch(() => undefined);
      }
      await deliverDeferredShortcut();
      await writeShortcutDeliveryDiagnostic();
      await finish("done", `sent via weixin${shortcutActionNote ? `, ${shortcutActionNote}` : ""}`);
      return;
    }

    if (payload.generatedResponse.delivery) {
      rawText = payload.generatedResponse.delivery.rawText;
      deliverAsCall = payload.generatedResponse.delivery.deliverAsCall;
      executedShortcutMarker = payload.generatedResponse.delivery.marker;
      deferredShortcutCommandId = String(payload.generatedResponse.delivery.commandId || "");
      deferredShortcutActionName = String(payload.generatedResponse.delivery.actionName || "");
      deferredShortcutEmail = payload.generatedResponse.delivery.email as DeferredShortcutEmail | null;
      shortcutDeliveryError = String(payload.generatedResponse.delivery.error || "");
      shortcutStoragePath = String(payload.generatedResponse.delivery.storagePath || "");
    } else {
      payload.generatedResponse.delivery = { rawText, deliverAsCall, marker: executedShortcutMarker, commandId: deferredShortcutCommandId, actionName: deferredShortcutActionName, email: deferredShortcutEmail, error: shortcutDeliveryError, storagePath: shortcutStoragePath };
      await saveGeneratedResponse();
    }
    await progress(`llm ok, ${rawText.length} chars${deliverAsCall ? ", call" : ""}`);
    if (generationLease) {
      const valid = await rest("rpc/push_generation_lease", { method: "POST", body: JSON.stringify({
        p_user_id: job.user_id, p_session_id: generationLease.sessionId, p_token: generationLease.token, p_action: "renew",
      }) });
      if (!valid.ok || await valid.json() !== true) { await retry("hold: 会话生成租约失效，重新核对"); return; }
    }
    if (isPromise || guanianPlan.item) {
      let latest: Awaited<ReturnType<typeof loadRecheckPlan>>;
      try { latest = await loadRecheckPlan(rest, job.user_id, guanianCharacterId, guanianWakeId); }
      catch { await retry("hold: 成文后约定计划读取失败，等待恢复"); return; }
      if (!promiseIsCurrent(latest) || !isPromise && (!latest.item || latest.item.act === false)) { await finish("done", "plan skip: 成文期间时刻已撤销或替换"); return; }
    }
    const outboxResponse = await rest("push_outbox", {
      method: "POST",
      body: JSON.stringify([{
        id: `out_${crypto.randomUUID()}`,
        user_id: job.user_id,
        job_id: job.id,
        session_id: payload.merge?.sessionId ?? null,
        trigger_key: job.trigger_key,
        raw_text: rawText,
        created_at: payload.generatedResponse.createdAt,
        meta: {
          ...(payload.merge ?? {}),
          pushGenerated: true,
          ...(guanianReasoning ? { reasoningText: guanianReasoning } : {}),
          ...(cloudHistory ? { guanianContext: { messageIds: cloudHistory.messages.slice(-80).map(m => m.id), checkedAt: new Date().toISOString(), eventId: guanianPlan.item?.from || null, revision: guanianPlan.item?.promiseRevision || null } } : {}),
          ...(executedShortcutMarker ? { shortcutMarker: executedShortcutMarker } : {}),
        },
      }]),
    });
    if (!outboxResponse.ok) {
      const detail = await outboxResponse.text().catch(() => "");
      await retry(`outbox write failed; saved reply retained: ${detail.slice(0, 180) || outboxResponse.status}`);
      return;
    }
    await progress("outbox written, pushing");

    if (shortcutStoragePath) {
      await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${shortcutStoragePath}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }).catch(() => undefined);
    }

    const vapidResponse = await rest("push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key&limit=1");
    const vapidRows = vapidResponse.ok ? await vapidResponse.json() as { vapid_public_key: string; vapid_private_key: string }[] : [];
    const vapidRow = vapidRows[0];
    let pushed = 0;
    const pushErrors: string[] = [];
    // 安卓壳（FloatShell App）的合成订阅（endpoint 以 shell: 开头）不走 Web Push，
    // 改由 Supabase Realtime 广播送达壳内长连接。
    const webSubs = subs.filter(sub => !sub.endpoint.startsWith("shell:"));
    const hasShellSub = webSubs.length < subs.length;
    const vapid = vapidRow
      ? { publicKey: vapidRow.vapid_public_key, privateKey: vapidRow.vapid_private_key, subject: siteOrigin || "mailto:push@ai-phone.local" }
      : null;
    if (!vapid && webSubs.length > 0) pushErrors.push("no vapid config");
    const title = payload.notify?.title || "小手机";
    const callSessionId = typeof payload.merge?.sessionId === "string" ? payload.merge.sessionId : "";
    // 来电：单条推送（不分段），点开带 ring 参数直达振铃；正文照常进 outbox
    const targetUrl = deliverAsCall && callSessionId
      ? `/?ring=${encodeURIComponent(callSessionId)}&rt=${Date.now()}`
      : (payload.notify?.url || "/");
    let parts = deliverAsCall
      ? ["来电话了…"]
      : splitResponseForPushPreview(rawText).slice(0, 6);
    if (parts.length === 0) parts = ["发来一条消息"];

    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) await sleep(500);
      const partBody = parts[index].slice(0, 80);
      const message = JSON.stringify({
        type: deliverAsCall ? "incoming_call" : "chat_outbox",
        title: deliverAsCall ? `📞 ${title}` : title,
        body: partBody,
        tag: `${job.id}-${index}`,
        url: targetUrl,
        // SW 用它取本地缓存的角色头像当通知 icon；老 SW 不认识则忽略
        ...(payload.notify?.characterId ? { characterId: payload.notify.characterId } : {}),
        ...(deliverAsCall ? { sessionId: callSessionId, callTs: Date.now() } : {}),
      });
      if (vapid) {
        for (const sub of webSubs) {
          try {
            const status = await sendWebPushRaw(sub, message, vapid, 3600);
            if (status === 404 || status === 410) {
              await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" }).catch(() => undefined);
            } else if (status >= 400) {
              pushErrors.push(`http ${status}`);
            } else {
              pushed += 1;
            }
          } catch (err) {
            pushErrors.push((err instanceof Error ? err.message : String(err)).slice(0, 80));
          }
        }
      }
      if (hasShellSub) {
        try {
          const response = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
            method: "POST",
            headers: restHeaders,
            body: JSON.stringify({
              messages: [{
                topic: `shellpush:${job.user_id}`,
                event: "notify",
                payload: {
                  title: deliverAsCall ? `📞 ${title}` : title,
                  body: partBody,
                  url: targetUrl,
                  // 老壳不认识这些字段 → 照常显示普通通知，自然向下兼容
                  ...(deliverAsCall ? { kind: "call", characterName: title, sessionId: callSessionId, callTs: Date.now() } : {}),
                },
              }],
            }),
          });
          await response.text().catch(() => undefined);
          if (response.ok) pushed += 1;
          else pushErrors.push(`shell http ${response.status}`);
        } catch (err) {
          pushErrors.push(`shell ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
        }
      }
      await progress(`pushed ${index + 1}/${parts.length}${pushErrors.length ? `, errors: ${pushErrors[0]}` : ""}`);
    }

    // 第一轮正文已经落库并完成推送后，再发“运行快捷指令”通知。用户看到的
    // 顺序稳定为：角色先说话 → 运行动作 → 结果回来后角色再说话。
    await deliverDeferredShortcut();

    await writeShortcutDeliveryDiagnostic();

    // 冷场重连的下一发：连发上限内自动排队（用户回来后客户端会撤销并按新周期重挂）
    const idleRepeat = payload.merge?.idleRepeat as
      | { intervalMs?: number; remaining?: number; quietWin?: { startMin: number; endMin: number; tzOffsetMin: number } | null }
      | undefined;
    if (idleRepeat && Number(idleRepeat.remaining) > 0 && Number(idleRepeat.intervalMs) > 0) {
      const intervalMs = Number(idleRepeat.intervalMs);
      let nextFire = Date.now() + intervalMs;
      // 落在安静时段内则顺延到时段结束
      const quiet = idleRepeat.quietWin;
      if (quiet && Number.isFinite(quiet.startMin) && Number.isFinite(quiet.endMin)) {
        const localMinutes = (Math.floor(nextFire / 60000) + quiet.tzOffsetMin) % 1440;
        const inQuiet = quiet.startMin < quiet.endMin
          ? localMinutes >= quiet.startMin && localMinutes < quiet.endMin
          : localMinutes >= quiet.startMin || localMinutes < quiet.endMin;
        if (inQuiet) {
          const untilEnd = (quiet.endMin - localMinutes + 1440) % 1440;
          nextFire += untilEnd * 60000;
        }
      }
      const nextMerge = {
        ...payload.merge,
        armAt: new Date(nextFire).toISOString(),
        idleReconnect: { ...(payload.merge?.idleReconnect as Record<string, unknown> ?? {}), firedAt: nextFire },
        idleRepeat: Number(idleRepeat.remaining) - 1 > 0
          ? { ...idleRepeat, remaining: Number(idleRepeat.remaining) - 1 }
          : undefined,
      };
      const nextPayload = { ...payload, generatedResponse: undefined, merge: nextMerge };
      await rest("push_jobs", {
        method: "POST",
        body: JSON.stringify([{
          id: `job_${crypto.randomUUID()}`,
          user_id: job.user_id,
          trigger_key: `${job.trigger_key}+`,
          kind: "timed_task",
          execute_at: new Date(nextFire + 15_000).toISOString(),
          status: "pending",
          payload: await encryptPayload(JSON.stringify(nextPayload), payloadKey),
        }]),
      }).catch(() => undefined);
    }

    await finish("done", `generated, pushed ${pushed}${shortcutActionNote ? `, ${shortcutActionNote}` : ""}${pushErrors.length ? `, errors: ${pushErrors.slice(0, 3).join(" | ")}` : ""}`);
  } catch (err) {
    if (resultStored) await retry("已保存回复，等待恢复投递：" + (err instanceof Error ? err.message : String(err)));
    else await finish("failed", err instanceof Error ? err.message : String(err));
  } finally {
    if (generationLease) await rest("rpc/push_generation_lease", { method: "POST", body: JSON.stringify({
      p_user_id: job.user_id, p_session_id: generationLease.sessionId, p_token: generationLease.token, p_action: "release",
    }) }).catch(() => undefined);
  }
  };

  const work = runJob();
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
