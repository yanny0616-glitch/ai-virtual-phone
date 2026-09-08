// Focused browser bundle of the real preview/bridge/storage modules; no Next.js build.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack');
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'out/mascot-preview-check');
await fs.mkdir(out, { recursive: true });
const read = file => fs.readFile(path.join(root, file), 'utf8');
assert.doesNotMatch(await read('components/mascot/mascot-float.tsx'), /DIY_WIDGET_PREVIEW_EVENT|diyWidgetPreview/);
assert.match(await read('components/desktop-shell.tsx'), /<MascotFloat\s*\/>\s*\{\/\*[\s\S]*?\*\/\}\s*<MascotPreviewHost\s*\/>/);
const mappings = {
  'components/mascot/mascot-preview-host.tsx': 'host', 'components/mascot/mascot-edit-review.tsx':'review',
  'components/widgets/diy-widget-renderer.tsx':'renderer', 'lib/mascot-events.ts':'events', 'lib/widget-music-bridge.ts':'music',
  'lib/mascot-edit-domain.ts':'domain', 'lib/widget-types.ts':'types', 'lib/kv-db.ts':'kv',
};
const replacements = {
  '@/components/widgets/diy-widget-renderer':'renderer', './mascot-edit-review':'review', '@/lib/mascot-events':'events',
  '@/lib/mascot-edit-store':'store', '@/lib/mascot-edit-domain':'domain', '@/lib/widget-types':'types', './widget-types':'types',
  '@/lib/theme-storage':'assets', '@/lib/widget-music-bridge':'music', './music-control-bridge':'player',
};
for (const [file, name] of Object.entries(mappings)) {
  let source = await read(file);
  if (name === 'host') source = source.replace(/import \{ CustomStatusFrame \}[^;]+;/, 'const CustomStatusFrame = () => <div data-status-preview />;');
  if (name === 'events') source = source.replace(/^import[^;]+;/m, '');
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll('"'+from+'"','"./'+to+'.js"').replaceAll("'"+from+"'","'./"+to+".js'");
  await fs.writeFile(path.join(out, name + '.js'), ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
}
await fs.writeFile(path.join(out, 'assets.js'), 'export const getThemeAssetMap=async()=>({}); export const collectThemeAssetIds=()=>[];');
await fs.writeFile(path.join(out, 'store.js'), `export const MASCOT_EDIT_PREVIEW_EVENT='mascot-edit-preview',MASCOT_EDIT_HISTORY_EVENT='mascot-edit-history';export const readEditState=()=>window.fixture;export const readEditJournal=()=>window.plans;export const editIconCatalog=()=>[{id:'music',name:'音乐'},{id:'settings',name:'设置'},{id:'chat',name:'聊天'},{id:'theme',name:'主题'},{id:'contacts',name:'角色'},{id:'calendar',name:'日历'}];export const changedEditFields=(a,b)=>[...new Set([...Object.keys(a||{}),...Object.keys(b||{})])].filter(k=>JSON.stringify(a?.[k])!==JSON.stringify(b?.[k]));export const commitEdit=async(id,undo)=>{window.commitCalls++;const p=window.plans.find(p=>p.id===id);p.status=undo?'undone':'applied';return {...p};};`);
await fs.writeFile(path.join(out, 'player.js'), 'export const getMusicControlBridge=()=>window.player;');
await fs.writeFile(path.join(out, 'entry.js'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MascotPreviewHost } from './host.js';
import { DIYCodeWidgetFrame } from './renderer.js';
import { requestDiyWidgetPreview, requestStatusBarPreview } from './events.js';
import { readWidgetDiagnostics } from './music.js';
import { hydrateKvDb, kvGet, kvSetAsync, kvCompareAndSetBatch } from './kv.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms||40));
const wait=async(test,message)=>{for(let i=0;i<100;i++){if(test())return;await pause();}throw Error(message);};
const check=(ok,message)=>{if(!ok)throw Error(message);};
const fixture=window.fixture={characters:[],templates:[{id:'diy-x',name:'搭配卡',size:'2x2',mode:'code',htmlString:''},{id:'diy-y',name:'今日一句',size:'1x4',mode:'code',htmlString:''}],desktop:{layout:{page1:[],page2:[]},dock:[],folders:{},widgets:[]},appearance:{iconSkins:{},iconSchemes:[],cssOverrides:{}}};
window.desktopPlan={id:'edit-desk',title:'四页 INS 布局',status:'draft',createdAt:'2026-09-08T06:00:00Z',reads:[],deltas:[{scope:'desktop',before:{layout:{page1:[{id:'music',row:3,col:1},{id:'settings',row:3,col:2},{id:'chat',row:3,col:3},{id:'theme',row:3,col:4},{id:'contacts',row:6,col:3}],page2:[{id:'calendar',row:1,col:1}]},dock:['chat','contacts'],folders:{},widgets:[{id:'w1',type:'clock',size:'2x4',page:1,row:1,col:1},{id:'w2',type:'photo',size:'2x2',page:1,row:4,col:1},{id:'w3',type:'diy-x',size:'2x2',page:1,row:4,col:3},{id:'w4',type:'note',size:'1x1',page:1,row:6,col:1}]},after:{layout:{page1:[{id:'music',row:4,col:1},{id:'settings',row:4,col:2},{id:'chat',row:4,col:3},{id:'theme',row:4,col:4}],page2:[{id:'calendar',row:1,col:1},{id:'contacts',row:3,col:1}],page3:[]},dock:['chat','contacts','music'],folders:{},widgets:[{id:'w5',type:'diy-y',size:'1x4',page:1,row:1,col:1},{id:'w1',type:'clock',size:'2x4',page:1,row:2,col:1},{id:'w2',type:'photo',size:'2x2',page:1,row:5,col:1},{id:'w6',type:'diy-y',size:'2x2',page:1,row:5,col:3}]}}]};
window.commitCalls=0;window.plans=[{id:'edit-test',title:'标签修改',status:'draft',createdAt:'2026-09-07T16:00:00Z',reads:[],deltas:[{scope:'character',id:'c1',before:{name:'测试',tags:[]},after:{name:'测试',tags:['配角']}}]}];
window.player={state:{currentTrack:{id:'track1',title:'歌曲一',artist:'歌手',coverUrl:''},isPlaying:false,currentTime:10,duration:100},getState(){return this.state},pause(){this.state.isPlaying=false},resume(){this.state.isPlaying=true},next(){this.state.currentTrack={...this.state.currentTrack,id:'track2',title:'歌曲二'}},prev(){this.state.currentTrack={...this.state.currentTrack,id:'track1',title:'歌曲一'}},seek(t){this.state.currentTime=t},openPlayer(){this.opened=true}};
const report=state=>parent.postMessage({testState:state},'*');
window.samples=[];window.addEventListener('message',e=>{if(e.data?.testState)window.samples.push(e.data.testState);});
const html='<button id="test" onclick="AiPhoneWidget.music.togglePlay().then(s=>parent.postMessage({testState:s},\\\"*\\\")).catch(e=>parent.postMessage({testState:{error:e.message}},\\\"*\\\"))">播放</button><script>AiPhoneWidget.music.subscribe(s=>parent.postMessage({testState:s},"*"));AiPhoneWidget.music.getState().then(s=>parent.postMessage({testState:s},"*"));window.addEventListener("message",function(e){if(e.source!==parent||!e.data.testAction)return;AiPhoneWidget.music[e.data.testAction](e.data.value).then(s=>parent.postMessage({testState:s},"*")).catch(e=>parent.postMessage({testState:{error:e.message}},"*"));});<\\/script>';
const request={templateId:'diy-test',name:'天气测试',size:'2x4',htmlString:html};
(async()=>{
  check(!requestDiyWidgetPreview(request),'unmounted host falsely acknowledges');
  const root=createRoot(document.getElementById('root'));root.render(React.createElement(MascotPreviewHost));await pause();await pause();
  check(requestDiyWidgetPreview(request),'host did not acknowledge');
  await wait(()=>document.querySelector('iframe'),'preview missing');
  let frame=document.querySelector('iframe');check(frame.getBoundingClientRect().width>0,'preview invisible');check(frame.getAttribute('sandbox')==='allow-scripts','sandbox changed');
  await wait(()=>window.samples.some(s=>s.track?.title==='歌曲一'),'preview music state missing');
  frame.contentWindow.postMessage({testAction:'togglePlay'},'*');await wait(()=>window.samples.some(s=>s.error?.includes('只读预览')),'preview controls were not rejected');check(!window.player.state.isPlaying,'preview changed real music');
  document.querySelector('button').click();await pause();check(!document.querySelector('iframe'),'close failed');
  requestDiyWidgetPreview({...request,htmlString:'<h1>Updated</h1>'});await pause();check(document.querySelector('iframe').srcdoc.includes('Updated'),'reopen stale');
  requestStatusBarPreview({displayName:'状态',renderHtml:'test',previewRaw:'test'});await pause();check(document.querySelector('[data-status-preview]')&&!document.querySelector('iframe'),'status switch failed');
  const detail={plan:window.plans[0],handled:false};window.dispatchEvent(new CustomEvent('mascot-edit-preview',{detail}));await pause();check(detail.handled&&document.querySelector('[role="dialog"]'),'edit dialog missing');
  check(document.body.textContent.includes('配角'),'tag diff missing');
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));await pause();
  window.dispatchEvent(new CustomEvent('mascot-edit-preview',{detail:{plan:window.desktopPlan,handled:false}}));await pause();
  const text=document.body.textContent;check(document.querySelectorAll('.mascot-review-phone').length===2,'before/after phones missing');
  check(text.includes('新增 2 项')&&text.includes('移动 7 项')&&text.includes('移除 2 项')&&text.includes('新建第 3 页')&&text.includes('Dock'),'desktop diff summary wrong: '+text.slice(0,200));
  check(document.querySelector('.mascot-review-widget[data-mark="added"]')&&document.querySelector('.mascot-review-icon[data-mark="moved"]'),'diff marks missing');
  check(text.includes('今日一句')&&text.includes('角色')&&!text.includes('diy-y'),'names not resolved');
  if(location.hash==='#shot'){return;}
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));await pause();
  window.dispatchEvent(new CustomEvent('mascot-edit-preview',{detail:{plan:window.plans[0],handled:false}}));await pause();
  [...document.querySelectorAll('button')].find(b=>b.textContent.includes('应用这份修改')).click();await pause();check(window.commitCalls===1&&document.body.textContent.includes('撤销这次修改'),'apply UI failed');
  [...document.querySelectorAll('button')].find(b=>b.textContent.includes('撤销这次修改')).click();await pause();check(window.commitCalls===2&&document.body.textContent.includes('已撤销'),'undo UI failed');
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',cancelable:true}));await pause();check(!document.querySelector('[role="dialog"]'),'Escape/cancel failed');
  window.dispatchEvent(new CustomEvent('mascot-edit-history'));await pause();check(document.body.textContent.includes('标签修改'),'history missing');
  root.unmount();await pause();check(!requestDiyWidgetPreview(request),'listener leaked');
  // Real desktop iframe with the same client/host bridge, using a controlled player only.
  const real=createRoot(document.getElementById('root'));window.samples=[];
  real.render(React.createElement(DIYCodeWidgetFrame,{widget:{id:'w-test',type:'diy-test',size:'2x4',page:1,row:1,col:1,config:{}},template:{id:'diy-test',mode:'code',htmlString:html}}));
  await wait(()=>window.samples.some(s=>s.track?.id==='track1'),'desktop music not initialized');frame=document.querySelector('iframe');
  const act=(action,value)=>frame.contentWindow.postMessage({testAction:action,value},'*');
  act('togglePlay');await wait(()=>window.player.state.isPlaying,'play failed');
  act('next');await wait(()=>window.samples.some(s=>s.track?.id==='track2'),'next/state sync failed');
  act('prev');await wait(()=>window.player.state.currentTrack.id==='track1','prev failed');
  act('seek',150);await wait(()=>window.player.state.currentTime===100,'seek clamp failed');
  act('pause');await wait(()=>!window.player.state.isPlaying,'pause failed');
  window.dispatchEvent(new MessageEvent('message',{source:window,data:{source:'ai-phone-widget-music',widgetId:'w-test',requestId:'spoof',action:'play'}}));await pause();check(!window.player.state.isPlaying,'foreign frame can control playback');
  window.player.state.currentTrack=null;act('play');await wait(()=>window.samples.some(s=>s.error?.includes('选择一首')),'empty track not handled');
  act('openPlayer');await wait(()=>window.player.opened,'open player failed');
  real.unmount();await pause();check(readWidgetDiagnostics().instances.length===0,'diagnostics leaked');
  // Real Dexie/IndexedDB transaction, isolated Chromium profile. No production data.
  await hydrateKvDb();await kvSetAsync('test-a','before-a');await kvSetAsync('test-b','before-b');
  await kvCompareAndSetBatch([{key:'test-a',expected:'before-a',value:'after-a'},{key:'test-b',expected:'before-b',value:'after-b'}]);
  check(kvGet('test-a')==='after-a'&&kvGet('test-b')==='after-b','atomic commit failed');
  let conflict=false;try{await kvCompareAndSetBatch([{key:'test-a',expected:'stale',value:'bad'},{key:'test-b',expected:'after-b',value:'bad'}]);}catch{conflict=true;}check(conflict&&kvGet('test-b')==='after-b','conflict partially wrote');
  let diskFailure=false;try{await kvCompareAndSetBatch([{key:'test-a',expected:'after-a',value:'must-rollback'},{key:'test-b',expected:'after-b',value:()=>{}}]);}catch{diskFailure=true;}
  check(diskFailure&&kvGet('test-a')==='after-a'&&kvGet('test-b')==='after-b','failed transaction changed cache');
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('AiPhoneKvDB');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  const persistedA=await new Promise((resolve,reject)=>{const req=db.transaction('entries','readonly').objectStore('entries').get('test-a');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});check(persistedA.value==='after-a','failed transaction partially committed');
  await new Promise((resolve,reject)=>{const tx=db.transaction('entries','readwrite');tx.objectStore('entries').put({key:'test-a',value:'other-tab'});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  conflict=false;try{await kvCompareAndSetBatch([{key:'test-a',expected:'after-a',value:'bad'},{key:'test-b',expected:'after-b',value:'bad'}]);}catch{conflict=true;}check(conflict&&kvGet('test-b')==='after-b','persisted stale state not rejected');
  db.close();document.body.dataset.result='PASS';
})().catch(e=>{document.body.dataset.result='FAIL: '+e.stack;});
`);
await new Promise((resolve, reject) => webpack({ mode: 'development', devtool: false, entry: path.join(out, 'entry.js'), output: { path: out, filename: 'bundle.js' }, resolve: { modules: [path.join(root, 'node_modules')] } }, (error, stats) => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve()));
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><style>.w-full{width:100%}.h-full{height:100%}</style><div id="root" style="width:360px;height:250px"></div><script>window.onerror=function(m){document.body.dataset.result="FAIL: "+m;};window.onunhandledrejection=function(e){document.body.dataset.result="FAIL: "+e.reason;};</script><script src="bundle.js"></script>');
const profile=await fs.mkdtemp('/tmp/float-mascot-browser-');
const child=spawn(process.env.CHROMIUM_BIN||'chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--allow-file-access-from-files','--user-data-dir='+profile,'--remote-debugging-port=0','about:blank']);
let socket; const pending=new Map(); let serial=0; let errors='';
try {
  const address=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('DevTools did not start')),10000);
    child.stderr.on('data',d=>{errors+=d;const match=errors.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.on('error',reject);
  });
  const debug=new URL(address);
  const pages=await (await fetch('http://'+debug.host+'/json/list')).json();
  socket=new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const exceptions=[];
  socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const p=pending.get(data.id);pending.delete(data.id);if(data.error)p?.reject(Error(JSON.stringify(data.error)));else p?.resolve(data.result);}else if(data.method==='Runtime.exceptionThrown')exceptions.push(data.params.exceptionDetails);});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  await call('Runtime.enable'); await call('Page.enable');
  await call('Page.navigate',{url:'file://'+path.join(out,'index.html')});
  let status='';
  for(let i=0;i<200;i++){
    await new Promise(r=>setTimeout(r,100));
    const value=await call('Runtime.evaluate',{expression:'document.body?.dataset.result || ""',returnByValue:true});status=value.result?.value||'';
    if(status)break;
  }
  const snapshot=await call('Runtime.evaluate',{expression:'document.documentElement.outerHTML',returnByValue:true});
  await fs.writeFile(path.join(out,'result.html'),snapshot.result.value);
  assert.equal(status,'PASS',status||JSON.stringify(exceptions));
  console.log('PASS browser: collapsed preview, real SDK, read-only preview, close/reopen, edit diff/apply/undo/history UI, music state/play/pause/prev/next/seek/empty state, source isolation, lifecycle cleanup, real atomic IndexedDB commit and stale-cache/database rejection.');
} finally {
  socket?.close(); child.kill('SIGTERM');
  await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
  await fs.rm(profile,{recursive:true,force:true}).catch(()=>{});
}
