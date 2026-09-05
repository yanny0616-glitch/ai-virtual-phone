import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto} from 'node:crypto';
import {isIP} from 'node:net';
import {Agent, MockAgent, fetch as undiciFetch} from 'undici';
import {checkGuaNianBuild} from './build-gua-nian.mjs';
checkGuaNianBuild();
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results=[];
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
const common={console,Date,Response,Request,Headers,URL,URLSearchParams,AbortController,AbortSignal,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,btoa,atob,setTimeout:()=>1,clearTimeout(){}};
function moduleVM(file,extra={},expose=''){
  let src=stripTypeScriptTypes(fs.readFileSync(path.join(root,file),'utf8'));
  src=src.replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export\s*\{[^}]*\};?\s*$/gm,'').replace(/\bexport\s+(?=(?:async\s+)?function|const |class )/g,'');
  const ctx=vm.createContext({...common,...extra});
  vm.runInContext(src+'\n'+expose,ctx);return ctx;
}
function mirror(fetchImpl,extra={}){
  const kv=new Map([['chat_mirror_enabled_v1','1']]);
  const ctx=moduleVM('lib/chat-mirror-client.ts',{
    kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v),registerKvMigration(){},isPersonalPushCloudActive:()=>true,personalPushFetch:fetchImpl,
    CHAT_MESSAGE_PUSHED_EVENT:'push',CHAT_MESSAGE_EDITED_EVENT:'edit',CHAT_MESSAGES_DELETED_EVENT:'delete',CHAT_RESPONSE_BATCH_REPLACED_EVENT:'replace',
    window:{setTimeout:()=>1,clearTimeout(){},setInterval:()=>1},isChatStorageHydrated:()=>true,getChatMessagePreview:m=>m.content,
    loadChatSessions:()=>[],loadChatContacts:()=>[],loadChatMessages:()=>[],...extra,
  },'globalThis.api={enqueue,flushQueue,flushChatMirrorNow,loadQueue,clearChatMirrorCloud,installChatMirror,setChatMirrorEnabled};');
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

await test('Scoped clearing removes old queued operations and preserves other characters',async()=>{
  const uploaded=[];
  const a=mirror(async(action,opts)=>{
    if(action==='health')return json({ok:true,capabilities:['chat-mirror']});
    if(opts.method==='POST')uploaded.push(...JSON.parse(opts.body).entries);
    return json({ok:true});
  });
  a.enqueue({id:'old',characterId:'a'});a.enqueue({id:'other',characterId:'b'});
  await a.clearChatMirrorCloud('a');await a.flushQueue();
  assert.deepEqual(uploaded.map(x=>x.id),['other']);return {oldNotReuploaded:true};
});
await test('Clear waits for in-flight upload and preserves edits made after clearing starts',async()=>{
  const response=deferred(),started=deferred(),order=[],uploaded=[];
  let posts=0;
  const a=mirror(async(action,opts)=>{
    if(action==='health')return json({ok:true,capabilities:['chat-mirror']});
    order.push(opts.method);
    if(opts.method==='POST'){
      uploaded.push(...JSON.parse(opts.body).entries);
      if(++posts===1){started.resolve();return response.promise;}
    }
    return json({ok:true});
  });
  for(let i=0;i<60;i++)a.enqueue({id:'m'+i,characterId:'a',content:'old'});
  const uploading=a.flushQueue();await started.promise;
  const clearing=a.clearChatMirrorCloud();
  a.enqueue({id:'m0',characterId:'a',content:'new'});
  const waiting=a.flushQueue();
  await Promise.resolve();assert.deepEqual(order,['POST']);
  response.resolve(json({ok:true}));await Promise.all([uploading,clearing,waiting]);
  assert.deepEqual(order,['POST','DELETE','POST']);
  assert.equal(uploaded.length,51);assert.equal(uploaded[50].content,'new');
  assert.equal(a.loadQueue().length,0);return {deleteAfterUpload:true,newEditRetained:true};
});
await test('Failed clearing retains unsent queue',async()=>{
  const a=mirror(async()=>json({ok:false},503));a.enqueue({id:'keep'});
  await assert.rejects(a.clearChatMirrorCloud(),/503/);
  assert.equal(a.loadQueue()[0].id,'keep');return {retained:true};
});
await test('Automatic upload recovers after transient health errors',async()=>{
  for(const failure of [()=>json({ok:false},503),()=>new Response('bad JSON'),()=>{throw new Error('offline');}]){
    let health=0,posts=0;
    const a=mirror(async action=>{
      if(action==='health'){if(++health===1)return failure();return json({ok:true,capabilities:['chat-mirror']});}
      posts++;return json({ok:true});
    });
    a.enqueue({id:'retry'});await a.flushQueue();assert.equal(a.loadQueue().length,1);
    await a.flushQueue();assert.equal(health,2);assert.equal(posts,1);assert.equal(a.loadQueue().length,0);
  }
  return {cases:3};
});
await test('Cached unsupported capability expires automatically',async()=>{
  let now=1000,health=0,posts=0;
  class Clock extends Date {static now(){return now;}}
  const a=mirror(async action=>{
    if(action==='health')return json({ok:true,capabilities:++health===1?[]:['chat-mirror']});
    posts++;return json({ok:true});
  },{Date:Clock});
  a.enqueue({id:'retry'});await a.flushQueue();await a.flushQueue();assert.equal(health,1);
  now+=300001;await a.flushQueue();assert.equal(health,2);assert.equal(posts,1);
  return {automaticRecovery:true};
});
await test('Gemini streaming preserves official totals including thought tokens',async()=>{
  const a=moduleVM('lib/llm-provider-adapter.ts',{},'globalThis.api={parseProviderStreamDelta,mergeLlmUsage};').api;
  let usage;
  for(const count of [1,20]){
    const delta=a.parseProviderStreamDelta('gemini',{usageMetadata:{promptTokenCount:100,candidatesTokenCount:count,thoughtsTokenCount:50,totalTokenCount:150+count}});
    usage=a.mergeLlmUsage(usage,delta.usage,'gemini');
  }
  assert.equal(usage.total_tokens,170);assert.equal(usage.completion_tokens,20);
  return {officialTotal:usage.total_tokens};
});
await test('Anthropic streaming still combines input cache and output usage',async()=>{
  const a=moduleVM('lib/llm-provider-adapter.ts',{},'globalThis.api={parseProviderStreamDelta,mergeLlmUsage};').api;
  const first=a.parseProviderStreamDelta('anthropic',{type:'message_start',message:{usage:{input_tokens:100,cache_read_input_tokens:50,cache_creation_input_tokens:20,output_tokens:1}}});
  const last=a.parseProviderStreamDelta('anthropic',{type:'message_delta',usage:{output_tokens:30}});
  const usage=a.mergeLlmUsage(first.usage,last.usage,'anthropic');
  assert.equal(usage.prompt_tokens,170);assert.equal(usage.completion_tokens,30);assert.equal(usage.total_tokens,200);
  return {total:usage.total_tokens};
});

await test('Clearing during health probing prevents manual history backfill',async()=>{
  const health=deferred(),started=deferred();let backfills=0;
  const a=mirror(async action=>{
    if(action==='health'){started.resolve();return health.promise;}
    return json({ok:true});
  },{loadChatSessions:()=>{backfills++;return [];}});
  const upload=a.flushChatMirrorNow();await started.promise;
  const clearing=a.clearChatMirrorCloud();
  health.resolve(json({ok:true,capabilities:['chat-mirror']}));
  await Promise.all([upload,clearing]);assert.equal(backfills,0);
  return {staleBackfillPrevented:true};
});
function outbound(lookup){
  return moduleVM('lib/server/safe-outbound-fetch.ts',{
    Agent,undiciFetch,lookup,isIP,
    fetch:()=>{throw new Error('Must not mix the native fetch with npm Undici dispatchers');},
  },'globalThis.api={safeOutboundFetch,secureLookup,directDispatcher};').api;
}
await test('Outbound fetch uses the matching dispatcher and still blocks private redirects',async()=>{
  const a=outbound(async()=>[{address:'93.184.216.34',family:4}]);
  const dispatcher=new MockAgent();dispatcher.disableNetConnect();
  const pool=dispatcher.get('https://public.invalid');
  pool.intercept({path:'/ok',method:'GET'}).reply(200,'works');
  pool.intercept({path:'/redirect',method:'GET'}).reply(302,'',{headers:{location:'http://127.0.0.1/private'}});
  try {
    const response=await a.safeOutboundFetch('https://public.invalid/ok',{},dispatcher);
    assert.equal(await response.text(),'works');
    await assert.rejects(a.safeOutboundFetch('https://public.invalid/redirect',{},dispatcher),/不允许/);
    dispatcher.assertNoPendingInterceptors();
  } finally {await dispatcher.close();await a.directDispatcher.close();}
  return {compatibleDispatcher:true,privateRedirectBlocked:true};
});
await test('Secure DNS supports all addresses and family filtering without permitting private IPs',async()=>{
  let addresses=[{address:'93.184.216.34',family:4},{address:'2606:4700:4700::1111',family:6}];
  const a=outbound(async()=>addresses);
  const lookup=options=>new Promise((resolve,reject)=>a.secureLookup('public.invalid',options,(error,address,family)=>error?reject(error):resolve({address,family})));
  try {
    assert.deepEqual((await lookup({all:true})).address,addresses);
    assert.deepEqual(await lookup({family:6}),{address:addresses[1].address,family:6});
    assert.deepEqual((await lookup({all:true,family:4})).address,[addresses[0]]);
    addresses=[addresses[0]];await assert.rejects(lookup({family:6}),/地址族/);
    addresses.push({address:'127.0.0.1',family:4});await assert.rejects(lookup({all:true}),/内网/);
  } finally {await a.directDispatcher.close();}
  return {allAddresses:true,familyRespected:true,privateAddressBlocked:true};
});
function feedback(){
  const source=fs.readFileSync(path.join(root,'supabase/functions/push-recheck/index.ts'),'utf8');
  const fn=source.slice(source.indexOf('function feedbackWindowEnd('),source.indexOf('// ── 惦记账本'));
  const ctx=vm.createContext(common);vm.runInContext(stripTypeScriptTypes(fn)+'\nglobalThis.roll=feedbackRoll;',ctx);return ctx.roll;
}
await test('Deferred feedback waits a full reply window and retries failed mirror reads',async()=>{
  const roll=feedback(),hour=3600000,scheduled=Date.parse('2026-09-04T09:00:00Z'),sent=scheduled+3*hour-5*60000;
  const items=[{act:true,wakeId:'w1',fireAt:scheduled,kind:'care'}],context={fb:{},fbSeen:[]};
  let fail=false,mirrorReads=0;
  const rest=async resource=>{
    if(resource.startsWith('push_jobs'))return json([{trigger_key:'timedwake:w1',status:'done',result_note:'generated, pushed 1',updated_at:new Date(sent).toISOString()}]);
    mirrorReads++;return fail?json({error:'unavailable'},503):json([{message_at:new Date(sent+15*60000).toISOString()}]);
  };
  Object.assign(context,await roll(rest,'owner','c',items,context,scheduled+3*hour));
  assert.equal(mirrorReads,0);assert.equal(context.fbSeen.length,0);
  fail=true;Object.assign(context,await roll(rest,'owner','c',items,context,sent+3*hour));
  assert.equal(context.fbSeen.length,0);
  fail=false;Object.assign(context,await roll(rest,'owner','c',items,context,sent+3*hour+60000));
  assert.deepEqual(Array.from(context.fb.care),[1,1]);
  assert.equal(await roll(rest,'owner','c',items,context,sent+4*hour),null);
  return {fullWindowObserved:true,failedReadRetried:true,countedOnce:true};
});
function jobGateway(jobs,{fail=false}={}){
  return gateway(async(url)=>{
    const u=new URL(url);
    if(!u.pathname.endsWith('/push_jobs'))return json([{payload_key:null}]);
    if(fail)return json({error:'unavailable'},503);
    let rows=jobs;
    const filter=u.searchParams.get('trigger_key');
    if(filter){const keys=JSON.parse('['+filter.slice(4,-1)+']');rows=rows.filter(row=>keys.includes(row.trigger_key));}
    return json([...rows].sort((a,b)=>b.execute_at.localeCompare(a.execute_at)).slice(0,Number(u.searchParams.get('limit'))));
  });
}
const jobRequest=params=>new Request('https://example.invalid?'+new URLSearchParams({action:'jobs',...params}),{headers:{'x-ai-phone-service-key':'test'}});
await test('Exact job lookup validates keys and never reports database errors as empty success',async()=>{
  const handler=jobGateway([]);
  for(const keys of [[],Array(21).fill('timedwake:a'),['bad"filter'],[null]]){
    assert.equal((await handler(jobRequest({triggerKeys:JSON.stringify(keys)}))).status,400);
  }
  assert.equal((await handler(jobRequest({triggerKeys:'not-json'}))).status,400);
  assert.equal((await jobGateway([],{fail:true})(jobRequest({triggerKeys:'["timedwake:a"]'}))).status,500);
  const response=await handler(jobRequest({triggerKeys:'["timedwake:a"]'}));
  assert.deepEqual((await response.json()).queriedTriggerKeys,['timedwake:a']);return {validated:true,errorsRetriable:true};
});
function settlement(cloudFetch){
  const now=Date.parse('2026-09-04T16:00:00Z');class Clock extends Date {static now(){return now;}}
  const source=fs.readFileSync(path.join(root,'custom-apps/gua-nian/index.html'),'utf8');
  const fn=source.slice(source.indexOf('  async function settleFired(cx)'),source.indexOf('  // 了结或删掉一条惦记时'));
  let current;
  const ctx=vm.createContext({...common,Date:Clock,S:{settings:{threadsOn:true}},cloudCfg:()=>true,cloudFetch,
    saveThreads:async(cx,rows)=>{cx.threads=rows;},upsert:async(coll,match,patch)=>({...current.plan,...patch}),todayStr:()=> '2026-09-04',log:async()=>{}});
  vm.runInContext(fn+'\nglobalThis.settle=settleFired;',ctx);
  return async(cx)=>{current=cx;await ctx.settle(cx);};
}
await test('Settlement finds older successful jobs behind more than 20 future appointments',async()=>{
  const scheduled=Date.parse('2026-09-04T09:00:00Z'),cx={character:{id:'c'},threads:[],plan:{items:[]}};
  const jobs=Array.from({length:25},(_,i)=>({trigger_key:'timedwake:future'+i,execute_at:'2026-09-05T09:00:00Z',status:'pending'}));
  for(let i=0;i<25;i++){
    cx.threads.push({id:'t'+i,kind:'topic',text:'sent topic '+i,done:false});
    cx.plan.items.push({act:true,from:'t'+i,wakeId:'sent'+i,fireAt:scheduled});
    jobs.push({trigger_key:'timedwake:sent'+i,execute_at:new Date(scheduled).toISOString(),status:'done',result_note:'generated, pushed 1'});
  }
  const handler=jobGateway(jobs),batches=[];
  const run=settlement(async(action,init,params)=>{
    batches.push(JSON.parse(params.triggerKeys).length);
    return (await handler(jobRequest(params))).json();
  });
  await run(cx);assert.deepEqual(batches,[20,5]);assert.ok(cx.threads.every(t=>t.done));assert.ok(cx.plan.items.every(w=>w.thDone));
  return {settled:25,batches};
});
await test('Missing jobs and old gateways leave settlement available for retry',async()=>{
  for(const legacy of [false,true]){
    const cx={character:{id:'c'},threads:[{id:'t',kind:'topic',text:'waiting',done:false}],plan:{items:[{act:true,from:'t',wakeId:'w',fireAt:Date.parse('2026-09-04T09:00:00Z')}]}};
    await settlement(async()=>({jobs:[],...(legacy?{}:{queriedTriggerKeys:['timedwake:w']})}))(cx);
    assert.equal(cx.plan.items[0].thDone,undefined);assert.equal(cx.threads[0].done,false);
  }
  return {missingRetried:true,oldGatewayDetected:true};
});
await test('Feedback treats silence as neutral and caps positive reinforcement',async()=>{
  const source=fs.readFileSync(path.join(root,'supabase/functions/push-recheck/index.ts'),'utf8');
  const ctx=vm.createContext(common);
  vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('// 沉默无法证明不喜欢'),source.indexOf('function impulseValue(')))+'\nglobalThis.policy={fbMod,fbLine};',ctx);
  const {fbMod,fbLine}=ctx.policy;
  for(const sent of [0,2,3,50,1000])assert.equal(fbMod({quiet:[sent,0]},'quiet'),1);
  assert.equal(fbMod({quiet:[3,3]},'quiet'),1.04);
  assert.equal(fbMod({quiet:[100,3]},'quiet'),fbMod({quiet:[3,3]},'quiet'));
  assert.equal(fbMod({quiet:[100,100]},'quiet'),1.2);
  assert.equal(fbMod({quiet:[100,2]},'quiet'),1);
  assert.match(fbLine({quiet:[100,0]},'quiet'),/未回复不代表不喜欢/);
  assert.ok(!fbLine({quiet:[100,0]},'quiet').includes('不太接这种话'));
  assert.match(fbLine({quiet:[100,3]},'quiet'),/轻微的正向参考/);
  const diag=fs.readFileSync(path.join(root,'custom-apps/gua-nian/src/ui/diagnostics.js'),'utf8');
  const mod=diag.match(/const mod = ([^\n]+);/)[1];
  const local=vm.runInNewContext('('+mod+')');
  for(const pair of [[0,0],[2,2],[3,3],[100,3],[100,100],[2,5]])assert.equal(local(...pair),fbMod({quiet:pair},'quiet'));
  const roll=feedback(),sent=Date.parse('2026-09-04T09:00:00Z');
  const context={fb:{quiet:[3,3]},fbSeen:[]};
  const result=await roll(async resource=>resource.startsWith('push_jobs')
    ? json([{trigger_key:'timedwake:w',status:'done',result_note:'generated, pushed 1',updated_at:new Date(sent).toISOString()}]) : json([]),
    'owner','c',[{act:true,wakeId:'w',fireAt:sent,kind:'quiet'}],context,sent+3*3600000);
  assert.equal(result.fb.quiet[0],4);assert.equal(result.fb.quiet[1],3);
  assert.equal(fbMod(result.fb,'quiet'),fbMod(context.fb,'quiet'));
  return {silenceNeutral:true,historicalPenaltiesRemoved:true,localCloudConsistent:true,maxBoost:1.2};
});
await test('Optional user sleep pauses feedback time across midnight and DST',async()=>{
  const source=fs.readFileSync(path.join(root,'supabase/functions/push-recheck/index.ts'),'utf8');
  const ctx=vm.createContext(common);
  vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('function feedbackWindowEnd('),source.indexOf('// 记回音账：')))+'\nglobalThis.end=feedbackWindowEnd;',ctx);
  const end=ctx.end,at=Date.parse,hour=3600000;
  const sleep={userSleepOn:1,userSleepStart:'23:30',userSleepEnd:'08:00',userSleepTimeZone:'Asia/Shanghai',userSleepTz:480};
  const sent=at('2026-09-04T14:30:00Z'),deadline=at('2026-09-05T02:00:00Z');
  assert.equal(end(sent,sleep,deadline-1),null);
  assert.equal(end(sent,sleep,deadline),deadline);
  assert.equal(end(sent,sleep,deadline+hour),deadline);
  assert.equal(end(sent,{...sleep,userSleepOn:0},sent+3*hour),sent+3*hour);
  assert.equal(end(sent,{},sent+3*hour),sent+3*hour);
  for(const patch of [{userSleepStart:'99:99'},{userSleepEnd:'23:30'},{userSleepStart:''}])
    assert.equal(end(sent,{...sleep,...patch},sent+3*hour),sent+3*hour);
  assert.equal(end(at('2026-09-04T18:00:00Z'),sleep,at('2026-09-05T03:00:00Z')),at('2026-09-05T03:00:00Z'));
  assert.equal(end(sent,{...sleep,userSleepTimeZone:'invalid/zone'},deadline),deadline);
  const daytime={...sleep,userSleepStart:'10:00',userSleepEnd:'12:00',userSleepTimeZone:'UTC',userSleepTz:0};
  assert.equal(end(at('2026-09-04T09:00:00Z'),daytime,at('2026-09-04T14:00:00Z')),at('2026-09-04T14:00:00Z'));
  const ny={...sleep,userSleepStart:'01:00',userSleepEnd:'04:00',userSleepTimeZone:'America/New_York'};
  for(const [from,to] of [['2026-03-08T05:30:00Z','2026-03-08T10:30:00Z'],['2026-11-01T04:30:00Z','2026-11-01T11:30:00Z']]){
    assert.equal(end(at(from),ny,at(to)-1),null);assert.equal(end(at(from),ny,at(to)),at(to));
  }
  const fractional=at('2026-09-04T14:30:30.125Z');
  assert.equal(end(fractional,sleep,deadline+30125),deadline+30125);
  return {defaultOff:true,overnight:true,sentDuringSleep:true,DST:true,millisecondsPreserved:true};
});
await test('Feedback counts next-morning replies only after the paused window completes',async()=>{
  const roll=feedback(),sent=Date.parse('2026-09-04T14:30:00Z'),deadline=Date.parse('2026-09-05T02:00:00Z');
  const context={userSleepOn:1,userSleepStart:'23:30',userSleepEnd:'08:00',userSleepTimeZone:'Asia/Shanghai',fb:{},fbSeen:[]};
  const items=[{act:true,wakeId:'sleep',fireAt:sent,kind:'quiet'}];let mirrorReads=0,fail=false;
  const rest=async resource=>{
    if(resource.startsWith('push_jobs'))return json([{trigger_key:'timedwake:sleep',status:'done',result_note:'generated, pushed 1',updated_at:new Date(sent).toISOString()}]);
    mirrorReads++;assert.ok(resource.includes(encodeURIComponent(new Date(deadline).toISOString())));
    return fail?json({},503):json([{message_at:'2026-09-05T01:00:00Z'}]);
  };
  Object.assign(context,await roll(rest,'owner','c',items,context,sent+3*3600000));
  assert.equal(mirrorReads,0);assert.equal(context.fbSeen.length,0);
  fail=true;Object.assign(context,await roll(rest,'owner','c',items,context,deadline));assert.equal(context.fbSeen.length,0);
  fail=false;Object.assign(context,await roll(rest,'owner','c',items,context,deadline+60000));
  assert.deepEqual(Array.from(context.fb.quiet),[1,1]);assert.equal(context.fbSeen.length,1);
  assert.equal(await roll(rest,'owner','c',items,context,deadline+120000),null);
  return {morningReplyCounted:true,failedReadRetried:true,countedOnce:true};
});
await test('Gateway preserves optional user sleep settings alongside unrelated plan context',async()=>{
  let saved;
  const handler=gateway(async(url,init)=>{
    if(url.includes('/push_recheck_plans?on_conflict=')){saved=JSON.parse(init.body)[0];return json([]);}
    return json([]);
  });
  for(const enabled of [0,1]){
    const response=await handler(new Request('https://example.invalid?action=recheck-plan',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({
      characterId:'c',planDate:'2026-09-04',items:[],context:{quota:4,quietStart:'22:00',quietEnd:'09:00',
        userSleepOn:enabled,userSleepStart:'01:30',userSleepEnd:'09:45',userSleepTimeZone:'Asia/Shanghai',userSleepTz:480}
    })}));
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).acceptedUserSleep,{enabled,start:'01:30',end:'09:45',timeZone:'Asia/Shanghai',tz:480});
    assert.equal(saved.context.userSleepOn,enabled);assert.equal(saved.context.userSleepStart,'01:30');assert.equal(saved.context.userSleepEnd,'09:45');
    assert.equal(saved.context.userSleepTimeZone,'Asia/Shanghai');assert.equal(saved.context.userSleepTz,480);
    assert.equal(saved.context.quota,4);assert.equal(saved.context.quietStart,'22:00');
  }
  return {enabledAndDisabledRoundTrip:true,roleScheduleUnchanged:true};
});
await test('Today resumes last-night feedback without rerunning old impulses or recounting replies',async()=>{
  const source=fs.readFileSync(path.join(root,'supabase/functions/push-recheck/index.ts'),'utf8');
  const ctx=vm.createContext(common);
  vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('function feedbackWindowEnd('),source.indexOf('// ── 惦记账本')))+'\nglobalThis.resume=feedbackWithPreviousDay;',ctx);
  const sent=Date.parse('2026-09-04T14:30:00Z'),deadline=Date.parse('2026-09-05T02:00:00Z');
  const context={userSleepOn:1,userSleepStart:'23:30',userSleepEnd:'08:00',userSleepTimeZone:'Asia/Shanghai',fb:{},fbSeen:[]};
  let baselineFails=false;
  const rest=async resource=>{
    if(resource.startsWith('push_recheck_plans')){
      assert.ok(resource.includes('plan_date=eq.2026-09-04'));
      return baselineFails?json({},503):json([{items:[{act:true,wakeId:'night',fireAt:sent,kind:'quiet'},{act:true,wakeId:'old',fireAt:sent-86400000,kind:'quiet'}],context:{fb:{quiet:[4,2]},fbSeen:['old']}}]);
    }
    if(resource.startsWith('push_jobs')){assert.ok(!resource.includes('timedwake%3Aold'));return json([{trigger_key:'timedwake:night',status:'done',result_note:'generated',updated_at:new Date(sent).toISOString()}]);}
    return json([{message_at:new Date(deadline-60000).toISOString()}]);
  };
  Object.assign(context,await ctx.resume(rest,'owner','c','2026-09-05',[],context,deadline-1));
  assert.deepEqual(Array.from(context.fb.quiet),[4,2]);assert.ok(!context.fbSeen.includes('night'));
  baselineFails=true;assert.equal(await ctx.resume(rest,'owner','c','2026-09-05',[],context,deadline),null);
  baselineFails=false;Object.assign(context,await ctx.resume(rest,'owner','c','2026-09-05',[],context,deadline));
  assert.deepEqual(Array.from(context.fb.quiet),[5,3]);assert.ok(context.fbSeen.includes('night'));
  assert.equal(await ctx.resume(rest,'owner','c','2026-09-05',[],context,deadline+60000),null);
  assert.ok(source.includes('const fbRoll = await feedbackWithPreviousDay('));
  return {priorDayResumed:true,baselinePreserved:true,noDoubleCounting:true};
});
await test('Gateway confirms worker support before atomically toggling current and future plans',async()=>{
  const rows=[
    {character_id:'c',plan_date:'2026-09-04',context:{owner:'mine',fbSeen:['old'],genKit:{date:'tomorrow'}},items:[{wakeId:'keep'}]},
    {character_id:'c',plan_date:'2026-09-05',context:{owner:'mine',genKit:{date:'tomorrow'}}},
    {character_id:'c',plan_date:'2026-09-03',context:{owner:'other'}},
    {character_id:'other',plan_date:'2026-09-04',context:{owner:'other'}},
  ];
  let oldWorker=true, missingRPC=false, rpcCalls=0;
  const handler=gateway(async(url,init)=>{
    if(url.includes('push_server_config'))return json([{cron_secret:'cron-test'}]);
    if(url.includes('/functions/v1/push-recheck'))return oldWorker ? new Response('bad request',{status:400}) : json({ok:true,capabilities:['recheck-control-v1','user-sleep-feedback-v1']});
    if(url.includes('/rpc/push_recheck_set_enabled')){
      rpcCalls++; if(missingRPC)return json({},404);
      const body=JSON.parse(init.body);
      const targets=rows.filter(row=>row.character_id===body.p_character_id&&row.plan_date>=body.p_from_date);
      if(targets.some(row=>row.context.owner!==body.p_owner))return json(-1);
      for(const row of targets)row.context.recheckEnabled=body.p_enabled?1:0;
      return json(targets.length);
    }
    const query=new URL(url).searchParams;
    assert.equal(query.get('character_id'),'eq.c');assert.equal(query.get('plan_date'),'gte.2026-09-04');
    return json(rows.filter(row=>row.character_id==='c'&&row.plan_date>='2026-09-04'));
  });
  const send=(enabled)=>handler(new Request('https://example.invalid?action=recheck-control',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({characterId:'c',planDate:'2026-09-04',enabled,owner:'mine'})}));
  assert.equal((await send(false)).status,409);assert.equal(rpcCalls,0);
  oldWorker=false;missingRPC=true;
  const missing=await send(false);assert.equal(missing.status,409);assert.match((await missing.json()).error,/schema/);
  missingRPC=false;
  for(const enabled of [false,true]){
    const response=await send(enabled);assert.equal(response.status,200);assert.equal((await response.json()).recheckEnabled,enabled);
    assert.equal(rows[0].context.recheckEnabled,enabled?1:0);assert.equal(rows[1].context.recheckEnabled,enabled?1:0);
    assert.deepEqual(rows[0].items,[{wakeId:'keep'}]);assert.deepEqual(rows[0].context.fbSeen,['old']);
    assert.deepEqual(rows[1].context.genKit,{date:'tomorrow'});assert.equal(rows[2].context.recheckEnabled,undefined);assert.equal(rows[3].context.recheckEnabled,undefined);
  }
  const before=rpcCalls;rows[1].context.owner='other';assert.equal((await send(false)).status,409);assert.equal(rpcCalls,before);
  return {oldWorkerRejected:true,schemaUpgradeRequired:true,currentAndFutureConfirmed:true,unrelatedDataPreserved:true};
});
await test('Gateway keeps cloud feedback keys when a stale 60-entry list is uploaded',async()=>{
  let saved;
  const current=Array.from({length:60},(_,i)=>'w'+(i+1));
  const handler=gateway(async(url,init)=>{
    if(url.includes('on_conflict=')){saved=JSON.parse(init.body)[0];return json([]);}
    return json([{context:{fbSeen:current,fb:{quiet:[61,5]}}}]);
  });
  const response=await handler(new Request('https://example.invalid?action=recheck-plan',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({
    characterId:'c',planDate:'2026-09-04',items:[],context:{fbSeen:Array.from({length:60},(_,i)=>'w'+i),fb:{quiet:[60,4]}}
  })}));
  assert.equal(response.status,200);assert.deepEqual(saved.context.fbSeen,current);assert.deepEqual(saved.context.fb.quiet,[61,5]);
  return {cloudKeyPreservedAtCapacity:true};
});
await test('Worker capability probe is authenticated and disabled plans skip all feedback and model work',async()=>{
  let handler;const calls=[];
  let context={recheckEnabled:0,day:{tz:0},fbSeen:['keep']};
  moduleVM('supabase/functions/push-recheck/index.ts',{
    Deno:{env:{get:k=>({SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'test'})[k]},serve:f=>handler=f},
    fetch:async(url,init)=>{
      calls.push({url,init});
      if(url.includes('push_server_config'))return json([{cron_secret:'cron-test',payload_key:'test'}]);
      assert.ok(url.includes('push_recheck_plans'));
      if(init?.method==='PATCH'){
        assert.deepEqual(Object.keys(JSON.parse(init.body)),['last_recheck_at']);return json([]);
      }
      return json([{context,items:[{wakeId:'keep',act:true,fireAt:Date.now()+3600000}]}]);
    },
  });
  const send=body=>handler(new Request('https://example.invalid',{method:'POST',body:JSON.stringify(body)}));
  assert.equal((await send({action:'capabilities',token:'wrong'})).status,403);
  const cap=await send({action:'capabilities',token:'cron-test'});
  assert.deepEqual((await cap.json()).capabilities,['user-sleep-feedback-v1','recheck-control-v1','generation-stop-v1','judge-task-v1']);
  calls.length=0;
  const disabled=await send({token:'cron-test',userId:'owner',characterId:'c',planDate:'2026-09-04'});
  assert.equal(await disabled.text(),'recheck disabled');assert.equal(calls.length,3);
  context={recheckEnabled:0,genKit:{tz:0,autoGenAt:'07:30'}};
  const future=await send({token:'cron-test',userId:'owner',characterId:'c',planDate:'2099-01-01'});
  assert.equal(await future.text(),'gen: not that day yet'); // 关闭复核不取消独立的自动生成。
  return {probeAuthenticated:true,noFeedbackOrModelWhenDisabled:true,generationRemainsIndependent:true};
});

await test('Mirror timeouts cover health, upload response bodies and clearing, retaining retriable records',async()=>{
  for(const phase of ['health','post','body','delete']){
    const started=deferred();let timeout,aborted=false,stalled=true,requests=0;
    const a=mirror(async(action,init)=>{
      requests++;
      const target=phase==='health'?action==='health':phase==='delete'?init.method==='DELETE':init.method==='POST';
      if(stalled&&target){
        init.signal.addEventListener('abort',()=>aborted=true);
        started.resolve();
        if(phase==='body')return {ok:true,status:200,json:()=>new Promise(()=>{})};
        return new Promise(()=>{});
      }
      return json({ok:true,capabilities:['chat-mirror']});
    },{setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){}});
    a.enqueue({id:'keep'});
    const run=phase==='delete'?a.clearChatMirrorCloud():a.flushChatMirrorNow();
    const rejected=assert.rejects(run,phase==='health'?/无法确认/:/15 秒/);
    await started.promise;timeout();await rejected;
    assert.ok(aborted);assert.equal(a.loadQueue().length,1);
    const before=requests;stalled=false;
    if(phase==='delete')await a.clearChatMirrorCloud();else await a.flushChatMirrorNow();
    assert.ok(requests>before);assert.equal(a.loadQueue().length,0);
  }
  return {phases:4,queuePreserved:true,retryStartsNewRequest:true};
});
function mirrorEvents(){
  const listeners=new Map(),uploaded=[];
  const state={active:true,hydrated:true,local:[]};
  const a=mirror(async(action,init)=>{
    if(action==='health')return json({ok:true,capabilities:['chat-mirror']});
    if(init.method==='POST')uploaded.push(...JSON.parse(init.body).entries);
    return json({ok:true});
  },{
    window:{addEventListener:(name,fn)=>listeners.set(name,fn),setTimeout:()=>1,clearTimeout(){},setInterval:()=>1},
    isPersonalPushCloudActive:()=>state.active,isChatStorageHydrated:()=>state.hydrated,
    loadChatSessions:()=>[{id:'s',contactId:'c'}],loadChatMessages:(_session,limit)=>limit?state.local.slice(-limit):state.local,
  });
  a.installChatMirror();
  const emit=(name,detail)=>listeners.get(name)({detail});
  const msg=(id,content='old')=>({id,sessionId:'s',role:'assistant',content,createdAt:'2026-09-05T10:00:00Z'});
  return {a,state,uploaded,emit,msg};
}
await test('Editing and deleting while mirror is off reconcile after reenable without uploading while off',async()=>{
  const {a,state,uploaded,emit,msg}=mirrorEvents();
  state.local=[msg('edit'),msg('delete')];
  for(const message of state.local)emit('push',{message});
  a.setChatMirrorEnabled(false);
  const deleted=state.local[1];state.local=[msg('edit','latest')];
  emit('edit',{message:state.local[0]});emit('delete',{messages:[deleted]});
  await a.flushQueue();assert.equal(uploaded.length,0);
  a.setChatMirrorEnabled(true);await a.flushChatMirrorNow();
  assert.equal(uploaded.find(row=>row.id==='edit').content,'latest');
  assert.equal(uploaded.find(row=>row.id==='delete').deleted,true);assert.equal(a.loadQueue().length,0);
  return {offSendsNothing:true,editAndDeleteReconciled:true};
});
await test('Regenerating an already uploaded response while off deletes old cloud IDs and uploads the new batch',async()=>{
  const {a,state,uploaded,emit,msg}=mirrorEvents();
  state.local=[msg('old')];emit('push',{message:state.local[0]});await a.flushChatMirrorNow();
  uploaded.length=0;a.setChatMirrorEnabled(false);
  state.local=[msg('new','regenerated')];emit('replace',{messages:state.local,replacedIds:['old'],sessionId:'s'});
  await a.flushQueue();assert.equal(uploaded.length,0);
  a.setChatMirrorEnabled(true);await a.flushChatMirrorNow();
  assert.equal(uploaded.find(row=>row.id==='old').deleted,true);
  assert.equal(uploaded.find(row=>row.id==='old').characterId,'c');
  assert.equal(uploaded.find(row=>row.id==='new').content,'regenerated');
  return {oldCloudMessageRemoved:true,newBatchUploaded:true};
});
await test('Legacy pending entries reconcile with local originals even beyond recent history',async()=>{
  const {a,state,uploaded,msg}=mirrorEvents();
  a.setChatMirrorEnabled(false);
  a.seed([msg('edit'),msg('missing')]);
  state.local=[msg('edit','current'),...Array.from({length:220},(_,i)=>msg('recent'+i))];
  a.setChatMirrorEnabled(true);await a.flushChatMirrorNow();
  assert.equal(uploaded.find(row=>row.id==='edit').content,'current');
  assert.equal(uploaded.find(row=>row.id==='missing').deleted,true);
  return {staleQueueCorrected:true,missingOriginalDeleted:true};
});
await test('A disabled personal cloud retains new events, and unhydrated storage never fabricates deletions',async()=>{
  const {a,state,uploaded,emit,msg}=mirrorEvents();
  state.active=false;state.local=[msg('keep')];emit('push',{message:state.local[0]});
  assert.equal(a.loadQueue().length,1);await a.flushQueue();assert.equal(uploaded.length,0);
  state.active=true;state.hydrated=false;state.local=[];
  a.setChatMirrorEnabled(true);await assert.rejects(a.flushChatMirrorNow(),/尚未加载/);
  assert.equal(a.loadQueue()[0].deleted,undefined);assert.equal(uploaded.length,0);
  state.hydrated=true;state.local=[msg('keep')];await a.flushChatMirrorNow();
  assert.equal(uploaded[0].deleted,undefined);
  return {inactiveCloudQueuesEvents:true,unloadedIsNotDeleted:true};
});
await test('Historical backfill never evicts pending delete operations from a full queue',async()=>{
  const {a,state,msg}=mirrorEvents();
  a.setChatMirrorEnabled(false);
  a.seed(Array.from({length:5000},(_,i)=>({...msg('gone'+i),deleted:true,content:''})));
  state.local=[msg('recent')];a.setChatMirrorEnabled(true);
  assert.equal(a.loadQueue().length,5000);assert.equal(a.loadQueue()[0].id,'gone0');
  assert.ok(a.loadQueue().every(row=>row.deleted));
  return {pendingDeletesProtected:true};
});


await test('A late success after timeout cannot acknowledge a newer queued edit',async()=>{
  const started=deferred(),late=deferred();let timeout,posts=0;
  const a=mirror(async(action)=>{
    if(action==='health')return json({ok:true,capabilities:['chat-mirror']});
    if(++posts===1){started.resolve();return late.promise;}
    return json({ok:true});
  },{setTimeout:fn=>{timeout=fn;return 1;},clearTimeout(){}});
  a.enqueue({id:'edit',content:'old'});
  const run=a.flushChatMirrorNow();const rejected=assert.rejects(run,/15 秒/);
  await started.promise;timeout();await rejected;
  a.enqueue({id:'edit',content:'new'});late.resolve(json({ok:true}));
  await Promise.resolve();await Promise.resolve();
  assert.equal(a.loadQueue()[0].content,'new');
  await a.flushChatMirrorNow();assert.equal(a.loadQueue().length,0);assert.equal(posts,2);
  return {lateAckIgnored:true,newEditRetried:true};
});
await test('Never-enabled mirror does not start tracking messages or contacting the cloud',async()=>{
  const kv=new Map(),listeners=new Map();let requests=0;
  const a=mirror(async()=>{requests++;return json({ok:true});},{
    kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v),
    window:{addEventListener:(name,fn)=>listeners.set(name,fn),setTimeout:()=>1,clearTimeout(){},setInterval:()=>1},
  });
  a.installChatMirror();
  const message={id:'m',sessionId:'s',role:'user',content:'local',createdAt:new Date().toISOString()};
  for(const name of ['push','edit'])listeners.get(name)({detail:{message}});
  listeners.get('delete')({detail:{messages:[message]}});
  listeners.get('replace')({detail:{messages:[message],replacedIds:['old'],sessionId:'s'}});
  await a.flushQueue();assert.equal(a.loadQueue().length,0);assert.equal(requests,0);
  return {optInPreserved:true};
});


await test('Moments generation publishes one tagged post, returns its ID, and never publishes surrounding drafts',async()=>{
  const actions=moduleVM('lib/action-parser.ts',{},'globalThis.parse=parseActionTags;');
  const posts=[],dispatched=[],h={response:'换个切入。\n[朋友圈]周六。[照片：不使用参考图：书房][/朋友圈]\n符合他的风格：极简。\n[朋友圈]额外一条[/朋友圈]',calls:0};
  const ctx=moduleVM('lib/moments-engine.ts',{
    h,parseActionTags:actions.parse,dispatchActions:async a=>dispatched.push(...a),
    updateScheduleAfterPost(){},assemblePromptPayload:()=>[],findRecentDuplicateMomentPost:()=>null,
    loadChatContacts:()=>[{characterId:'c'}],loadMomentPosts:()=>posts,
    addMomentPost:p=>{const post={...p,id:'p'+(posts.length+1)};posts.push(post);return post;},
    incrementEventCounter(){},maybeRunSummarization:async()=>{},
  },`resolveAssemblerInput=async()=>({input:{},apiConfig:{},preset:{},character:{id:'c',name:'角色'}});
     callLLM=async()=>{h.calls++;return h.response;};
     attachMomentPhotoInBackground=()=>{};generateNPCReactions=async()=>{};
     globalThis.api={postMomentForCharacter,parseMomentPostResponse};`);
  const id=await ctx.api.postMomentForCharacter('c','由头',undefined,'app:one');
  assert.equal(id,'p1');assert.equal(posts.length,1);assert.equal(posts[0].content,'周六。');
  assert.equal(posts[0].photoDescription,'书房');assert.equal(dispatched.length,0);
  assert.equal(await ctx.api.postMomentForCharacter('c','重试',undefined,'app:one'),'p1');assert.equal(h.calls,1);
  for(const response of ['换个切入。符合他的风格：极简。','[朋友圈]没有结束标签','<think>[朋友圈]分析里的草稿[/朋友圈]</think>']){
    h.response=response;await assert.rejects(ctx.api.postMomentForCharacter('c'),/未返回有效/);
  }
  assert.equal(posts.length,1);
  h.response='<think>起草过程</think>[朋友圈]正文[/朋友圈][消息]顺便打招呼[/消息]';
  assert.equal(await ctx.api.postMomentForCharacter('c'),'p2');
  assert.deepEqual(dispatched.map(a=>a.type),['消息']);assert.equal(posts[1].content,'正文');
  assert.equal(ctx.api.parseMomentPostResponse('无标签草稿'),null);
  return {singlePublication:true,correctReceipt:true,draftsRejected:true,idempotentRetry:true,otherActionsPreserved:true};
});

await import('./check-push-outbox-plugins.mjs');
await import('./check-shiguang.mjs');
console.log(`Passed ${results.length} fork regression checks, push outbox plugin checks and Shiguang checks.`);
