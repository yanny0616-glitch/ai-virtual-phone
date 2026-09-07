import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
const read = p => fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const js = s => stripTypeScriptTypes(s).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
const source = js(read('lib/follow-up-service.ts'));
const plugin = (await import('../chat-plugins/typing-rhythm.js')).default;
async function scenario({silent = true, durable = true, cps=3, cancel=false, failCommit=false, enabled=true}={}) {
 const h={saved:[],events:[],delays:[],hooks:[],ready:0,commits:0};
 const settings=Object.fromEntries(plugin.manifest.settings.map(s=>[s.key,s.default])); Object.assign(settings,{charsPerSec:cps,jitter:0});
 let transform=p=>p;
 if(enabled) plugin.setup({system:{settings:{get:k=>settings[k]}},hooks:{transform:(point,fn)=>{transform=fn;return()=>{};}}});
 const save = draft => {const m={id:'m'+h.saved.length,...draft};h.saved.push(m);return m;};
 const window = new EventTarget(); for(const kind of ['followup-started','followup-message-saved','followup-fired']) window.addEventListener(kind,e=>h.events.push({kind,detail:e.detail}));
 const c=vm.createContext({console,window,CustomEvent,Date,Promise,Math,
  bgSetTimeout:(fn,ms)=>{h.delays.push(ms);fn();return()=>{};},
  getChatPluginRuntime:()=>({ensureReady:async()=>{h.ready++;}}),
  runChatPluginTransform:async(point,p)=>{h.hooks.push({point,...p});return cancel && p.index===1 ? {...p,cancelled:true}:transform(p);},
  loadChatSessions:()=>[{id:'s',contactId:'c',isGroup:true}],loadCharacters:()=>[],loadChatMessages:()=>[],
  pushChatMessage:save,createResponseBatchId:()=> 'batch',getLatestCharacterStateValues:()=>[],
  createChatMessageBatch:()=>({push:save,commit:async()=>{if(failCommit) throw Error('disk failed');h.commits++;}}),
  parseAIResponse:()=>({parts:[{content:'第一条'},{content:'这是一条十二字的消息啊呀'}],stateValues:[],freshStateValues:[]}),
  getStatusRegionConfig:()=>({}),isCustomStatusRegionActive:()=>false,
  createPendingChatGeneratedImageData:()=>({}),isPendingChatGeneratedImageMessage:()=>false,
 });
 // Avoid the unrelated notification module import; its body is tested elsewhere.
 const code=source.replace('const { sendBrowserNotification } = await import("./browser-notification");','const sendBrowserNotification = () => {};');
 c.dispatchChatMessageNotice=()=>{};
 vm.runInContext(code+'\nglobalThis.api={parseAndSaveResponse,isBackgroundMessagePending,pendingBackgroundReveals};',c);
 if(failCommit) await assert.rejects(c.api.parseAndSaveResponse('reply','s',0,undefined,[],{silent,durable}),/disk failed/);
 else await c.api.parseAndSaveResponse('reply','s',0,undefined,[],{silent,durable});
 assert.equal(c.api.pendingBackgroundReveals.size,0);
 return h;
}
{
 const h=await scenario();
 assert.equal(h.ready,1); assert.equal(h.commits,1);
 assert.deepEqual(h.hooks.map(p=>p.streamed),[false,false]);
 assert.deepEqual(h.delays,[500,4000]);
 assert.deepEqual(h.events.map(e=>e.kind),['followup-started','followup-message-saved','followup-message-saved','followup-fired']);
 console.log('PASS non-streamed cloud receipt uses 3 chars/sec even with silent notification mode');
}
{
 const h=await scenario({durable:false,silent:false});
 assert.deepEqual(h.delays.slice(0,2),[500,4000]);
 console.log('PASS background busy reply uses plugin rhythm rather than fixed 800ms');
}
{
 const h=await scenario({cps:6}); assert.deepEqual(h.delays,[500,2000]);
 const off=await scenario({enabled:false}); assert.deepEqual(off.delays,[]);
 console.log('PASS settings affect next batch and disabling restores immediate cloud merge');
}
{
 const h=await scenario({cancel:true});assert.equal(h.saved.length,1);assert.equal(h.events.filter(e=>e.kind==='followup-message-saved').length,1);
 const failed=await scenario({failCommit:true});assert.equal(failed.events.length,0);
 console.log('PASS plugin cancellation before saving; failed atomic commit cannot reveal partial batch');
}
{
 // Actual foreground helper with the same plugin (non-streamed).
 const src=read('components/chat/chat-room.tsx');const start=src.indexOf('    const paceBubbleReveal = '),end=src.indexOf('\n    // Helper:',start);
 assert.ok(start>=0 && end>start);
 let fn;plugin.setup({system:{settings:{get:k=>({charsPerSec:3,jitter:0}[k]??plugin.manifest.settings.find(s=>s.key===k)?.default)}},hooks:{transform:(_p,f)=>{fn=f;return()=>{};}}});
 const delays=[];
 const c=vm.createContext({session:{id:'s',contactId:'c'},getChatPluginRuntime:()=>({ensureReady:async()=>{}}),runChatPluginTransform:async(_p,p)=>fn(p),abortableDelay:async ms=>delays.push(ms)});
 vm.runInContext(js(src.slice(start,end))+'\nglobalThis.pace=paceBubbleReveal;',c);
 await c.pace({content:'这是一条十二字的消息啊呀',index:1,total:2,responseBatchId:'b'},false);
 assert.deepEqual(delays,[4000]);console.log('PASS real foreground non-streamed hook applies 3 chars/sec');
}
