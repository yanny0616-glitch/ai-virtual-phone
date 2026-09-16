// HTTP 接口。监听 127.0.0.1（和 Docker 网桥，给站点反代用）；除 /health 外都要令牌：
// 运维令牌 COMPANION_API_TOKEN，或手机挂念里存的个人云 Secret key（见 auth.ts）。
// 挂念 App 跑在沙箱 iframe 里（null origin），所以放开 CORS；鉴权只靠 Authorization 头，不用 cookie。
//   GET  /status                            总览：模式、每个角色此刻、今天念头、最近判断
//   GET  /characters/:id                    单个角色全部状态
//   PUT  /characters/:id/settings           同步设置（只收设置键）
//   PUT  /characters/:id/calendar/:date     同步日程表已定安排 { items, routine }
//   POST /characters/:id/regenerate         重新生成今天（真发模式才调模型）
//   POST /characters/:id/tick               立刻跑一轮
//   PUT  /snapshots                         手机寄来的提示词快照
//   POST /mode                              { mode: "shadow" | "live" }
//   POST /import                            从个人云迁入 { force }
//   GET  /diagnostics                       个人云聊天镜像最近几条
//   POST /push/test                         测试推送
//   /app/…                                  挂念直连、唤醒后端，见 api.ts

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { handleApp, regenerate, saveSettings } from "./api.ts";
import type { Auth } from "./auth.ts";
import { collectDiagnostics } from "./diagnostics.ts";
import type { EngineDeps } from "./engine.ts";
import { importFromCloud } from "./importer.ts";
import { sendPushToUser } from "./push.ts";
import type { Runner } from "./runner.ts";
import { characterStatus, overview } from "./status.ts";
import { validateSnapshot, type Snapshot, type Store } from "./store.ts";
import type { Rest } from "./supabase.ts";
import type { FixedItem, Routine } from "./day.ts";
import type { WakeService } from "./wake.ts";

const MAX_BODY = 4 * 1024 * 1024;

export type ServerDeps = { rest: Rest; store: Store; userId: string; auth: Auth; startedAt: Date; runner: Runner; engine: EngineDeps; wake?: WakeService };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("请求体不是 JSON"), { status: 400 }); }
}

export function createApp(deps: ServerDeps): Server {
  return createServer(async (req, res) => {
    let path = "/";
    try {
      let url: URL;
      let parts: string[];
      try {
        url = new URL(req.url || "/", "http://localhost");
        path = url.pathname.replace(/\/+$/, "") || "/";
        parts = path.split("/").filter(Boolean).map(decodeURIComponent);
      } catch { return send(res, 400, { ok: false, error: "请求路径编码无效" }); }
      if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, startedAt: deps.startedAt.toISOString(), mode: deps.runner.mode, lastTickAt: deps.runner.lastTickAt });
      }
      if (!await deps.auth.allow(req.headers.authorization)) return send(res, 401, { ok: false, error: "unauthorized" });

      const appDeps = { store: deps.store, runner: deps.runner, engine: deps.engine, wake: deps.wake };
      const app = await handleApp(appDeps, req.method || "GET", path, url.searchParams, () => readJson(req));
      if (app) return send(res, app.status, app.body);

      if (req.method === "GET" && path === "/status") return send(res, 200, { ok: true, ...overview(deps.store, deps.runner) });
      if (req.method === "GET" && path === "/diagnostics") {
        return send(res, 200, { ok: true, ...await collectDiagnostics(deps.rest, deps.store, deps.userId) });
      }
      if (req.method === "POST" && path === "/mode") {
        const { mode } = await readJson(req) as { mode?: string };
        if (mode !== "shadow" && mode !== "live") return send(res, 400, { ok: false, error: "mode 只能是 shadow 或 live" });
        deps.runner.setMode(mode);
        return send(res, 200, { ok: true, mode });
      }
      if (req.method === "POST" && path === "/import") {
        const { force } = await readJson(req) as { force?: boolean };
        return send(res, 200, { ok: true, ...await deps.runner.exclusive(() => importFromCloud(deps.rest, deps.store, deps.userId, { force: force === true })) });
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

      if (parts[0] === "characters" && parts[1]) {
        const id = parts[1];
        const c = deps.store.getCharacter(id);
        if (!c) return send(res, 404, { ok: false, error: "没有这个角色" });
        if (req.method === "GET" && parts.length === 2) return send(res, 200, { ok: true, ...characterStatus(deps.store, deps.runner, id) });
        if (req.method === "PUT" && parts[2] === "settings") {
          return send(res, 200, { ok: true, ...await saveSettings(appDeps, id, await readJson(req) as Record<string, unknown>) });
        }
        if (req.method === "PUT" && parts[2] === "calendar" && /^\d{4}-\d{2}-\d{2}$/.test(parts[3] || "")) {
          const body = await readJson(req) as { items?: unknown; routine?: unknown };
          const items = (Array.isArray(body.items) ? body.items : [])
            .filter(it => it && typeof it === "object" && typeof (it as FixedItem).startTime === "string" && typeof (it as FixedItem).title === "string") as FixedItem[];
          const routine = (body.routine && typeof body.routine === "object" ? body.routine : {}) as Routine;
          await deps.runner.exclusive(() => deps.store.saveCalendar(id, parts[3], items, routine));
          return send(res, 200, { ok: true, items: items.length });
        }
        if (req.method === "POST" && parts[2] === "regenerate") return send(res, 200, { ok: true, ...await regenerate(appDeps, id) });
        if (req.method === "POST" && parts[2] === "tick") {
          const traces = await deps.runner.tick(id);
          if (!traces.length) return send(res, 409, { ok: false, error: "上一轮还在跑" });
          return send(res, 200, { ok: true, trace: traces[0] });
        }
      }
      return send(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      const status = (err as { status?: number }).status || 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status >= 500) console.error(`[companion] ${req.method} ${path} 失败：${message}`);
      if (!res.headersSent) send(res, status, { ok: false, error: message });
    }
  });
}
