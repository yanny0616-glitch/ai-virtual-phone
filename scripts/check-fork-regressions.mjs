import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results=[];
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
const common={console,Date,Response,Request,Headers,URL,URLSearchParams,AbortController,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,btoa,atob,setTimeout:()=>1,clearTimeout(){}};
function moduleVM(file,extra={},expose=''){
  let src=stripTypeScriptTypes(fs.readFileSync(path.join(root,file),'utf8'));
  src=src.replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export\s*\{[^}]*\};?\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const |class )/g,'');
  const ctx=vm.createContext({...common,...extra});
  vm.runInContext(src+'\n'+expose,ctx);return ctx;
}
function mirror(fetchImpl){
  const kv=new Map([['chat_mirror_enabled_v1','1']]);
  const ctx=moduleVM('lib/chat-mirror-client.ts',{
    kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v),registerKvMigration(){},isPersonalPushCloudActive:()=>true,personalPushFetch:fetchImpl,
    window:{setTimeout:()=>1,clearTimeout(){},setInterval:()=>1},loadChatSessions:()=>[],loadChatContacts:()=>[],loadChatMessages:()=>[],
  },'globalThis.api={enqueue,flushQueue,flushChatMirrorNow,loadQueue};');
  ctx.api.seed=entries=>kv.set("chat_mirror_queue_v1",JSON.stringify(entries));
  return ctx.api;
}
async function test(name,fn){const detail=await fn();results.push({name,detail});console.log(name,JSON.stringify(detail));}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
await test('Auto/manual share the upload and retain failed batches',async()=>{
  const first=deferred(),started=deferred();let posts=0;
  const a=mirror(async action=>{
    if(action==='health')return json({ok:true,capabilities:['chat-mirror']});
    posts++;if(posts===1){started.resolve();return first.promise;}
    return json({ok:false},503);
  });
  for(let i=0;i<100;i++)a.enqueue({id:'m'+i});
  const auto=a.flushQueue();await started.promise;
  const manual=a.flushChatMirrorNow();const rejected=assert.rejects(manual,/503/);
  first.resolve(json({ok:true}));await Promise.all([auto,rejected]);
  assert.equal(posts,2);assert.equal(a.loadQueue().length,50);
  assert.equal(a.loadQueue()[0].id,'m50');return {requests:posts,retained:50};
});
await test('Acknowledging an old edit never deletes a newer edit',async()=>{
  const first=deferred(),started=deferred();let posts=0;
  const a=mirror(async action=>{
    if(action==='health')return json({ok:true,capabilities:['chat-mirror']});
    if(++posts===1){started.resolve();return first.promise;}
    return json({ok:false},503);
  });
  a.enqueue({id:'m',content:'old'});const run=a.flushQueue();await started.promise;
  a.enqueue({id:'m',content:'new'});first.resolve(json({ok:true}));await run;
  assert.equal(a.loadQueue().length,1);assert.equal(a.loadQueue()[0].content,'new');return {newEditRetained:true};
});
await test('Persisted duplicate events compact to the latest operation',async()=>{
  const a=mirror(async()=>json({ok:true,capabilities:['chat-mirror']}));
  a.seed([{id:'a',content:'old'},{id:'b'},{id:'a',deleted:true}]);
  const q=a.loadQueue();assert.equal(q.length,2);assert.equal(q[1].deleted,true);
  assert.equal(q[1].queueId,a.loadQueue()[1].queueId);
  a.enqueue({id:'a',content:'restored'});assert.equal(a.loadQueue().length,2);assert.equal(a.loadQueue()[1].deleted,undefined);
  return {migrationStable:true,latestOperationWins:true};
});
function gateway(fetchImpl){
  let handler;
  const src=fs.readFileSync(path.join(root,'supabase/functions/ai-phone-push/index.ts'),'utf8');
  vm.runInContext(stripTypeScriptTypes(src),vm.createContext({...common,fetch:fetchImpl,
    Deno:{env:{get:k=>({SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'test'})[k]},serve:f=>handler=f}
  }));return handler;
}
await test('Gateway compacts edits, delete and restore in operation order',async()=>{
  const entry={id:'m',sessionId:'s',characterId:'c',role:'user',createdAt:new Date().toISOString()};
  for(const deletedLast of [true,false]){
    const requests=[];
    const handler=gateway(async(url,init)=>{requests.push({url,...init});return json([]);});
    const entries=deletedLast?[{...entry,content:'old'},{...entry,content:'new'},{id:'m',deleted:true}]:[{id:'m',deleted:true},{...entry,content:'restored'}];
    const response=await handler(new Request('https://example.invalid?action=chat-mirror',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({entries})}));
    assert.equal(response.status,200);assert.equal(requests.length,1);
    assert.equal(requests[0].method,deletedLast?'DELETE':'POST');
    if(!deletedLast){const rows=JSON.parse(requests[0].body);assert.equal(rows.length,1);assert.equal(rows[0].content,'restored');}
  }
  return {deleteAndRestorePreserved:true};
});
const book=moduleVM('lib/character-world-book.ts',{},'globalThis.parseForTest=parseEmbeddedWorldBook;');
const card=moduleVM('lib/character-storage.ts',{registerKvMigration(){}},'globalThis.exportBook=toCharacterBook;');
await test('All worldbook insertion positions round-trip',async()=>{
  for(const position of [0,1,2,3,4,5,6]){
    const first=book.parseForTest({character_book:{entries:[{content:'Fact',extensions:{position}}]}},{},'C');
    const exported=card.exportBook(first);assert.equal(exported.entries[0].extensions.position,position);
    const next=book.parseForTest({character_book:exported},{},'C');assert.equal(next.entries[0].position,first.entries[0].position);
  }
  const legacy=book.parseForTest({character_book:{entries:[{content:'Fact',extensions:{position:'after_char'}}]}},{},'C');
  assert.equal(legacy.entries[0].position,'after_char');return {positions:7,legacyStringSupported:true};
});
await test('Worldbook probability keeps zero and normalizes invalid values',async()=>{
  for(const [input,expected] of [[0,0],[50,50],[100,100],[-2,0],[150,100],['invalid',100],[undefined,100]]){
    const b=book.parseForTest({character_book:{entries:[{content:'Fact',extensions:{useProbability:true,probability:input}}]}},{},'C');
    assert.equal(b.entries[0].probability,expected);assert.equal(b.entries[0].useProbability,true);
  }
  return {cases:7};
});
function gates(){
  const kv=new Map();return moduleVM('lib/chat-reply-gate.ts',{registerKvMigration(){},kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v),kvRemove:k=>kv.delete(k),kvKeysWithPrefix:p=>[...kv.keys()].filter(k=>k.startsWith(p))},
    'globalThis.api={writeDeferredReply,takeDueDeferredReplies,readDeferredReply,retryBusyDeferredReply};').api;
}
await test('Desktop requeues a busy reply and dispatches once when available',async()=>{
  const g=gates();let now=Date.now(),busy=true,sent=0;
  class Clock extends Date {static now(){return now;}}
  const desktop=fs.readFileSync(path.join(root,'components/desktop-shell.tsx'),'utf8');
  const start=desktop.indexOf('    const tick =',desktop.indexOf('// 押后的被动回复到点了'));
  const end=desktop.indexOf('\n    tick();',start);
  const ctx=vm.createContext({...common,Date:Clock,CustomEvent:class {constructor(type,init){this.detail=init.detail;}},CHAT_REQUEST_REPLY_EVENT:'reply',
    takeDueDeferredReplies:g.takeDueDeferredReplies,retryBusyDeferredReply:(id,at)=>g.retryBusyDeferredReply(id,at,now),
    window:{dispatchEvent:event=>{event.detail.handled=true;event.detail.busy=busy;if(!busy)sent++;}}
  });
  vm.runInContext(stripTypeScriptTypes(desktop.slice(start,end))+'\nglobalThis.tick=tick;',ctx);
  g.writeDeferredReply('s',{until:now-1,note:'busy ended'});ctx.tick();
  assert.equal(sent,0);assert.equal(g.readDeferredReply('s').firedAt,undefined);
  busy=false;now+=20001;ctx.tick();ctx.tick();assert.equal(sent,1);
  return {retried:true,successfulDispatches:sent};
});
await test('Late busy result cannot replace newer waiting or urgent reply',async()=>{
  const g=gates(),now=Date.now();g.writeDeferredReply('s',{until:now-1,note:'old'});g.takeDueDeferredReplies(now);
  g.writeDeferredReply('s',{until:now+60000,note:'new'});g.retryBusyDeferredReply('s',now);
  assert.equal(g.readDeferredReply('s').note,'new');
  g.writeDeferredReply('s',null);g.retryBusyDeferredReply('s',now);assert.equal(g.readDeferredReply('s'),null);
  return {newerStatePreserved:true};
});
await test('Background already-running response also requeues the deferred reply',async()=>{
  const g=gates(),now=Date.now();g.writeDeferredReply('s',{until:now-1,note:'waiting'});g.takeDueDeferredReplies(now);
  const desktop=fs.readFileSync(path.join(root,'components/desktop-shell.tsx'),'utf8');
  const start=desktop.indexOf('    const handler = (e: Event)',desktop.indexOf('const openChatSessionFromNotice'));
  const end=desktop.indexOf('\n    window.addEventListener(CHAT_REQUEST_REPLY_EVENT',start);
  const ctx=vm.createContext({...common,loadChatSessions:()=>[{id:'s'}],
    window:{setTimeout:f=>f()},requestBackgroundChatReply:async()=>({ok:false,skipped:'already_running'}),
    retryBusyDeferredReply:(id,at)=>g.retryBusyDeferredReply(id,at,now)
  });
  vm.runInContext(stripTypeScriptTypes(desktop.slice(start,end))+'\nglobalThis.handler=handler;',ctx);
  ctx.handler({detail:{sessionId:'s',source:'reply_gate',deferredAt:now,handled:false}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(g.readDeferredReply('s').firedAt,undefined);
  assert.equal(g.takeDueDeferredReplies(now+20001)[0],'s');return {backgroundBusyRetried:true};
});
console.log(`Passed ${results.length} fork regression checks.`);
