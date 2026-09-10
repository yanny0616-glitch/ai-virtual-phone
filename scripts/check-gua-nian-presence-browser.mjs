import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'out/gua-nian-presence-browser');
await fs.mkdir(out,{recursive:true});
const plugin=(await fs.readFile(path.join(root,'chat-plugins/affection-ledger.js'),'utf8')).replace('export default','window.plugin=');
const TEST=String.raw`
try {
 let checks=0;const check=(ok,msg)=>{if(!ok)throw Error(msg);checks++;};
 const vars=new Map([['presence',{managedBy:'guanian-host',at:Date.now(),doing:'开会',place:'公司',energy:60,mood:'平静'}]]);
 const hooks=new Map(),slots=new Map();let cleanup,refreshes=0;
 window.addEventListener('guanian-presence-refresh',()=>refreshes++);
 const ctx={
  data:{sessions:{get:()=>({contactId:'c'})},characters:{get:()=>({id:'c',name:'角色'})},variables:{get:name=>vars.get(name),set:(name,value,scope,id)=>{vars.set(name,value);for(const fn of hooks.get('variables.changed')||[])fn({name,scope,targetId:id});},unset:name=>vars.delete(name)}},
  system:{storage:{get(){},set(){},remove(){}},settings:{get(){}},log(){}},
  hooks:{transform(){return ()=>{};},on:(name,fn)=>{if(!hooks.has(name))hooks.set(name,new Set());hooks.get(name).add(fn);return ()=>hooks.get(name).delete(fn);}},
  ui:{injectCSS:text=>{const style=document.createElement('style');style.textContent=text;document.head.appendChild(style);},toast(){},slot:(name,fn)=>slots.set(name,fn),openModal:fn=>{cleanup=fn(document.getElementById('modal'),{close:()=>cleanup?.()});return {close:()=>cleanup?.()};}},
 };
 plugin.setup(ctx);
 slots.get('chat.inputToolbar')(document.getElementById('toolbar'),{sessionId:'s'});
 document.querySelector('#toolbar > div').click();
 check(refreshes===1,'opening information panel must request fresh schedules');
 check(document.querySelector('.afl-live-presence').textContent.includes('开会'),'initial state');
 const input=document.querySelector('[data-k="relText"]');input.value='未保存的草稿';
 ctx.data.variables.set('presence',{managedBy:'guanian-host',at:Date.now(),doing:'吃饭',place:'家',syncStatus:'cached'},'character','c');
 check(document.querySelector('.afl-live-presence').textContent.includes('吃饭'),'live panel update');
 check(document.querySelector('.afl-live-presence').textContent.includes('同步暂未成功'),'cached state note');
 check(document.querySelector('[data-k="relText"]')===input&&input.value==='未保存的草稿','live update must preserve unrelated input');
 ctx.data.variables.set('presence',{managedBy:'guanian-host',at:Date.now(),doing:'其他角色的事'},'character','other');
 check(!document.querySelector('.afl-live-presence').textContent.includes('其他角色'),'other role event must not repaint current panel');
 ctx.data.variables.set('presence',{managedBy:'guanian-host',at:Date.now(),doing:'<img src=x onerror=alert(1)>'},'character','c');
 check(!document.querySelector('.afl-live-presence img'),'escape schedule text');
 ctx.data.variables.set('presence',{managedBy:'guanian-host',at:Date.now(),doing:'',label:'状态待同步'},'character','c');
 check(document.querySelector('.afl-live-presence').textContent.includes('状态待同步'),'missing day must not claim online');
 cleanup();check(hooks.get('variables.changed').size===0,'closed modal must release its listener');
 window.presenceCheck={passed:true,checks};
} catch(e){window.presenceCheck={passed:false,error:String(e.stack||e)};}
`;
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="toolbar"></div><div id="modal"></div><script>'+plugin+'</script><script>'+TEST+'</script></body></html>');
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
      const result = await send("Runtime.evaluate", { expression: "JSON.stringify(window.presenceCheck || null)", returnByValue: true });
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
