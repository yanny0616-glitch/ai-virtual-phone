// HTTP 接口。只监听 127.0.0.1，由反代决定是否对外；除 /health 外都要 Bearer 令牌。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { collectDiagnostics } from "./diagnostics.ts";
import { sendPushToUser } from "./push.ts";
import { validateSnapshot, type Snapshot, type Store } from "./store.ts";
import type { Rest } from "./supabase.ts";

const MAX_BODY = 4 * 1024 * 1024;

export type ServerDeps = { rest: Rest; store: Store; userId: string; apiToken: string; startedAt: Date };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, token: string): boolean {
  if (!token) return false;
  const given = Buffer.from((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("请求体不是 JSON"), { status: 400 }); }
}

export function createApp(deps: ServerDeps): Server {
  return createServer(async (req, res) => {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, startedAt: deps.startedAt.toISOString(), snapshots: deps.store.listSnapshots().length });
      }
      if (!authorized(req, deps.apiToken)) return send(res, 401, { ok: false, error: "unauthorized" });

      if (req.method === "GET" && path === "/diagnostics") {
        return send(res, 200, { ok: true, ...await collectDiagnostics(deps.rest, deps.store, deps.userId) });
      }
      if (req.method === "PUT" && path === "/snapshots") {
        const body = await readJson(req);
        const error = validateSnapshot(body);
        if (error) return send(res, 400, { ok: false, error });
        deps.store.saveSnapshot(body as Snapshot);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/push/test") {
        const result = await sendPushToUser(deps.rest, deps.userId, {
          title: "挂念后端", body: "测试推送：来自 VPS ✓", tag: `companion-test-${Date.now()}`, url: "/",
        });
        return send(res, 200, { ok: result.sent > 0, ...result });
      }
      return send(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      const status = (err as { status?: number }).status || 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error(`[companion] ${req.method} ${path} 失败：${message}`);
      return send(res, status, { ok: false, error: message });
    }
  });
}
