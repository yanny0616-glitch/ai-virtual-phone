// 拾光 APP 端到端冒烟：真 Chromium 跑单文件产物，宿主 SDK 全部用内存假实现。
// 覆盖：启动、接续旧记录、自动整理（假模型）、注入文字、编辑冲突保护、删除墓碑、后台事件握手。
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "out/shiguang-app-browser-check");
await fs.mkdir(out, { recursive: true });
const appHtml = await fs.readFile(path.join(root, "custom-apps/shiguang/index.html"), "utf8");

const MOCK = String.raw`
window.__host = (() => {
  const db = {}; const contexts = {}; const calls = { ai: 0 };
  const msg = (i, role, content) => ({ id: "m" + i, sessionId: "s1", role, content, createdAt: new Date(Date.UTC(2026, 8, 5, 20, i)).toISOString() });
  const history = [];
  for (let i = 1; i <= 44; i++) history.push(msg(i, i % 2 ? "user" : "assistant", i % 2 ? "第" + i + "句：我们9月12日去海边吧，改计划要提前说。" : "好呀，第" + i + "句，9月11日晚我确认一次。"));
  const rows = c => (db[c] = db[c] || []);
  const model = { text: JSON.stringify({ memories: [{ existingId: "", title: "海边之约", summary: "约好9月12日去海边", categories: ["约定与承诺"], reason: "想一起看海", story: "用户提议，角色答应并约定11日晚确认", details: [{ label: "日期", value: "9月12日" }], significance: "", promptSummary: "约好9月12日一起去海边，11日晚再确认一次。", pinned: false, keywords: ["海边", "9月12日"], dueAt: "2026-09-12", status: "pending", followup: "", sourceIds: ["s1", "s2"] }] }) };
  const handlers = {};
  const api = {
    app: { getLaunchContext: async () => window.__launch || { characterId: "c1" } },
    on: (event, handler) => { (handlers[event] = handlers[event] || []).push(handler); },
    emit: async (event, payload) => Promise.all((handlers[event] || []).map(h => h(payload))).catch(e => { window.__err = String(e && e.stack || e); throw e; }),
    characters: { list: async () => [{ id: "c1", name: "沈烬言" }, { id: "c2", name: "宁妍" }] },
    ui: { toast: async () => true },
    db: {
      list: async (c, q) => rows(c).slice(0, (q && q.limit) || 100).map(r => ({ ...r })),
      get: async (c, id) => { const r = rows(c).find(r => r.id === id); return r ? { ...r } : null; },
      create: async (c, data) => { const row = { ...data, id: data.id || "rec_" + Math.random().toString(36).slice(2), createdAt: new Date().toISOString(), updatedAt: data.updatedAt || new Date().toISOString() }; rows(c).push(row); return { ...row }; },
      update: async (c, id, patch) => { const list = rows(c); const i = list.findIndex(r => r.id === id); if (i < 0) throw new Error("missing " + id); list[i] = { ...list[i], ...patch, id }; return { ...list[i] }; },
      delete: async (c, id) => { db[c] = rows(c).filter(r => r.id !== id); return true; },
    },
    chat: {
      readHistory: async ({ characterId, limit = 50, before }) => { if (characterId !== "c1") return { messages: [] }; let list = history; if (before) { const i = list.findIndex(m => m.id === before); if (i >= 0) list = list.slice(0, i); } return { sessionId: "s1", characterId, isGroup: false, messages: list.slice(-limit) }; },
      setContext: async ({ characterId, text }) => { contexts[characterId] = text; return true; },
    },
    ai: { chat: async ({ messages }) => { calls.ai++; calls.lastPrompt = messages[0].content; return { ...model, wasTruncated: false }; } },
    memory: { readShiguang: async ({ characterId }) => characterId === "c1" ? { entries: [{ id: "mem_sg_old", characterId: "c1", content: "旧卡片简述", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", sourceMessageIds: ["m1"], shiguang: { title: "旧记录", categories: ["共同经历"], reason: "", story: "旧故事", details: [], significance: "", stableSummary: "持续边界", recallSummary: "紧凑旧摘要", keywords: ["旧"], status: "remembered", followup: "", firstEventAt: "2026-09-01T00:00:00.000Z", lastEventAt: "2026-09-01T00:00:00.000Z" } }] } : { entries: [] } },
  };
  return { api, db, contexts, calls, history, model };
})();
window.AiPhone = window.__host.api;
`;

const TEST = String.raw`
(async () => {
  const H = window.__host; const $ = id => document.getElementById(id);
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (test, why) => { for (let i = 0; i < 200; i++) { if (test()) return; await pause(40); } throw new Error(why); };
  let checks = 0; const check = (c, m) => { if (!c) throw new Error(m); checks++; };
  await wait(() => $("character").options.length === 2 && !$("character").disabled, "characters did not load");
  await wait(() => document.querySelectorAll(".sg-record").length === 1, "legacy record not imported");
  check(document.querySelector(".sg-record .sg-title span").textContent === "旧记录", "legacy title");
  check(document.querySelector(".sg-record .sg-mode").textContent === "优先携带", "legacy stableSummary → priority");
  check(document.querySelector(".sg-record .sg-prompt p").textContent === "紧凑旧摘要", "legacy compact summary used as prompt text");
  await wait(() => (H.contexts.c1 || "").includes("紧凑旧摘要"), "context not injected after open");
  const progress = H.db.progress.find(r => r.characterId === "c1");
  check(progress && progress.watermarkAt, "watermark set at migration");
  progress.watermarkAt = "2026-09-05T19:00:00.000Z";
  await H.api.emit("chat.message.created", { characterId: "c1", isGroup: false, message: { id: "x", role: "assistant", content: "..." } });
  await wait(() => H.calls.ai === 1, "auto organize did not call the model");
  check(H.calls.lastPrompt.includes("[s1]") && H.calls.lastPrompt.includes("旧记录"), "prompt has events and candidates");
  await wait(() => document.querySelectorAll(".sg-record").length === 2, "new record not rendered");
  check(H.db.progress.find(r => r.characterId === "c1").watermarkAt === H.history[43].createdAt, "watermark advanced to last message");
  await wait(() => (H.contexts.c1 || "").includes("9月12日一起去海边"), "context refreshed after organize");
  check((H.contexts.c1 || "").includes("尚待兑现"), "pending promise carries status");
  await H.api.emit("chat.message.created", { characterId: "c1", isGroup: true, message: { role: "assistant" } });
  await H.api.emit("chat.message.created", { characterId: "c1", isGroup: false, message: { role: "assistant" } });
  await pause(200); check(H.calls.ai === 1, "no extra model call without enough rounds");
  // 卡片内编辑 + 版本冲突
  const card = () => [...document.querySelectorAll(".sg-record")].find(c => c.querySelector(".sg-title span").textContent === "海边之约");
  const id = card().dataset.id;
  card().querySelector("details").open = true;
  card().querySelector('[data-action="edit"]').click();
  await wait(() => card().querySelector("form[data-editor]"), "inline editor did not open");
  let form = card().querySelector("form[data-editor]");
  form.elements.promptSummary.value = "我改过的摘要"; form.elements.recallMode.value = "priority";
  const col = Object.keys(H.db).find(k => k.startsWith("mem_"));
  const live = H.db[col].find(r => r.id === id); const original = live.updatedAt; live.updatedAt = "2099-01-01T00:00:00.000Z";
  form.requestSubmit(); await wait(() => card().querySelector("[data-card-notice]").textContent.includes("已变化"), "stale edit not rejected");
  live.updatedAt = original; form = card().querySelector("form[data-editor]"); form.requestSubmit();
  await wait(() => card().querySelector("[data-card-notice]").textContent.includes("已更新"), "edit did not save");
  check(H.db[col].find(r => r.id === id).userEdited === true && H.db[col].find(r => r.id === id).promptSummary === "我改过的摘要", "edit persisted");
  check(card().querySelector("details").open, "card stays open after save");
  await wait(() => (H.contexts.c1 || "").includes("我改过的摘要"), "context uses edited summary");
  // 原消息气泡
  card().querySelector('[data-action="sources"]').click();
  await wait(() => card().querySelectorAll(".sg-msg").length === 2, "source bubbles");
  check(card().querySelector(".sg-msg.sg-user"), "user bubble aligned right");
  // 删除 → 墓碑，界面消失，注入撤掉
  card().querySelector('[data-action="edit"]').click();
  await wait(() => card().querySelector("form[data-editor]"), "editor reopen");
  card().querySelector('[data-action="delete"]').click(); await wait(() => $("delete-dialog").open, "delete dialog");
  $("confirm-delete").click(); await wait(() => document.querySelectorAll(".sg-record").length === 1, "card not removed");
  check(H.db[col].find(r => r.id === id).deletedAt, "tombstone kept");
  await wait(() => !(H.contexts.c1 || "").includes("我改过的摘要"), "deleted record still injected");
  // 筛选：发送方式
  $("filter-btn").click(); $("mode-chips").querySelector("input[value='relevant']").click();
  await wait(() => $("count").textContent.startsWith("0 条") && $("count").textContent.includes("已筛选"), "mode filter");
  $("clear-filters").click(); await wait(() => $("count").textContent.startsWith("1 条"), "clear filter");
  // 关掉拾光 → 注入写空串
  $("rules-btn").click();
  $("settings").elements.enabled.checked = false; $("settings").requestSubmit();
  await wait(() => H.contexts.c1 === "", "context not cleared when disabled");
  document.querySelector('#rules [data-tab="memories"]').click();
  // 换角色：c2 没有历史、没有旧记录
  $("character").value = "c2"; $("character").dispatchEvent(new Event("change"));
  await wait(() => document.querySelector("#cards .sg-empty"), "c2 empty state");
  check(!document.querySelector(".sg-record"), "c2 has no cards");
  return { passed: true, checks };
})().then(r => { window.shiguangCheck = r; }, e => { window.shiguangCheck = { passed: false, error: (e && e.message || String(e)) + (window.__err ? " | handler: " + window.__err : "") }; });
`;

const page = appHtml.replace("<script>", `<script>${MOCK}</script><script>`).replace("</body>", `<script>${TEST}</script></body>`);
await fs.writeFile(path.join(out, "index.html"), page);

const profile = await fs.mkdtemp(path.join(out, "profile-"));
const child = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!port) throw new Error("Chromium did not start");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  const pending = new Map(); let serial = 0;
  socket.onmessage = event => { const m = JSON.parse(event.data); if (m.id) { const t = pending.get(m.id); pending.delete(m.id); if (m.error) t.reject(new Error(m.error.message)); else t.resolve(m.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable");
  for (const [width, theme] of [[320, "light"], [390, "light"], [736, "dark"]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: width === 736 ? 414 : 900, deviceScaleFactor: 1, mobile: true });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await send("Page.navigate", { url: `file://${out}/index.html?w=${width}&theme=${theme}` });
    let report;
    for (let i = 0; i < 200; i++) {
      const result = await send("Runtime.evaluate", { expression: "JSON.stringify(window.shiguangCheck || null)", returnByValue: true });
      report = JSON.parse(result.result.value || "null");
      if (report) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!report?.passed) throw new Error(JSON.stringify(report || { error: "browser check timed out" }));
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await fs.writeFile(path.join(out, `${width}-${theme}.png`), Buffer.from(shot.data, "base64"));
    console.log(`${width}px ${theme}: ${report.checks} browser checks passed`);
  }
} finally {
  socket?.close(); child.kill();
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  await fs.rm(profile, { recursive: true, force: true });
}
