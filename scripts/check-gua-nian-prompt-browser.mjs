import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';import fsp from 'node:fs/promises';import path from 'node:path';
const OUT=await fsp.mkdtemp('/tmp/gua-nian-prompt-check-');
const previewFile=path.join(OUT,'preview.html');
let html=await fsp.readFile(fileURLToPath(new URL('../custom-apps/gua-nian/index.html',import.meta.url)),'utf8');
html=html.replace(/  init\(\);\s*\}\)\(\);\s*<\/script>/,` S.settings={...SET_DEF};S.characters=[{id:'c',name:'角色'}];S.order=['c'];S.cur='c';S.byId.c=ctxOf(S.characters[0]);openSheet();window.promptTest={S,readSheet};})();</script>`);
await fsp.writeFile(previewFile,html);
const profile = await fsp.mkdtemp('/tmp/shot-peimian-');
const child = spawn('chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server', '--hide-scrollbars', '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let port;
for (let i = 0; i < 100; i++) { try { port = Number((await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
const pending = new Map(); let serial = 0;
socket.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '')); return r.result.value; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tap = sel => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no '+${JSON.stringify(sel)}); e.click(); return true;})()`);
const shot = async (name, full = true) => { await sleep(500); await evaluate(`(()=>{let s=document.getElementById('shot-style'); if(!s){s=document.createElement('style'); s.id='shot-style'; document.head.appendChild(s);} s.textContent=${JSON.stringify('.tabbar{position:absolute!important;bottom:auto!important;top:0!important;opacity:0}')}; s.disabled=!${full}; return true;})()`); const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }); await fsp.writeFile(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); console.log('shot', name); };

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: 'file://' + previewFile });
await sleep(1500);

try {
const initial=await evaluate(`({opacity:getComputedStyle(document.getElementById('day-prompt-mask')).opacity,pointer:getComputedStyle(document.getElementById('day-prompt-mask')).pointerEvents})`);
if(initial.opacity!=='0'||initial.pointer!=='none')throw new Error('settings wrongly activates editor mask');
console.log('PASS opening settings leaves editor mask hidden and non-interactive');
await tap('#edit-dayPrompt');await sleep(400);
const opened=await evaluate(`getComputedStyle(document.getElementById('day-prompt-mask')).opacity`);if(opened!=='1')throw new Error('editor mask not shown');
const r=await send('Page.captureScreenshot',{format:'png'});await fsp.writeFile(path.join(OUT,'editor.png'),Buffer.from(r.data,'base64'));
console.log(await evaluate(`(()=>{const d=document.getElementById('day-prompt-sheet'),t=document.getElementById('day-prompt-input');return {open:document.body.classList.contains('day-prompt-open'),font:getComputedStyle(t).fontFamily,overflow:d.scrollWidth>d.clientWidth,defaultText:t.value.includes('角色能独立决定和执行')};})()`));
await evaluate(`document.getElementById('day-prompt-input').value='草稿';true`);await tap('#day-prompt-close');
await sleep(350);const closed=await evaluate(`({opacity:getComputedStyle(document.getElementById('day-prompt-mask')).opacity,pointer:getComputedStyle(document.getElementById('day-prompt-mask')).pointerEvents})`);if(closed.opacity!=='0'||closed.pointer!=='none')throw new Error('editor mask remains after close');console.log('PASS closing editor restores clear interactive settings');
console.log(await evaluate(`({cancelPreserves:document.getElementById('set-dayPrompt').value!=='草稿',parentOpen:document.body.classList.contains('sheet-open')})`));
await tap('#edit-dayPrompt');await evaluate(`document.getElementById('day-prompt-input').value='自定义日程';true`);await tap('#day-prompt-done');
console.log(await evaluate(`({draft:window.promptTest.readSheet().dayPrompt,persistedUnchanged:window.promptTest.S.settings.dayPrompt!=='自定义日程'})`));
}finally{socket.close();child.kill();await fsp.rm(profile,{recursive:true,force:true});await fsp.rm(OUT,{recursive:true,force:true});}
