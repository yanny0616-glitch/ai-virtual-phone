// MCP 客户端（Streamable HTTP）：唤醒后端替角色调工具用。
// 与小手机 lib/tool-executor 的握手、请求头、结果提取保持一致；只支持 POST 型 /mcp 地址，不做 OAuth（令牌由手机寄来的请求头带上）。

const PROTOCOL = "2024-11-05";
const CLIENT_INFO = { name: "float-wake-server", version: "1.0.0" };
/** 与小手机工具结果上限一致 */
export const MAX_RESULT_LENGTH = 2000;

export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;
export type McpResult = { ok: boolean; text: string };

type RpcReply = { result?: unknown; error?: { code?: number; message?: string } };

/** 响应可能是 JSON，也可能是一段 SSE（data: 行里是 JSON-RPC） */
export function parseRpcText(text: string, id: number): RpcReply {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as RpcReply;
  let fallback: RpcReply | null = null;
  for (const block of trimmed.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as RpcReply & { id?: number };
      if (msg.id === id) return msg;
      if (msg.result !== undefined || msg.error) fallback = msg;
    } catch { /* 心跳或非 JSON 行 */ }
  }
  if (fallback) return fallback;
  throw new Error("MCP 响应不是 JSON-RPC");
}

export function mcpResultText(result: unknown): McpResult {
  const r = (result && typeof result === "object" ? result : {}) as { isError?: boolean; content?: { type?: string; text?: string }[] };
  const texts: string[] = [];
  let media = 0;
  for (const c of Array.isArray(r.content) ? r.content : []) {
    if (c?.type === "text" && c.text) texts.push(c.text);
    else if (c?.type === "image" || c?.type === "resource" || c?.type === "audio") media += 1;
  }
  let text = texts.length ? texts.join("\n") : JSON.stringify(result ?? null);
  if (media) text += `\n（另有 ${media} 个媒体附件，后端不转发）`;
  if (r.isError) return { ok: false, text: (texts.join("\n") || "MCP工具执行失败").slice(0, MAX_RESULT_LENGTH) };
  return { ok: true, text: text.slice(0, MAX_RESULT_LENGTH) };
}

export class McpClient {
  #url: string;
  #headers: Record<string, string>;
  #fetch: McpFetch;
  #session = "";
  #ready = false;
  #nextId = 1;

  constructor(url: string, headers: Record<string, string>, fetchImpl: McpFetch = fetch) {
    this.#url = url;
    this.#headers = headers;
    this.#fetch = fetchImpl;
  }

  async #rpc(method: string, params: Record<string, unknown> | undefined, notify = false): Promise<{ status: number; reply?: RpcReply }> {
    const id = this.#nextId++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL,
      ...this.#headers,
      ...(this.#session ? { "mcp-session-id": this.#session } : {}),
    };
    const res = await this.#fetch(this.#url, {
      method: "POST", headers, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}), ...(notify ? {} : { id }) }),
    });
    const session = res.headers.get("mcp-session-id");
    if (session) this.#session = session;
    const text = await res.text();
    if (res.status === 401) throw new Error("MCP 鉴权失败（401）：手机上这个 MCP 的访问 Token 无效或过期");
    if (res.status < 200 || res.status >= 300) {
      let detail = `HTTP ${res.status}`;
      try { const e = parseRpcText(text, id).error; if (e?.message) detail = e.message; } catch { detail += `: ${text.slice(0, 160)}`; }
      return { status: res.status, reply: { error: { code: res.status, message: detail } } };
    }
    if (notify || !text.trim()) return { status: res.status };
    return { status: res.status, reply: parseRpcText(text, id) };
  }

  async #init(): Promise<void> {
    if (this.#ready) return;
    this.#session = "";
    const init = await this.#rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO });
    if (init.reply?.error) throw new Error(`MCP 初始化失败：${init.reply.error.message || "未知错误"}`);
    await this.#rpc("notifications/initialized", undefined, true).catch(() => undefined);
    this.#ready = true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpResult> {
    try {
      await this.#init();
      let r = await this.#rpc("tools/call", { name, arguments: args });
      // 会话过期（404）就重新握手一次
      if (r.status === 404 && this.#session) {
        this.#ready = false;
        await this.#init();
        r = await this.#rpc("tools/call", { name, arguments: args });
      }
      if (r.reply?.error) return { ok: false, text: String(r.reply.error.message || "MCP工具执行失败").slice(0, MAX_RESULT_LENGTH) };
      return mcpResultText(r.reply?.result);
    } catch (e) {
      return { ok: false, text: (e instanceof Error ? e.message : String(e)).slice(0, MAX_RESULT_LENGTH) };
    }
  }
}
