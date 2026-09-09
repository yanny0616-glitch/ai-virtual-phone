// 真 Chromium + 生产 SDK 外壳 + 拾光产物；模拟宿主数据库，不调用模型。
// 验证冷启动注册、请求/结果关联、切换角色、关闭开关和权限拒绝。
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = f => fs.readFile(path.join(root, f), "utf8");
const runner = await read("components/app-market/custom-app-runner.tsx");
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const create = runner.slice(runner.indexOf("function createCustomAppSrcDoc("), runner.indexOf("function hasPermission("));
const context = vm.createContext({ rewriteAssetRefs: html => html });
vm.runInContext(compile(create) + ";globalThis.create = createCustomAppSrcDoc;", context);
const app = { id: "sg", name: "拾光", permissions: ["chat.context", "chat.read", "chat.read.background"],
  manifest: JSON.parse(await read("custom-apps/shiguang/manifest.json")), entryHtml: await read("custom-apps/shiguang/index.html") };
const srcDoc = context.create(app, "frame", { background: true, characterId: "c1" });
const registration = runner.slice(runner.indexOf('    if (action === "chat.registerContextProvider")'), runner.indexOf('    if (action === "tools.registerHandler")'));
const dispatch = compile(`async function register(action) { ${registration} }`);
const testScript = `
const app = ${JSON.stringify({ ...app, entryHtml: undefined })};
const registeredToolHandlersRef = { current: new Set() }, backgroundTool = true;
const postBackgroundToolIfReady = () => {};
const requirePermission = p => { if (!app.permissions.includes(p)) throw new Error('permission: ' + p); };
const requireAnyPermission = ps => { if (!ps.some(p => app.permissions.includes(p))) throw new Error('permission: read'); };
${dispatch}
const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts allow-downloads';
const pending = new Map(), calls = [], errors = [];
let enabled = true, registered = false, serial = 0;
const rows = name => name === 'settings' ? [{ enabled, tokenBudget: 800 }] : [
  { id: name, title: '厦门旅行', keywords: ['厦门'], promptSummary: name + '：十一一起去厦门看海。', recallMode: 'relevant' },
  { id: name + '-cake', title: '生日的惊喜', keywords: ['草莓蛋糕'], promptSummary: name + '：生日买了草莓蛋糕，奶油太甜。', recallMode: 'relevant' }
];
window.addEventListener('message', async e => {
  if (e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.source !== 'ai-phone-custom-app-frame' || d.frameId !== 'frame') return;
  if (d.type === 'tool.result') {
    const job = pending.get(d.toolRequestId); if (!job) return;
    pending.delete(d.toolRequestId); d.ok ? job.resolve(d.result) : job.reject(new Error(d.error)); return;
  }
  if (d.type !== 'request') return;
  calls.push(d.action);
  try {
    let result;
    if (d.action === 'chat.registerContextProvider') { result = await register(d.action); registered = true; }
    else if (d.action === 'events.subscribe') result = { ok: true };
    else if (d.action === 'db.list') {
      const name = d.payload.collection;
      if (name.includes('c1')) await new Promise(r => setTimeout(r, 60));
      result = rows(name);
    } else throw new Error('unexpected write/model/API: ' + d.action);
    frame.contentWindow.postMessage({ source: 'ai-phone-custom-app-host', frameId: 'frame', requestId: d.requestId, ok: true, result }, '*');
  } catch (err) {
    errors.push(String(err));
    frame.contentWindow.postMessage({ source: 'ai-phone-custom-app-host', frameId: 'frame', requestId: d.requestId, ok: false, error: String(err) }, '*');
  }
});
const invoke = (cid, content) => new Promise((resolve, reject) => {
  const id = 'req-' + (++serial); pending.set(id, { resolve, reject });
  frame.contentWindow.postMessage({ source: 'ai-phone-custom-app-host', frameId: 'frame', type: 'tool.invoke', toolRequestId: id,
    handler: '__prompt_context__', args: { characterId: cid, sessionId: 's-' + cid, messages: [{ role: 'user', content }] } }, '*');
});
frame.srcdoc = ${JSON.stringify(srcDoc)}; document.body.append(frame);
(async () => {
  const start = performance.now();
  while (!registered) { if (performance.now() - start > 8000) throw new Error('provider registration timeout'); await new Promise(r => setTimeout(r, 20)); }
  const registrationMs = performance.now() - start;
  const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
  const [a, b] = await Promise.all([invoke('c1', '还记得厦门吗'), invoke('c2', '厦门')]);
  assert(a.includes('mem_c1') && !a.includes('mem_c2'), 'first concurrent reply scoped');
  assert(b.includes('mem_c2') && !b.includes('mem_c1'), 'second concurrent reply scoped');
  assert((await invoke('c1', '想吃蛋糕')).includes('草莓蛋糕'), 'browser segmentation recalls short noun');
  assert((await invoke('c1', '奶油太甜了')).includes('奶油太甜'), 'browser summary fallback recalls fact');
  assert(await invoke('c1', '咖啡') === '', 'no match must return empty');
  enabled = false;
  assert(await invoke('c1', '厦门') === '', 'settings re-read on every request');
  enabled = true;
  assert((await invoke('c1', '厦门')).includes('厦门'), 're-enabled without restarting');
  assert(errors.length === 0, errors.join(';'));
  assert(calls.every(a => ['events.subscribe', 'chat.registerContextProvider', 'db.list'].includes(a)), 'provider is read-only');
  app.permissions = ['chat.context'];
  let denied = false; try { await register('chat.registerContextProvider'); } catch { denied = true; }
  assert(denied, 'read permission required');
  app.permissions = ['chat.context', 'chat.read']; app.manifest.extensions.prompt = {};
  denied = false; try { await register('chat.registerContextProvider'); } catch { denied = true; }
  assert(denied, 'manifest declaration required');
  window.report = { passed: true, registrationMs: Math.round(registrationMs), checks: 10 };
})().catch(e => { window.report = { passed: false, error: e.stack || String(e) }; });
`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-prompt-bridge-"));
const html = path.join(dir, "test.html");
await fs.writeFile(html, `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${testScript.replace(/<\/script/gi, "<\\/script")}</script></body></html>`);
const profile = path.join(dir, "profile");
const child = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!port) throw new Error("Chromium did not start");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(); let seq = 0;
  socket.onmessage = event => { const m = JSON.parse(event.data); if (!m.id) return; const job = pending.get(m.id); pending.delete(m.id); if (m.error) job.reject(new Error(m.error.message)); else job.resolve(m.result); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable");
  await send("Page.navigate", { url: `file://${html}` });
  let report;
  for (let i = 0; i < 120; i++) {
    const result = await send("Runtime.evaluate", { expression: "JSON.stringify(window.report || null)", returnByValue: true });
    report = JSON.parse(result.result.value || "null");
    if (report) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (!report?.passed) throw new Error(JSON.stringify(report || { error: "bridge test timed out" }));
  console.log(`PASS 真 SDK + 拾光 iframe：${report.checks} 项；冷启动注册 ${report.registrationMs}ms（本机 Chromium，非手机性能）`);
} finally {
  socket?.close(); child.kill();
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  await fs.rm(dir, { recursive: true, force: true });
}
