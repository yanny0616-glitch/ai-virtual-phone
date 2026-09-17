// 小剧场 APP 预览：给 index.html 套一个内存版 AiPhone 假 SDK（ai.generate 返回预置的文字 / HTML 样稿），
// 产出可点的 design/xiao-ju-chang/preview.html，并在无头 Chromium 里跑一遍主流程截图 + 收集报错。
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const APP = path.join(ROOT, 'ai-virtual-phone/custom-apps/xiao-ju-chang');
const OUT = await fsp.mkdtemp('/tmp/xjc-browser-check-');
const PREVIEW = path.join(OUT, 'preview.html');
await fsp.mkdir(OUT, { recursive: true });
const onlyBuild = process.argv.includes('--build-only');

const avatar = (ch, a, b) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="40" font-size="26" text-anchor="middle" fill="#fff" font-family="serif">${ch}</text></svg>`);

const SAMPLE_TEXT = `标题：雨夜第三支伞
便利店的自动门在十一点四十分响了第三次。
沈烬言没有抬头，手里那罐没开的咖啡已经被握得不凉了。货架尽头的伞桶里插着三把透明伞，两把是店里的，一把是他半小时前顺手放进去的。

「你到底在等谁？」店员终于忍不住问。
他笑了一下，把咖啡放回冷柜，「等一个不会来的人。」话音刚落，门又响了。

这次进来的人头发湿了一半，站在门口抖水，抬头看见他时愣了一下，然后很自然地走过去，从伞桶里抽出那把他放的伞。
「我就知道你会放这儿。」

他没说话，只是把刚放回去的咖啡又拿了出来，递过去。`;

const SAMPLE_HTML = `标题：直播间 · 翻车实录
<div style="font-family:system-ui;background:#111;color:#eee;border-radius:10px;overflow:hidden">
<div style="padding:10px 12px;display:flex;justify-content:space-between;font-size:12px;background:#1c1c1c"><b style="color:#ff5c7a">● LIVE</b><span>在线 8,241</span></div>
<div style="position:relative;height:150px;background:linear-gradient(135deg,#2b1d3a,#0d2a3a);overflow:hidden">
<style>@keyframes fly{from{transform:translateX(320px)}to{transform:translateX(-260px)}}.dm{position:absolute;white-space:nowrap;font-size:12px;animation:fly 7s linear infinite}</style>
<span class="dm" style="top:10px;animation-delay:0s">主播的猫又上桌了哈哈哈</span>
<span class="dm" style="top:36px;animation-delay:1.5s;color:#ffd166">刚才那句话是对谁说的？？</span>
<span class="dm" style="top:62px;animation-delay:3s">别装了 弹幕都看到了</span>
<span class="dm" style="top:88px;animation-delay:4.2s;color:#8be9fd">今晚不下播不睡</span>
<span class="dm" style="top:114px;animation-delay:5.5s">「我不是，我没有」——沈烬言，刚刚</span>
</div>
<div style="padding:12px;font-size:13px;line-height:1.7">镜头外的手机震了一下，他低头看了一眼，耳根悄悄红了。弹幕瞬间被「谁发的！」刷屏。<br>他清了清嗓子：「……广告时间。」</div>
<div style="display:flex;gap:8px;padding:0 12px 12px"><button data-action="逼他念出那条消息" style="flex:1;padding:8px;border:0;border-radius:6px;background:#ff5c7a;color:#fff;font-size:12px">逼他念出来</button><button data-action="帮他打岔换话题" style="flex:1;padding:8px;border:1px solid #444;border-radius:6px;background:transparent;color:#eee;font-size:12px">帮他打岔</button></div>
</div>`;

const mock = `<script>
window.AiPhone = (() => {
  const __mock = true;
  const tables = {};
  let n = 100;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 有 onChunk 就分 14 段吐，模拟宿主流式；没有就整段等
  const feed = async (text, h, ms) => { if (!h || !h.onChunk) { await sleep(ms); return; } const n = 14, step = Math.ceil(text.length / n); for (let i = 0; i < text.length; i += step) { h.onChunk({ delta: text.slice(i, i + step), text: text.slice(0, i + step) }); await sleep(ms / n); } };
  const SAMPLE_TEXT = ${JSON.stringify(SAMPLE_TEXT)};
  const SAMPLE_HTML = ${JSON.stringify(SAMPLE_HTML)};
  const chars = [
    { id: 'c1', name: '沈烬言', avatar: ${JSON.stringify(avatar('沈', '#4a3f8f', '#8d7bff'))}, persona: '二十七岁，夜班便利店常客。', personality: '嘴硬，记性好。', embeddedWorldBook: { entries: [{ key: ['便利店'], comment: '常去的店', content: '街角 24 小时便利店，老板娘姓周。' }] } },
    { id: 'c2', name: '宁妍', avatar: ${JSON.stringify(avatar('宁', '#8f3f5f', '#ff7bb0'))} },
    { id: 'c3', name: '周叙白', avatar: ${JSON.stringify(avatar('周', '#2f6f6f', '#5fd0c0'))} },
  ];
  const pick = instruction => /整体输出为一段 HTML/.test(instruction) ? SAMPLE_HTML : /允许 HTML 与纯文字混排/.test(instruction) ? SAMPLE_TEXT + '\\n\\n\`\`\`html\\n' + SAMPLE_HTML.split('\\n').slice(1).join('\\n') + '\\n\`\`\`' : SAMPLE_TEXT;
  const wrap = (instruction, text) => { const m = instruction.match(/包在 <([a-zA-Z0-9_-]+)>/); return m ? text.replace(/^(标题：[^\\n]*\\n)?/, '$1<' + m[1] + '>\\n') + '\\n</' + m[1] + '>' : text; };
  window.__mockCalls = [];
  return { __mock,
    db: { list: async (t,q={}) => (tables[t] || []).slice(q.offset||0,(q.offset||0)+(q.limit||100)).map(r => ({ ...r })), get: async (t, id) => (tables[t] || []).find(r => r.id === id) || null,
      create: async (t, d) => { const row = { ...d, id: 'x' + (++n) }; (tables[t] ||= []).push(row); return { ...row }; },
      update: async (t, id, d) => { const row = (tables[t] || []).find(r => r.id === id); if (row) Object.assign(row, d); return { ...row }; },
      delete: async (t, id) => { tables[t] = (tables[t] || []).filter(r => r.id !== id); return { ok: true }; } },
    characters: { list: async () => chars.map(c => ({ id: c.id, name: c.name, avatar: c.avatar })), get: async id => chars.find(c => c.id === id) || null },
    app: { getLaunchContext: async () => ({}), close: async () => {} },
    user: { getProfile: async q => ({ name: '用户-'+q.characterId }), getPersona: async q => ({ text: '人设-'+q.characterId }) },
    ai: {
      generate: async (p, h) => { window.__mockCalls.push({ kind: 'generate', stream: !!(h && h.onChunk), ...p }); const out = wrap(p.instruction, pick(p.instruction)); await feed(out, h, 900); return { text: out, model: 'mock-model' }; },
      chat: async (p, h) => { window.__mockCalls.push({ kind: 'chat', stream: !!(h && h.onChunk), ...p }); const u = p.messages.find(m => m.role === 'user'); const out = wrap(u.content, pick(u.content)); await feed(out, h, 900); return { text: out }; },
    },
    chat: { readHistory: async () => ({ messages: [ { role: 'user', content: '今晚下雨了。', createdAt: new Date().toISOString() }, { role: 'assistant', content: '带伞了吗？没带的话我在店里等你。', createdAt: new Date().toISOString() } ] }) },
    memory: { readCore:async()=>({text:'core'}),readLongTerm:async()=>({text:'long'}),readShortTerm:async()=>({text:'short'}),add: async p => { window.__mockCalls.push({ kind: 'memory', ...p }); return { ok: true }; } },
    media: { pick: async () => null, save: async () => ({ ok: true }) },
    ui: { toast: async () => ({}) },
  };
})();
</script>`;
const html = (await fsp.readFile(path.join(APP, 'index.html'), 'utf8')).replace('<script>', mock + '<script>');
await fsp.mkdir(path.dirname(PREVIEW), { recursive: true });
await fsp.writeFile(PREVIEW, html);
console.log('preview →', PREVIEW);
if (onlyBuild) process.exit(0);

const profile = await fsp.mkdtemp('/tmp/shot-xjc-');
const child = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server', '--hide-scrollbars', '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
// 脚本中途抛错或被打断也要把子进程带走，不然孤儿 Chromium 会一直吃 CPU
process.on('exit', () => { try { child.kill('SIGKILL'); } catch {} });
if (!globalThis.__exitHooksInstalled) { globalThis.__exitHooksInstalled = true; process.on('uncaughtException', e => { console.error(e); process.exit(1); }); process.on('unhandledRejection', e => { console.error(e); process.exit(1); }); process.on('SIGINT', () => process.exit(130)); process.on('SIGTERM', () => process.exit(143)); }
let port;
for (let i = 0; i < 100; i++) { try { port = Number((await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
const pending = new Map(); let serial = 0; const logs = [];
socket.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ' ' + m.params.args.map(a => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tap = sel => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no '+${JSON.stringify(sel)}); e.click(); return true;})()`);
const shot = async (name, full = false) => { await sleep(400); const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }); await fsp.writeFile(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); console.log('shot', name); };
const waitFor = async (expr, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(150); } throw new Error('timeout: ' + expr); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: 'file://' + PREVIEW });
await waitFor(`!!window.__xjc && window.__xjc.state.combos.length > 0`);
const view = v => tap(`#tabbar [data-v="${v}"]`);
const setTheme = async t => { await evaluate(`(()=>{window.__xjc.settings.set({theme:${JSON.stringify(t)}}); return true})()`); await sleep(200); };


const frameEval = async expression => {
  const tree=await send('Page.getFrameTree');const frame=tree.frameTree.childFrames.at(-1).frame;
  const world=await send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'xjc-check'});
  const r=await send('Runtime.evaluate',{contextId:world.executionContextId,expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
};
try {
  await tap('#btn-gen');await waitFor(`window.__xjc.state.busy`);
  await evaluate(`window.__xjc.state.character=window.__xjc.state.characters[1]`);
  await waitFor(`!window.__xjc.state.busy && !!window.__xjc.state.result`);await sleep(700);
  assert.equal(await evaluate(`window.__xjc.state.result.characterId`),'c1');
  const heights=[];
  for(let i=0;i<4;i++){heights.push(await evaluate(`document.querySelector('#result-host iframe').offsetHeight`));await sleep(650)}
  assert.equal(new Set(heights).size,1,`height must stabilize: ${heights}`);
  await frameEval(`document.getElementById('xjc-content').innerHTML='<div id="expand" style="height:1200px">Expanded</div>'`);await sleep(800);
  const expanded=await evaluate(`document.querySelector('#result-host iframe').offsetHeight`);
  await frameEval(`document.getElementById('expand').style.display='none'`);await sleep(800);
  const collapsed=await evaluate(`document.querySelector('#result-host iframe').offsetHeight`);
  assert.ok(expanded>1200&&collapsed<200,`${expanded} -> ${collapsed}`);
  await evaluate(`window.__xjc.stage.showResult(window.__xjc.state.result)`);await sleep(300);
  const before=await frameEval(`({font:getComputedStyle(document.body).fontSize,line:getComputedStyle(document.body).lineHeight})`);
  await frameEval(`window.keepInteractiveState=42`);
  await evaluate(`window.__xjc.settings.set({fontScale:1.08,lineHeight:'loose'})`);await sleep(150);
  const after=await frameEval(`({font:getComputedStyle(document.body).fontSize,line:getComputedStyle(document.body).lineHeight,kept:window.keepInteractiveState})`);
  assert.notEqual(after.font,before.font);assert.notEqual(after.line,before.line);assert.equal(after.kept,42);
  console.log('PASS iframe height stable/shrinks; font and line height update without recreating document');
  // Download through actual export button; inspect the browser-written JSON file.
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:OUT});
  await view('settings');await tap('#set-cats [data-p="data"]');
  await evaluate(`(()=>{[...document.querySelectorAll('#pane-data button')].find(b=>b.textContent==='导出').click()})()`);
  let filename;
  for(let i=0;i<40;i++){filename=(await fsp.readdir(OUT)).find(n=>n.endsWith('.json'));if(filename)break;await sleep(100)}
  assert.ok(filename,'export must produce a real downloaded file');
  const backup=JSON.parse(await fsp.readFile(path.join(OUT,filename),'utf8'));assert.equal(backup.app,'float.xiaojuchang');assert.equal(backup.combos.length,5);
  await tap('#sheet-close');await sleep(350);
  console.log('PASS export creates a valid downloadable JSON file');
  // Two UI clicks during a save must create only one combo.
  await view('library');await tap('#btn-new-combo');
  const created=await evaluate(`(async()=>{const a=window.__xjc;const d=a.state.compose;d.name='Double save';d.promptIds=[a.state.prompts[0].id];const before=a.state.combos.length;await Promise.all([a.library.saveCompose(d),a.library.saveCompose(d)]);return a.state.combos.length-before})()`);
  assert.equal(created,1);
  await evaluate(`window.__xjc.stage.handlers().fav(window.__xjc.state.result)`);
  await view('fav');await tap('#fav-list .fav-item');
  await evaluate(`(()=>{[...document.querySelectorAll('#fav-list button')].find(b=>b.textContent==='删除').click()})()`);
  await tap('#sheet-content .warn');await sleep(150);
  await evaluate(`window.__xjc.stage.handlers().fav(window.__xjc.state.result)`);
  assert.equal(await evaluate(`window.__xjc.state.favorites.length`),1);
  console.log('PASS repeat saves coalesced; deleted favorite can be saved again');
  // Actual nested frame action with a fullscreen favorite while stage result is absent.
  await evaluate(`(()=>{const a=window.__xjc;const c=a.state.combos.find(c=>c.output.mode==='html');a.switchView('stage');a.stage.run(c)})()`);
  await waitFor(`!window.__xjc.state.busy`);await evaluate(`window.__xjc.stage.handlers().fav(window.__xjc.state.result)`);
  await view('fav');
  await evaluate(`(()=>{const a=window.__xjc;const r=a.state.favorites.find(r=>r.segments.some(s=>s.type==='html'));a.favorites.openId=r.id;a.favorites.render();[...document.querySelectorAll('#fav-list button')].find(b=>b.textContent==='打开').click();a.state.result=null})()`);
  await sleep(300);
  const count=await evaluate(`window.__mockCalls.filter(c=>c.kind==='generate').length`);
  await evaluate(`window.postMessage({source:'xjc-frame',type:'action',id:'unknown',text:'forged'},'*')`);await sleep(100);
  assert.equal(await evaluate(`window.__mockCalls.filter(c=>c.kind==='generate').length`),count);
  await frameEval(`document.querySelector('[data-action]').click()`);
  await waitFor(`window.__mockCalls.filter(c=>c.kind==='generate').length>${count}`);await waitFor(`!window.__xjc.state.busy`);
  assert.equal(await evaluate(`window.__xjc.state.view`),'stage');
  assert.ok(await evaluate(`window.__mockCalls.filter(c=>c.kind==='generate').at(-1).instruction.includes('镜头外的手机震了一下')`));
  assert.equal(logs.length,0,logs.join(' | '));
  console.log('PASS real fullscreen iframe action continues bound story; forged message rejected');
} finally {socket.close();child.kill()}
