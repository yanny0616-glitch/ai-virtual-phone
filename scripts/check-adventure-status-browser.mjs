// Isolated real React panel in Chromium; no user data, network API or Next build.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import ts from "typescript";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "out/adventure-status-browser");
await fs.mkdir(out, { recursive: true });
const sources = {
  react: "node_modules/react/cjs/react.production.js",
  "react/jsx-runtime": "node_modules/react/cjs/react-jsx-runtime.production.js",
  "react-dom": "node_modules/react-dom/cjs/react-dom.production.js",
  "react-dom/client": "node_modules/react-dom/cjs/react-dom-client.production.js",
  scheduler: "node_modules/scheduler/cjs/scheduler.production.js",
  "@/lib/adventure-status": "lib/adventure-status.ts",
  panel: "components/map/adventure-status-panel.tsx",
};
const modules = [];
for (const [id, file] of Object.entries(sources)) {
  let code = await fs.readFile(path.join(root, file), "utf8");
  if (file.endsWith(".ts") || file.endsWith(".tsx")) code = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  modules.push(`${JSON.stringify(id)}:function(module,exports,require){${code}\n}`);
}
const test = String.raw`
const R = require('react'), Client = require('react-dom/client'), D = require('@/lib/adventure-status'), Panel = require('panel').default;
let root;
const stamp = () => ({id:crypto.randomUUID(),gameTime:'第3天 · 清晨',createdAt:new Date().toISOString()});
function App(){
  const [state,setState] = R.useState(()=>JSON.parse(localStorage.getItem('status')||'null'));
  const [busy,setBusy] = R.useState(false);
  window.setBusy=setBusy;
  window.install=next=>{localStorage.setItem('status',JSON.stringify(next));window.current=next;setState(next);};
  return R.createElement(Panel,{key:state?.revision??0,state:state||undefined,creation:true,disabled:busy,gameTime:'第3天 · 清晨',onSave:window.install,onGenerate:window.generateFixture,onGenerationChange:window.generationChange});
}
window.mount = ()=>{if(root)root.unmount();root=Client.createRoot(document.getElementById('root'));root.render(R.createElement(App));};
window.generateMode='success';
window.generateFixture=async(existing)=>{
  if(window.generateMode==='error')throw Error('测试连接失败');
  if(window.generateMode==='wait')await new Promise(resolve=>window.finishGeneration=resolve);
  return [...existing,...(existing.length?[{id:'faction',name:'阵营',type:'text',value:'待确认',rule:'正式加入后改变。'}]:D.palaceStatusFields())];
};
window.generationChange=value=>window.generating=value;
window.mount();
(async()=>{
  let checks=0;
  const check=(value,message)=>{if(!value)throw Error(message);checks++;};
  const pause=()=>new Promise(r=>setTimeout(r,50));
  const wait=async fn=>{for(let i=0;i<80;i++){if(fn())return;await pause();}throw Error('UI timed out');};
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  const reveal=el=>{for(let p=el.parentElement;p;p=p.parentElement)if(p instanceof HTMLDetailsElement&&!p.open&&!p.querySelector(':scope > summary')?.contains(el))p.open=true;};
  const click=async el=>{check(!!el,'element exists');reveal(el);el.click();await pause();};
  const input=async(el,value)=>{check(!!el,'input exists');reveal(el);const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await pause();};
  const fields=()=>[...document.querySelectorAll('section fieldset fieldset')];
  const reason=()=>[...document.querySelectorAll('label')].find(l=>l.textContent.startsWith('设置或纠正原因')).querySelector('textarea');
  await wait(()=>document.querySelector('input[type=checkbox]'));
  check(document.body.textContent.includes('未开启'),'default disabled');
  await click(document.querySelector('input[type=checkbox]'));
  await click(button('让 AI 根据世界生成字段'));
  await wait(()=>fields().length===4);
  check([...document.querySelectorAll('.acs-field')].every(el=>!el.open),'field editors initially collapsed');
  check(!window.current,'AI suggestions remain a draft until saved');
  check(document.body.textContent.includes('尚未保存'),'AI draft notice');
  await input(fields()[0].querySelectorAll('input')[1],'常在');
  await click(button('保存状态设置'));
  await wait(()=>window.current?.enabled);
  check(window.current.fields[0].value==='常在','initial rank saved');
  window.mount();await pause();
  check(document.querySelector('dl').textContent.includes('常在'),'saved values survive panel remount');
  const proposal={fieldId:'palace_rank',from:'常在',to:'贵人',kind:'pending',reason:'皇帝许诺日后晋封',evidence:'皇帝许诺日后将你晋封为贵人。'};
  window.install(D.applyAdventureStatusChanges(window.current,[proposal],{...stamp(),expectedRevision:window.current.revision,narrative:proposal.evidence}).state);await pause();
  check(window.current.fields[0].value==='常在','promise preserves rank');
  check(document.body.textContent.includes('待发生事项（不改变当前值）'),'pending UI');
  await click([...document.querySelectorAll('summary')].find(e=>e.textContent.startsWith('待发生事项')));
  await click(button('撤销此待发生事项'));
  await input([...document.querySelectorAll('label')].find(l=>l.textContent==='撤销原因').querySelector('input'),'该许诺已收回');
  await click(button('确认撤销'));
  check(window.current.records.some(r=>r.status==='dismissed'),'pending dismissed with history');
  const formal={...proposal,kind:'occurred',reason:'救驾有功，正式册封',evidence:'皇帝正式下旨，晋封你为贵人，即日起生效。'};
  window.install(D.applyAdventureStatusChanges(window.current,[formal],{...stamp(),expectedRevision:window.current.revision,narrative:formal.evidence}).state);await pause();
  check(document.querySelector('dl').textContent.includes('贵人'),'formal promotion rendered');
  await input(fields()[0].querySelectorAll('input')[1],'常在');
  await input(reason(),'纠正：刚才只是许诺，尚无旨意');
  await input(fields()[2].querySelectorAll('input')[1],'120');
  const revision=window.current.revision;
  await click(button('保存状态设置'));
  check(document.querySelector('[role=alert]').textContent.includes('超出范围'),'invalid number reported');
  check(window.current.revision===revision,'invalid form does not partially save rank');
  await input(fields()[2].querySelectorAll('input')[1],'50');
  await click(button('保存状态设置'));
  check(window.current.fields[0].value==='常在','manual correction saved');
  check(window.current.records.at(-1).source==='manual','manual audit stored');
  window.setBusy(true);await pause();
  check(button('保存状态设置').matches(':disabled'),'generation locks edits');
  window.setBusy(false);await pause();
  await click(document.querySelector('input[type=checkbox]'));
  await input(reason(),'暂时停用');
  await click(button('保存状态设置'));
  check(!window.current.enabled&&window.current.fields[0].value==='常在','disable retains data');
  window.mount();await pause();
  check(!document.querySelector('input[type=checkbox]').checked,'disabled state persists');
  await click(document.querySelector('input[type=checkbox]'));
  await input(reason(),'恢复记录');
  await click(button('保存状态设置'));
  check(window.current.fields[2].value===50,'re-enable preserves auxiliary values');
  window.generateMode='wait';
  await click(button('让 AI 补充字段'));
  check(window.generating,'generating status propagated');
  check(button('保存状态设置').matches(':disabled'),'cannot save while generating');
  await click(button('取消生成'));
  window.finishGeneration();await pause();
  check(fields().length===4&&!window.generating,'cancel ignores late response');
  window.generateMode='error';
  await click(button('让 AI 补充字段'));
  check(document.querySelector('[role=alert]').textContent.includes('测试连接失败'),'generation errors shown');
  check(fields().length===4,'failure preserves draft');
  window.generateMode='success';
  await click(button('让 AI 补充字段'));
  await wait(()=>fields().length===5);
  check(window.current.fields.length===4,'supplement not automatically saved');
  check(fields()[0].querySelectorAll('input')[1].value==='常在','supplement keeps existing rank');
  await click(button('保存状态设置'));
  check(window.current.fields.length===5,'reviewed suggestions saved');
  await click([...document.querySelectorAll('summary')].find(e=>e.textContent.startsWith('变更记录')));
  check(document.body.scrollWidth<=window.innerWidth,'no horizontal overflow');
  check([...document.querySelectorAll('input,textarea')].every(el=>el.closest('label')),'all inputs have labels');
  document.querySelectorAll('details:not(.acs-editor)').forEach(el=>el.open=false);
  check(parseFloat(getComputedStyle(fields()[0].querySelector('input')).fontSize)===11,'compact 11px input text');
  check(document.querySelector('section').getBoundingClientRect().height<650,'collapsed panel fits a phone screen');
  return {passed:true,checks};
})().then(report=>window.statusCheck=report,error=>window.statusCheck={passed:false,error:String(error.stack||error)});
`;
const bundle = `const modules={${modules.join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}\n${test}`;
await fs.writeFile(path.join(out, "bundle.js"), bundle);
await fs.writeFile(path.join(out, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>冒险状态专项检查</title><style>body{margin:0;background:#0a0a0f;font-family:system-ui;padding:10px;box-sizing:border-box}button:disabled{opacity:.5}#root{max-width:500px;margin:auto}</style><div id="root"></div><script src="bundle.js"></script>');
const profile = await fs.mkdtemp(path.join(out, "profile-"));
const child = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
  let port;
  for (let i=0;i<100;i++) { try { port=Number((await fs.readFile(path.join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0]);break; } catch { await new Promise(r=>setTimeout(r,100)); } }
  if(!port)throw Error('Chromium did not start');
  const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  const pending=new Map();let serial=0;
  socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const t=pending.get(m.id);pending.delete(m.id);if(m.error)t.reject(Error(m.error.message));else t.resolve(m.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  await send('Page.enable');
  for(const width of [320,390]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:`file://${out}/index.html?w=${width}`});
    // Each viewport starts with an empty isolated fixture.
    await send('Runtime.evaluate',{expression:'localStorage.clear()'});
    await send('Page.reload');
    let report;
    for(let i=0;i<150;i++){
      const result=await send('Runtime.evaluate',{expression:'JSON.stringify(window.statusCheck||null)',returnByValue:true});
      report=JSON.parse(result.result.value||'null');if(report)break;await new Promise(r=>setTimeout(r,100));
    }
    if(!report?.passed)throw Error(JSON.stringify(report||{error:'Browser test timed out'}));
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await fs.writeFile(path.join(out,`${width}.png`),Buffer.from(shot.data,'base64'));
    console.log(`${width}px: ${report.checks} browser checks passed`);
  }
}finally{
  socket?.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
  await fs.rm(profile,{recursive:true,force:true});
}
