// Runs the real dialog in Chromium with isolated demo presets, never user storage.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import ts from 'typescript';
import {compile} from '@tailwindcss/node';
const root=process.cwd(),out=path.join(root,'out/preset-sync-review');
await fsp.mkdir(out,{recursive:true});
const req=createRequire(import.meta.url),modules=new Map(),candidates=new Set();
function bundle(file){
 if(modules.has(file))return;
 const raw=fs.readFileSync(file,'utf8');
 for(const m of raw.matchAll(/(?:className|dialogClassName)="([^"]+)"/g))for(const token of m[1].split(/\s+/))candidates.add(token);
 const code=/\.tsx?$/.test(file)?ts.transpileModule(raw,{fileName:file,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText:raw;
 const deps={};modules.set(file,{code,deps});
 for(const m of code.matchAll(/require\(["']([^"']+)["']\)/g)){
  const spec=m[1];let resolved;
  if(spec.startsWith('@/')||spec.startsWith('.')){
   const base=spec.startsWith('@/')?path.join(root,spec.slice(2)):path.resolve(path.dirname(file),spec);
   resolved=[base,base+'.ts',base+'.tsx',base+'.js',path.join(base,'index.js')].find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
  }else resolved=req.resolve(spec,{paths:[path.dirname(file)]});
  if(!resolved)throw Error('Cannot resolve '+spec+' from '+file);
  deps[spec]=resolved;bundle(resolved);
 }
}
const fixture=path.join(out,'fixture.tsx');
await fsp.writeFile(fixture,`
import {useState} from 'react';import {createRoot} from 'react-dom/client';
import {PresetSyncDialog} from '@/components/settings/preset-sync-dialog';
import {diffPresetEntries,syncPresetEntries} from '@/lib/preset-entry-sync';
const make=(identifier,name,content)=>({identifier,name,content,role:'system',enabled:true,injection_depth:0});
const source={id:'builtin',name:'默认预设（内置）',prompts:[make('impulse','挂念·起心动念复核','按本次完整任务要求输出 JSON，不要只返回 decisions。'),make('steps','挂念·时段细排','只细排指定时段，输出 steps。')],prompt_order:[{identifier:'impulse',enabled:true},{identifier:'steps',enabled:true}]};
window.target={id:'custom',name:'我的自创预设',prompts:[{...source.prompts[0],content:'旧版：只返回 decisions。<script>不能执行</script>',injection_depth:4,enabled:false},make('mine','自己的条目','保留自己的内容')],prompt_order:[{identifier:'mine',enabled:true},{identifier:'impulse',enabled:false}]};
window.saved=0;window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));
function Demo(){const [open,setOpen]=useState(true);window.reopen=()=>setOpen(true);return open?<PresetSyncDialog sourceName={source.name} targetName={window.target.name} {...diffPresetEntries(window.target,source)} onClose={()=>setOpen(false)} onConfirm={selected=>{const result=syncPresetEntries(window.target,source,selected.map(e=>e.identifier));window.target=result.preset;window.saved++;setOpen(false);return null;}}/>:<div>弹窗已关闭</div>;}
createRoot(document.getElementById('root')).render(<Demo/>);
`);
bundle(fixture);
const definitions=[...modules].map(([id,m])=>`${JSON.stringify(id)}:[function(module,exports,require){${m.code}\n},${JSON.stringify(m.deps)}]`).join(',\n');
await fsp.writeFile(path.join(out,'bundle.js'),`var process={env:{NODE_ENV:'production'}};const modules={${definitions}},cache={};function run(id){if(cache[id])return cache[id].exports;const [fn,deps]=modules[id],module=cache[id]={exports:{}};fn(module,module.exports,s=>run(deps[s]));return module.exports;}run(${JSON.stringify(fixture)});`);
const compiler=await compile('@import "tailwindcss";',{base:root,onDependency(){}});
const css=compiler.build([...candidates])+['styles/tokens.css','styles/base.css','styles/components.css'].map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n');
await fsp.writeFile(path.join(out,'style.css'),css);
await fsp.writeFile(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"><div id="root"></div><script src="bundle.js"></script>');
const profile=await fsp.mkdtemp('/tmp/preset-sync-chromium-');
const child=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-proxy-server','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
let socket;
try{
 let port;for(let i=0;i<100;i++){try{port=Number((await fsp.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await new Promise(r=>setTimeout(r,100));}}
 if(!port)throw Error('Chromium startup failed');
 const tabs=await(await fetch(`http://127.0.0.1:${port}/json`)).json();socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});const pending=new Map();let serial=0;
 socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const task=pending.get(m.id);pending.delete(m.id);if(m.error)task.reject(Error(m.error.message));else task.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await send('Page.enable');
 for(const width of [390,320]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:3,mobile:true});await send('Page.navigate',{url:'file://'+path.join(out,'index.html')+'?width='+width});
  let ready=false;for(let i=0;i<100;i++){ready=await evaluate('!!document.querySelector("input[type=checkbox]")');if(ready)break;await new Promise(r=>setTimeout(r,50));}if(!ready)throw Error('Dialog failed to mount');
  await evaluate('Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))');
  const initial=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await fsp.writeFile(path.join(out,`initial-${width}.png`),Buffer.from(initial.data,'base64'));
  const report=await evaluate(`(async()=>{let checks=0;const check=(v,m)=>{if(!v)throw Error(m);checks++;};const tick=()=>new Promise(r=>setTimeout(r,30));const confirm=()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('同步所选'));
   check(confirm().disabled,'no selection must disable confirmation');check(window.saved===0,'opening must not save');
   document.querySelectorAll('input[type=checkbox]')[0].click();await tick();check(confirm().textContent.includes('1'),'one selection counted');
   document.querySelector('details').open=true;check(document.body.textContent.includes('当前')&&document.body.textContent.includes('内置'),'difference visible');
   check(!document.querySelector('script:not([src])'),'prompt text must not become script');
   await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
   const rect=document.querySelector('[role=dialog]').getBoundingClientRect();check(rect.left>=0&&rect.right<=innerWidth+1,'no horizontal overflow');check(rect.top>=0&&rect.bottom<=innerHeight+1,'dialog fits viewport '+JSON.stringify({top:rect.top,bottom:rect.bottom,height:innerHeight}));
   document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();check(!document.querySelector('[role=dialog]')&&window.saved===0,'Escape cancels without writing');
   window.reopen();await tick();check(confirm().disabled,'reopening starts unchecked');document.querySelectorAll('input[type=checkbox]')[0].click();await tick();confirm().click();await tick();
   check(window.saved===1,'confirmation saves once');check(window.target.prompts.find(p=>p.identifier==='impulse').content.includes('完整任务'),'selected difference applied');check(window.target.prompts.find(p=>p.identifier==='impulse').enabled===false,'existing disabled state preserved');check(!window.target.prompts.some(p=>p.identifier==='steps'),'unselected missing entry untouched');check(window.target.prompts.find(p=>p.identifier==='mine').content==='保留自己的内容','own entry retained');
   window.reopen();await tick();check(document.body.textContent.includes('缺少 1 项'),'remaining missing item visible');document.querySelector('input[type=checkbox]').click();await tick();check(confirm().textContent.includes('1'),'missing selection counted');
   check(window.errors.length===0,'no browser errors');return checks;})()`);
  await evaluate('Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))');
  const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await fsp.writeFile(path.join(out,`preview-${width}.png`),Buffer.from(image.data,'base64'));
  console.log(`${width}px: ${report} browser checks passed`);
 }
}finally{socket?.close();child.kill();await new Promise(r=>{if(child.exitCode!==null)r();else child.once('exit',r);});await fsp.rm(profile,{recursive:true,force:true});}
