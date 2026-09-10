// 挂念后台与设置面板：真实 Chromium 运行产物，宿主与网络使用受控假实现。
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "out/gua-nian-backend-check");
await fs.mkdir(out, { recursive: true });
const appHtml = await fs.readFile(path.join(root, "custom-apps/gua-nian/index.html"), "utf8");


const TEST = String.raw`
  (async () => {
    let checks = 0;
    const check = (condition, message) => { if (!condition) throw Error(message); checks++; };
    S.settings = { ...SET_DEF, cloudUrl: 'https://cloud.invalid', cloudKey: 'test', cloudRecheck: true, characterIds: [] };
    for (let i = 0; i < 12; i++) {
      const cx = ctxOf({id: 'c' + i, name: '角色' + i});
      cx.plan = { date: todayStr(), items: [] };
      S.byId[cx.character.id] = cx; S.order.push(cx.character.id);
      cx._planSync = { date: todayStr(), cloudUrl: S.settings.cloudUrl, status: i === 0 ? 'failed' : 'synced', at: Date.now(), message: i === 0 ? '网络失败' : '计划已保存' };
    }
    S.cur = 'c0'; S.characters = allCx().map(cx => cx.character);
    renderDiag = () => { $('#subview').innerHTML = '<div class="card">诊断内容</div>'; };
    renderUsage = () => { $('#subview').innerHTML = '<div class="card">用量内容</div>'; };
    renderArchive = () => { $('#view').innerHTML = '<div class="card">历史记录</div>'; };
    let retries = 0, requests = 0, failRead = false;
    retryPlanSync = async cx => { check(cx.character.id === 'c0', 'retry routed to wrong character'); retries++; };
    window.AiPhone = { chat: { readHistory: async () => ({sessionId:'s', messages:[]}) } };
    cloudFetchBounded = async (action, init, params) => {
      check(action === 'guanian-history' && init.method === 'GET', 'history must only read');
      requests++;
      if (failRead) throw Error('offline');
      return { ok:true, sessionId:params.sessionId, entries:[
        {job_id:'job_old', trigger_key:'timedwake:timed_wake_capp_app_gua.nian_hash_123_abc', created_at:new Date().toISOString(), consumed_at:new Date().toISOString(), raw_text:'醒了没 <img src=x onerror="window.hacked=1">'},
        {job_id:'job_old2', trigger_key:'timedwake:timed_wake_capp_app_gua.nian_hash_124_def', created_at:new Date().toISOString(), raw_text:'醒了没'},
      ]};
    };
    for (const tab of ['today', 'heart', 'archive']) {
      S.tab = tab; render(); renderCloudSync();
      check(!$('#cloud-sync'), tab + ' still has global sync');
      check(!$('#cloud-history'), tab + ' still has backend history');
    }
    S.tab = 'back'; render();
    check($('#cloud-sync').closest('#view'), 'sync must be inside backend');
    check($('#cloud-sync').children.length === 1, 'sync should be a single collapsed section');
    check(!$('#cloud-sync details').open, 'sync should initially collapse');
    check($('#cloud-sync summary').textContent.includes('12 个角色'), 'all character count');
    check($('#cloud-sync summary').textContent.includes('有未完成项'), 'failure summary');
    $('#cloud-sync details').open = true; renderCloudSync();
    check($('#cloud-sync details').open, 'refresh collapsed open details');
    $('#cloud-sync [data-sync-retry="c0"]').click();
    check(retries === 1, 'retry button did not fire');
    $('#cloud-sync details').open = false;
    $('#cloud-history details').open = true;
    await $('#cloud-history-refresh').onclick();
    check(requests === 1, 'unexpected background query');
    check($('#cloud-history').textContent.includes('job_old2'), 'second orphan missing');
    check($('#cloud-history').textContent.includes('当前计划未关联'), 'orphan must be traceable without a local plan');
    check(!$('#cloud-history img'), 'raw text not escaped');
    failRead = true; await $('#cloud-history-refresh').onclick();
    check($('#cloud-history').textContent.includes('offline'), 'failure disappeared');
    check($('#cloud-history').textContent.includes('job_old2'), 'failure erased prior evidence');
    $('#cloud-history details').open = false;
    document.querySelector('[data-sub="usage"]').click();
    check(!!$('#cloud-sync') && !!$('#cloud-history'), 'backend tab switch removed sync/history');
    for (const tab of ['today', 'heart', 'archive']) {
      S.tab = tab; render();
      check(!$('#cloud-sync'), 'leaving backend retained sync');
    }
    S._settingsEffects = ['设置已保存，本轮验证说明'];
    renderSettingsEffects();
    check($('#settings-effects').closest('#sheet'), 'effects must be inside settings sheet');
    openSheet();
    check(document.body.classList.contains('sheet-open'), 'settings sheet did not open');
    check($('#settings-effects').textContent.includes('本轮验证说明'), 'effects unavailable in settings');
    closeSheet();
    for (const tab of ['today', 'heart', 'archive', 'back']) {
      S.tab = tab; render();
      check(!document.body.classList.contains('sheet-open'), 'tab reopened settings');
      check(!$('#view').textContent.includes('本轮验证说明'), 'effects leaked into page');
      const box = $('#settings-effects').getBoundingClientRect();
      check(box.top >= innerHeight || box.bottom <= 0 || getComputedStyle($('#sheet')).visibility === 'hidden', 'closed sheet effects visible');
    }
    S.tab = 'back'; render();
    window.guanianCheck = {passed:true, checks};
  })().catch(error => { window.guanianCheck = {passed:false, error:String(error.stack || error)}; });
`;
const page = appHtml.replace(/  init\(\);\s*\}\)\(\);\s*<\/script>/, TEST + '\n})();</script>');
if (page === appHtml) throw Error('init hook not found');
await fs.writeFile(path.join(out, 'index.html'), page);
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
  for (const [width, theme] of [[390, "light"]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: width === 736 ? 414 : 900, deviceScaleFactor: 1, mobile: true });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await send("Page.navigate", { url: `file://${out}/index.html?w=${width}&theme=${theme}` });
    let report;
    for (let i = 0; i < 200; i++) {
      const result = await send("Runtime.evaluate", { expression: "JSON.stringify(window.guanianCheck || null)", returnByValue: true });
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
