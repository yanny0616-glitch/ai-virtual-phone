// Real same-origin iframes, Web Locks and Chromium IndexedDB, using actual
// consumer and storage modules. Only transport and response parsing are stubs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function moduleCode(file,expose){const src=stripTypeScriptTypes(await fs.readFile(path.join(root,file),'utf8')).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const |class )/g,'');return `(()=>{${src}\nreturn {${expose}};})()`;}
const db=await moduleCode('lib/chat-db.ts','chatDb,dbReadChatSession,dbHasResponseBatch,dbPutMessage,dbPutMessages,dbPutSessions,dbPutMessageBatch,dbReplaceSessions');
const storage=await moduleCode('lib/chat-storage.ts','refreshChatSessionFromDisk,hasPersistedResponseBatch,createChatMessageBatch,loadChatMessages,loadChatSessions,persistChatMessages,seed(s){_sessionsCache=[s];_messagesCache=[];_hydrated=true;}');
const consumer=await moduleCode('lib/push-outbox-client.ts','consumeServerOutbox');
const child=`<!doctype html><script>window.onerror=(m,u,l)=>{parent.h.error=String(m)+":"+l};</script><script src="/dexie.js"></script><script>
Object.assign(window,${db});
const registerKvMigration=()=>{},kvGet=()=>null,resolveUserIdentity=()=>({name:'User'}),loadCharacters=()=>[],emitChatPluginEvent=()=>{},runChatPluginTransformSync=(_p,v)=>v;
const store=${storage};Object.assign(window,store);
const session={id:'s',contactId:'c',isGroup:true,participantIds:[],unreadCount:0,updatedAt:'2026-09-07T08:00:00Z'};store.seed(session);
const isPersonalPushCloudActive=()=>true,getChatPluginRuntime=()=>({ensureStarted:async()=>{}}),stripHallucinatedTimestamps=s=>s;
const runChatPluginTransform=async(_p,v)=>{parent.h.transforms++;return v;};
const settleDeferredReplyDelivery=()=>{},removeTimedWakeSchedule=()=>{},scheduleFollowUp=()=>{};
const personalPushFetch=async(_a,init)=>{if(init?.method==='POST'){parent.h.acks++;if(parent.h.ackFail)return Response.json({ok:false},{status:503});parent.h.entries=[];return Response.json({ok:true});}parent.h.reads++;return Response.json({ok:true,entries:parent.h.entries});};
const parseAndSaveResponse=async(text,s,_n,_f,_m,options)=>{if(parent.h.hold)await parent.h.hold;const batch=store.createChatMessageBatch('s:'+options.responseBatchId,{insertByCreatedAt:true});batch.push({sessionId:s,role:'assistant',content:text,createdAt:options.createdAt,responseBatchId:options.responseBatchId});await batch.commit();return {hasVisible:false};};
const api=${consumer};Object.assign(window,{api,store,session});window.ready=true;
</script>`;
const html=`<!doctype html><script>window.h={entries:[{id:'e',session_id:'s',trigger_key:null,raw_text:'one reply',created_at:'2026-09-07T08:09:00Z'}],ackFail:true,acks:0,reads:0,transforms:0};</script><iframe src="/child" id="a"></iframe><iframe src="/child" id="b"></iframe><script>
(async()=>{
 const until=async f=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,20));}throw Error('timeout '+JSON.stringify(h));};
 await until(()=>a.contentWindow.ready&&b.contentWindow.ready);
 const x=a.contentWindow,y=b.contentWindow;
 const legacy=new x.Dexie('AiPhoneChatDB');legacy.version(1).stores({messages:'id, sessionId, createdAt',sessions:'id, contactId',contacts:'id, characterId'});
 await legacy.sessions.put(x.session);legacy.close();await x.chatDb.open();
 if(!(await x.chatDb.sessions.get('s')))throw Error('version 1 session must survive version 2 migration');
 const check=(v,n)=>{if(!v)throw Error(n);};
 let release;h.hold=new Promise(r=>release=r);
 const first=x.api.consumeServerOutbox({force:true});await until(()=>h.transforms===1);
 await y.api.consumeServerOutbox({force:true});check(h.transforms===1&&h.reads===1,'second page must not fetch or transform while lock held');
 release();h.hold=null;await first;
 check(await x.chatDb.messages.count()===1,'first pass commits once');check(h.entries.length===1,'failed ack keeps server entry');
 check(y.store.loadChatMessages('s').length===0,'second page starts with stale memory');
 h.ackFail=false;await y.api.consumeServerOutbox({force:true});
 check(await y.chatDb.messages.count()===1,'stale page must not duplicate committed messages');check(h.transforms===1,'stale page must not rerun response plugins');check(h.entries.length===0,'second page only retries ack');check(y.store.loadChatMessages('s').length===1,'stale memory refreshed from disk');
 // Failed ACK, edit on another page, then retry must not write stale text.
 h.entries=[{id:'edited',session_id:'s',raw_text:'original',created_at:'2026-09-07T08:15:00Z'}];h.ackFail=true;
 await y.api.consumeServerOutbox({force:true});
 const edited=(await y.chatDb.messages.toArray()).find(m=>m.responseBatchId==='push-outbox:edited');
 await x.chatDb.messages.update(edited.id,{content:'USER EDITED THIS REPLY'});
 h.ackFail=false;await y.api.consumeServerOutbox({force:true});
 check((await y.chatDb.messages.get(edited.id)).content==='USER EDITED THIS REPLY','ACK retry must preserve committed edit');
 check(y.store.loadChatMessages('s').find(m=>m.id===edited.id).content==='USER EDITED THIS REPLY','committed edits refresh in stale UI');
 // Deleting every bubble must still retain delivery identity, even in a new page.
 h.entries=[{id:'deleted',session_id:'s',raw_text:'delete me',created_at:'2026-09-07T08:16:00Z'}];h.ackFail=true;
 await y.api.consumeServerOutbox({force:true});
 const removed=(await y.chatDb.messages.toArray()).find(m=>m.responseBatchId==='push-outbox:deleted');
 await x.chatDb.messages.delete(removed.id);h.ackFail=false;
 const transforms=h.transforms;await x.api.consumeServerOutbox({force:true});
 check(!await x.chatDb.messages.get(removed.id)&&h.transforms===transforms&&h.entries.length===0,'durable receipt prevents resurrection after all bubbles deleted');
 // A page disappearing while it owns the lock must release it.
 h.entries=[{id:'e2',session_id:'s',trigger_key:null,raw_text:'after close',created_at:'2026-09-07T09:00:00Z'}];h.hold=new Promise(()=>{});
 void x.api.consumeServerOutbox({force:true});await until(()=>h.transforms===4);a.remove();h.hold=null;
 for(let i=0;i<100&&h.entries.length;i++){await y.api.consumeServerOutbox({force:true});await new Promise(r=>setTimeout(r,20));}
 check(await y.chatDb.messages.count()===3&&h.entries.length===0,'closing owner releases lock for recovery');
 await y.chatDb.messages.put({id:'legacy',sessionId:'s',role:'assistant',content:'old',responseBatchId:'old-batch',createdAt:'2026-09-07T08:00:00Z'});
 check(await y.dbHasResponseBatch('s','old-batch'),'legacy committed batch gains durable receipt');
 await y.chatDb.messages.delete('legacy');check(await y.dbHasResponseBatch('s','old-batch'),'upgraded receipt survives deletion');
 h.entries=[{id:'e3',session_id:'s',trigger_key:null,raw_text:'keep until supported',created_at:'2026-09-07T10:00:00Z'}];
 Object.defineProperty(y.navigator,'locks',{value:undefined});const reads=h.reads;await y.api.consumeServerOutbox({force:true});
 check(h.reads===reads&&h.entries.length===1&&await y.chatDb.messages.count()===3,'unsupported lock must not fetch, duplicate or acknowledge');
 window.report={passed:true,checks:15};
})().catch(e=>window.report={passed:false,error:String(e),stack:e.stack});
</script>`;
const dexie=await fs.readFile(path.join(root,'node_modules/dexie/dist/dexie.js'));
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/dexie.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/child'?child:req.url==='/dexie.js'?dexie:html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const base=path.join(root,'out/review-outbox-lock');await fs.mkdir(base,{recursive:true});const profile=await fs.mkdtemp(path.join(base,'profile-'));
const proc=spawn('chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-proxy-server','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
let socket;
try{
 let debug;for(let i=0;i<100;i++){try{debug=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await new Promise(r=>setTimeout(r,100));}}if(!debug)throw Error('Chromium did not start');
 const targets=await(await fetch(`http://127.0.0.1:${debug}/json`)).json();socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let id=0;const pending=new Map();socket.onmessage=e=>{const v=JSON.parse(e.data);if(v.id){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}));});
 await send('Page.navigate',{url:`http://127.0.0.1:${port}`});let report;
 for(let i=0;i<200;i++){const r=await send('Runtime.evaluate',{expression:'JSON.stringify(window.report||null)',returnByValue:true});report=JSON.parse(r.result.value||'null');if(report)break;await new Promise(r=>setTimeout(r,100));}
 if(!report?.passed)throw Error(JSON.stringify(report||{error:'timeout'}));console.log('PASS A7 real browser: simultaneous pages, stale cache after failed ack, owner exit, committed edits and whole-batch deletion preserve durable state');
}finally{socket?.close();proc.kill();await new Promise(r=>{if(proc.exitCode!==null)r();else proc.once('exit',r);});server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(profile,{recursive:true,force:true});}
