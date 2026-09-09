// Isolated real React panel in Chromium; no user data, network API or Next build.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import ts from "typescript";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "out/adventure-world-edit-browser");
await fs.mkdir(out, { recursive: true });
const sources = {
  react: "node_modules/react/cjs/react.production.js",
  "react/jsx-runtime": "node_modules/react/cjs/react-jsx-runtime.production.js",
  "react-dom": "node_modules/react-dom/cjs/react-dom.production.js",
  "react-dom/client": "node_modules/react-dom/cjs/react-dom-client.production.js",
  scheduler: "node_modules/scheduler/cjs/scheduler.production.js",
  "@/lib/adventure-world-edit": "lib/adventure-world-edit.ts",
  panel: "components/map/adventure-world-editor.tsx",
};
const modules = [];
for (const [id, file] of Object.entries(sources)) {
  let code = await fs.readFile(path.join(root, file), "utf8");
  if (file.endsWith(".ts") || file.endsWith(".tsx")) code = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  modules.push(`${JSON.stringify(id)}:function(module,exports,require){${code}\n}`);
}
const test = String.raw`
const R=require('react'),Client=require('react-dom/client'),D=require('@/lib/adventure-world-edit'),Panel=require('panel').default;
const fixture=()=>({id:'w',updatedAt:'old',skeleton:{world:{name:'大燕',lore:'皇帝已有三个皇子，朝堂各有立场。'},npcs:[{id:'npc_0',name:'陆敬堂',personality:'六十二岁的内阁首辅，老成持重。',locationRegion:'r',locationNode:'紫光殿'}],richRegions:[{id:'r',l1_name_cn:'紫光殿',l1_npc:{name:'陆敬堂',personality:'六十二岁的内阁首辅，老成持重。',role:'info'},l2_nodes:[],l3_nodes:[]}]}});
window.mode='normal';window.saved=0;window.nextLore='皇帝尚无子嗣，朝堂各有立场。';
window.busyChanged=v=>window.editBusy=v;
function App(){const [world,setWorld]=R.useState(fixture);window.current=world;window.install=setWorld;
 return R.createElement(Panel,{world,disabled:false,onBusyChange:window.busyChanged,
 onGenerate:async(instruction,signal)=>{window.lastInstruction=instruction;if(window.mode==='wait')await new Promise(r=>window.finish=r);if(signal.aborted)throw Error('cancelled');return D.planWorldSettingEdit(world,{changes:[{target:'world',field:'lore',value:window.nextLore,reason:'按要求修正子嗣设定'},{target:'npc_0',field:'personality',value:'四十岁的内阁首辅，老成持重。',reason:'调整年龄，保留性格与立场'}]});},
 onApply:async plan=>{if(window.mode==='failSave')throw Error('模拟保存失败');const next=D.applyWorldSettingEdit(window.current,plan,'new');window.saved++;setWorld(next);},
 });}
Client.createRoot(document.getElementById('root')).render(R.createElement(App));
(async()=>{let checks=0;const check=(v,m)=>{if(!v)throw Error(m);checks++;};const pause=()=>new Promise(r=>setTimeout(r,60));const wait=async f=>{for(let i=0;i<80;i++){if(f())return;await pause();}throw Error('timed out');};
 const button=t=>[...document.querySelectorAll('button')].find(b=>b.textContent===t);
 const click=async el=>{check(!!el,'element exists');el.click();await pause();};
 const type=async value=>{const el=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await pause();};
 await wait(()=>document.querySelector('summary'));await click(document.querySelector('summary'));
 await type('皇帝改为尚无子嗣，陆敬堂改成四十岁，保留姓名与立场。');
 await click(button('生成修改预览'));await wait(()=>button('确认保存改动'));
 check(window.saved===0&&window.current.skeleton.world.lore.includes('三个皇子'),'preview does not change world');
 check(window.lastInstruction.includes('四十岁'),'instruction forwarded');
 check(document.querySelector('[aria-label="世界设定修改预览"]').textContent.includes('四十岁'),'preview shows replacement');
 await click(button('放弃预览'));check(!button('确认保存改动')&&window.saved===0,'discard keeps original');
 await click(button('生成修改预览'));await wait(()=>button('确认保存改动'));
 window.mode='failSave';await click(button('确认保存改动'));
 check(document.querySelector('[role=alert]').textContent.includes('保存失败'),'save error displayed');
 check(window.current.skeleton.world.lore.includes('三个皇子'),'failure keeps original');
 window.mode='normal';await click(button('确认保存改动'));
 check(window.current.skeleton.world.lore.includes('尚无子嗣'),'confirmed edit persisted');
 check(window.current.skeleton.richRegions[0].l1_npc.personality.includes('四十岁'),'map NPC updated');
 check(document.body.textContent.includes('后续剧情使用新设定'),'save success shown');
 window.nextLore='皇帝只有一位皇子，朝堂各有立场。';
 window.mode='wait';await type('修改子嗣设定');await click(button('生成修改预览'));
 check(window.editBusy,'busy propagated');
 await click(button('取消生成'));window.finish();await pause();check(!button('确认保存改动')&&!window.editBusy,'cancel ignores late result');
 window.mode='wait';await click(button('生成修改预览'));
 await click(document.querySelector('summary'));window.finish();await pause();check(!window.editBusy,'closing editor cancels request');
 await click(document.querySelector('summary'));window.mode='normal';await click(button('生成修改预览'));await wait(()=>button('确认保存改动'));
 window.install({...window.current,skeleton:{...window.current.skeleton,world:{...window.current.skeleton.world,lore:'世界背景已被另一处修改。'}}});await pause();
 await click(button('确认保存改动'));check(document.querySelector('[role=alert]').textContent.includes('已变化'),'stale preview rejected');
 check(window.current.skeleton.world.lore==='世界背景已被另一处修改。','stale preview preserves newer edit');
 await type('皇帝设定为只有一位皇子。');check(!button('确认保存改动'),'changing instruction invalidates preview');
 await click(button('生成修改预览'));await wait(()=>button('确认保存改动'));
 check(document.body.scrollWidth<=innerWidth,'no horizontal overflow');check(parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize)===11,'compact typography');
 return {passed:true,checks};})().then(r=>window.statusCheck=r,e=>window.statusCheck={passed:false,error:String(e.stack||e)});

`;
const bundle = `const modules={${modules.join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}\n${test}`;
await fs.writeFile(path.join(out, "bundle.js"), bundle);
await fs.writeFile(path.join(out, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>世界设定编辑检查</title><style>body{margin:0;background:#0a0a0f;font-family:system-ui;padding:10px;box-sizing:border-box}button:disabled{opacity:.5}#root{max-width:500px;margin:auto}</style><div id="root"></div><script src="bundle.js"></script>');
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
