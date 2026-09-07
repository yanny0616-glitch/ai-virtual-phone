// Fault injection against the actual storage, outbox, parser and proxy modules.
// No production network, credentials or Next.js build.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const root = new URL('../', import.meta.url);
const quiet = { log() {}, warn() {}, error() {} };
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const clone = value => structuredClone(value);
let checks = 0;
async function test(name, fn) { if (process.env.FLOAT_CHECK_FILTER && !new RegExp(process.env.FLOAT_CHECK_FILTER).test(name)) return; await fn(); checks++; console.log('PASS', name); }
function load(file, globals, expose) {
    let src = stripTypeScriptTypes(fs.readFileSync(new URL(file, root), 'utf8'));
    src = src.replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/\bexport\s+(?=(?:async\s+)?function|const |class )/g, '')
        .replace('await import("./reality-bridge/engine")', 'bridgeEngine');
    const ctx = vm.createContext({ navigator: {locks:{request:async(_name,_options,run)=>run({})}}, console: quiet, Date, URL, Request, Response, Headers, Buffer, AbortController, AbortSignal, TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout, ...globals });
    vm.runInContext(src + '\nglobalThis.api={' + expose + '};', ctx);
    return ctx.api;
}
function kvHarness() {
    const disk = new Map(), legacy = new Map();
    const state = { fail: false, barrier: null, writes: 0 };
    class Dexie {
        version() { return { stores: () => { this.entries = {
            toArray: async () => [...disk].map(([key, value]) => ({ key, value })),
            put: async row => { state.writes++; if (state.barrier) await state.barrier; if (state.fail) throw new Error('IDB failed'); disk.set(row.key, row.value); },
            bulkPut: async rows => { state.writes++; if (state.barrier) await state.barrier; if (state.fail) throw new Error('IDB failed'); rows.forEach(row => disk.set(row.key, row.value)); },
        }; } }; }
    }
    const localStorage = { getItem: k => legacy.get(k) ?? null, removeItem: k => legacy.delete(k), setItem: (k,v) => legacy.set(k,v), get length() { return legacy.size; }, key: i => [...legacy.keys()][i] };
    const api = load('lib/kv-db.ts', { Dexie, localStorage, window: {} }, 'registerKvMigration,registerDynamicPrefix,hydrateKvDb,isKvHydrated,kvGet');
    return { ...api, disk, legacy, state };
}
for (const dynamic of [false, true]) await test(`KV ${dynamic ? 'prefix' : 'fixed'} migration retries a failed write before deleting source`, async () => {
    const h = kvHarness(); h.disk.set('k:one', 'old'); h.legacy.set('k:one', 'new');
    if (dynamic) h.registerDynamicPrefix('k:'); else h.registerKvMigration('k:one');
    h.state.fail = true; await h.hydrateKvDb();
    assert.equal(h.isKvHydrated(), false); assert.equal(h.legacy.get('k:one'), 'new');
    h.state.fail = false; await h.hydrateKvDb();
    assert.equal(h.isKvHydrated(), true); assert.equal(h.disk.get('k:one'), 'new'); assert.equal(h.legacy.size, 0); assert.equal(h.state.writes, 2);
});
await test('KV migration completion preserves a newer source value written during commit', async () => {
    const h = kvHarness(); h.legacy.set('k', 'first'); h.registerKvMigration('k');
    let release; h.state.barrier = new Promise(resolve => { release = resolve; });
    const run = h.hydrateKvDb(); await flush(); h.legacy.set('k', 'second'); release(); await run;
    assert.equal(h.disk.get('k'), 'first'); assert.equal(h.legacy.get('k'), 'second');
});
for (const dynamic of [false, true]) await test(`KV late ${dynamic ? 'prefix' : 'fixed'} registration retains failed source and retries`, async () => {
    const h = kvHarness(); await h.hydrateKvDb(); h.legacy.set('late:k', 'new'); h.state.fail = true;
    const register = () => dynamic ? h.registerDynamicPrefix('late:') : h.registerKvMigration('late:k');
    register(); await flush(); assert.equal(h.legacy.get('late:k'), 'new');
    h.state.fail = false; register(); await flush(); assert.equal(h.disk.get('late:k'), 'new'); assert.equal(h.legacy.size, 0);
});
function chatHarness() {
    const disk = { messages: new Map(), sessions: new Map(), responseBatches: new Map() };
    const state = { failAt: '', ackFail: false, entries: [], acks: [], transforms: 0, hooks: 0, published: 0 };
    let tx = null;
    class Dexie {
        version() { return { stores: () => { for (const name of ['messages','sessions','responseBatches']) this[name] ||=  {
            get: async key => (tx ?? disk)[name].get(Array.isArray(key)?JSON.stringify(key):key),
            where: () => ({equals: sid => ({filter: f => ({first: async()=>[...(tx ?? disk)[name].values()].find(r=>r.sessionId===sid&&f(r))})})}),
            put: async row => { (tx ?? disk)[name].set(row.id ?? JSON.stringify([row.sessionId,row.batchId]), clone(row)); },
            bulkPut: async rows => { for (const row of rows) (tx ?? disk)[name].set(row.id ?? JSON.stringify([row.sessionId,row.batchId]), clone(row)); if (tx && state.failAt === name) throw new Error('QuotaExceededError'); },
        }; } }; }
        async transaction(...args) {
            const fn=args.at(-1);
            tx = { messages: new Map(disk.messages), sessions: new Map(disk.sessions), responseBatches:new Map(disk.responseBatches) };
            try { const result=await fn(); disk.messages = tx.messages; disk.sessions = tx.sessions; disk.responseBatches=tx.responseBatches; return result; } finally { tx = null; }
        }
    }
    const db = load('lib/chat-db.ts', { Dexie }, 'dbPutMessage,dbPutMessages,dbPutSessions,dbPutMessageBatch,dbHasResponseBatch,dbEnsureImportedMessage');
    const session = { id: 's', contactId: 'g', isGroup: true, groupName: 'Test', participantIds: [], unreadCount: 0, updatedAt: new Date().toISOString() };
    const browser = { dispatchEvent(e) { if(e.type === 'chat-message-pushed') state.published++; } };
    const CustomEvent = class { constructor(type, init) { this.type=type; this.detail=init?.detail; } };
    const chat = load('lib/chat-storage.ts', { ...db, dbReadChatSession:async id=>({messages:[...disk.messages.values()].filter(m=>m.sessionId===id).map(clone),session:clone(disk.sessions.get(id)),batchIds:[...disk.responseBatches.values()].filter(r=>r.sessionId===id).map(r=>r.batchId)}), window: browser, CustomEvent, registerKvMigration() {}, kvGet: () => null, resolveUserIdentity: () => ({name:'User'}), loadCharacters: () => [], emitChatPluginEvent() {}, runChatPluginTransformSync: (_p,v) => { state.hooks++; return v; }, dbReplaceSessions() {} }, 'refreshChatSessionFromDisk,hasPersistedResponseBatch,pushChatMessage,loadChatMessages,loadChatSessions,persistChatMessages,createChatMessageBatch,upsertImportedChatMessageAsync,reindexSessionMessageOrdersByTime,seed(s,msgs=[]){_sessionsCache=[s];_messagesCache=msgs;_hydrated=true;}');
    chat.seed(session);
    const parser = load('lib/follow-up-service.ts', { ...chat, getChatPluginRuntime: () => ({ensureReady:async()=>{}}), runChatPluginTransform: async (_point,payload) => payload, window: browser, CustomEvent, loadChatSessions: () => [session], createResponseBatchId: () => 'random-batch', isPendingChatGeneratedImageMessage: () => false, parseAIResponse: text => ({parts: text === '' ? [] : text === 'call' ? [{mediaType:'voice_call'}] : text === 'transfer' ? [{mediaType:'accept_transfer'},{mediaType:'accept_transfer'}] : text.split('|').map(content => ({content})), stateValues:[],freshStateValues:[]}) }, 'parseAndSaveResponse');
    const outbox = load('lib/push-outbox-client.ts', { settleDeferredReplyDelivery() {}, ...chat,...parser, window: browser, isPersonalPushCloudActive: () => true, loadScreenChatSettings: () => ({enabled:true}), getChatPluginRuntime: () => ({ensureStarted:async()=>{}}), loadChatSessions: () => [session], runChatPluginTransform: async (_p,v) => { state.transforms++; return v; }, stripHallucinatedTimestamps: t => t, scheduleFollowUp() {}, reindexSessionMessageOrdersByTime() {}, saveScreenChatAck() {}, bridgeEngine: {applyServerBridgeEntry:async()=>({sessionId:'s'})}, personalPushFetch:async(_a,init)=>{
        if (init?.method === 'POST') { if(state.ackFail) return Response.json({ok:false},{status:503}); const ids=JSON.parse(init.body).ids; state.acks.push(...ids); state.entries=state.entries.filter(e=>!ids.includes(e.id)); return Response.json({ok:true}); }
        return Response.json({ok:true,entries:state.entries});
    } }, 'consumeServerOutbox');
    return {chat,parser,outbox,state,disk,session};
}
function entry(meta={}) { return { id:'e',session_id:'s',raw_text:'first|second',trigger_key:null,meta }; }
await test('Cloud timestamp: delayed rounds keep generation times, order, preview and durable retry', async()=>{
    const h=chatHarness();
    h.chat.pushChatMessage({sessionId:'s',role:'user',content:'我醒了',createdAt:'2026-09-07T10:40:00.000Z'});
    h.state.entries=[
        {...entry(),id:'arrived',created_at:'2026-09-07T08:09:19.23957Z',raw_text:'到了|粥在锅里'},
        {...entry(),id:'dinner',created_at:'2026-09-07T09:14:14.835Z',raw_text:'醒了吗|我六点半到家'},
    ];
    h.state.ackFail=true;
    await h.outbox.consumeServerOutbox({force:true});
    await flush();
    const expectedTimes=['2026-09-07T08:09:19.239Z','2026-09-07T08:09:19.240Z','2026-09-07T09:14:14.835Z','2026-09-07T09:14:14.836Z','2026-09-07T10:40:00.000Z'];
    const check=()=>{
        const messages=h.chat.loadChatMessages('s');
        assert.deepEqual(Array.from(messages,m=>m.createdAt),expectedTimes);
        assert.deepEqual(Array.from(messages,m=>m.content),['到了','粥在锅里','醒了吗','我六点半到家','我醒了']);
        assert.equal(h.chat.loadChatSessions()[0].lastMessageId,messages[4].id);
        assert.equal(h.chat.loadChatSessions()[0].updatedAt,expectedTimes[4]);
    };
    check();
    h.chat.seed(h.session,[...h.disk.messages.values()].map(clone));
    check();
    h.state.ackFail=false;
    await h.outbox.consumeServerOutbox({force:true});
    check();
    assert.equal(h.state.transforms,2);
    assert.equal(h.disk.messages.size,5);
    assert.deepEqual(h.state.acks,['arrived','dinner']);
});
await test('B21: delayed batches preserve every old message byte and order across reload and retry', async()=>{
    for (const ambiguous of [false,true]) {
        const h=chatHarness();
        const old=[
            {id:'old-a',sessionId:'s',role:'user',content:'first by order',createdAt:'2026-09-07T10:40:00Z',order:10,status:'sent'},
            {id:'old-b',sessionId:'s',role:'user',content:'older timestamp',createdAt:'2026-09-07T07:00:00Z',order:20,status:'sent'},
            {id:'old-c',sessionId:'s',role:'user',content:'invalid legacy time',createdAt:'invalid',order:30,status:'sent'},
        ];
        if(ambiguous) {old[0].order=1;old[1].order=1+Number.EPSILON;old[2].order=2;old[0].createdAt='2026-09-07T07:00:00Z';old[1].createdAt='2026-09-07T10:00:00Z';}
        h.chat.seed(h.session,clone(old)); old.forEach(m=>h.disk.messages.set(m.id,clone(m)));
        h.state.entries=[{...entry(),created_at:'2026-09-07T08:09:00Z'}]; h.state.ackFail=true;
        await h.outbox.consumeServerOutbox({force:true});
        const first=Array.from(h.chat.loadChatMessages('s'),m=>m.id);
        assert.deepEqual(first.filter(id=>id.startsWith('old-')),old.map(m=>m.id));
        for(const m of old) assert.deepEqual(h.disk.messages.get(m.id),m);
        h.chat.seed(h.session,[...h.disk.messages.values()].map(clone));
        assert.deepEqual(Array.from(h.chat.loadChatMessages('s'),m=>m.id),first);
        h.state.ackFail=false; await h.outbox.consumeServerOutbox({force:true});
        assert.equal(h.disk.messages.size,5);
        for(const m of old) assert.deepEqual(h.disk.messages.get(m.id),m);
    }
});
await test('B21: fixed-ID bridge input inserts durably without moving existing rows',async()=>{
    const h=chatHarness();
    h.chat.pushChatMessage({sessionId:'s',role:'user',content:'later',createdAt:'2026-09-07T10:40:00Z'});
    const before=clone([...h.disk.messages.values()][0]);
    const incoming={id:'bridge-input',sessionId:'s',role:'user',content:'bridge',createdAt:'2026-09-07T08:00:00Z',status:'sent'};
    await h.chat.upsertImportedChatMessageAsync(incoming,{insertByCreatedAt:true});
    const ids=Array.from(h.chat.loadChatMessages('s'),m=>m.id);
    assert.equal(ids[0],'bridge-input'); assert.deepEqual(h.disk.messages.get(before.id),before);
    h.chat.seed(h.session,[...h.disk.messages.values()].map(clone));
    assert.deepEqual(Array.from(h.chat.loadChatMessages('s'),m=>m.id),ids);
    await h.chat.upsertImportedChatMessageAsync(incoming,{insertByCreatedAt:true});
    assert.equal(h.disk.messages.size,2);
});
await test('B21: fixed-ID bridge retry preserves another page committed edit',async()=>{
    const h=chatHarness(); const message={id:'bridge-input',sessionId:'s',role:'user',content:'old',createdAt:'2026-09-07T08:00:00Z'};
    await h.chat.upsertImportedChatMessageAsync(message,{insertByCreatedAt:true});
    h.disk.messages.set(message.id,{...h.disk.messages.get(message.id),content:'edited elsewhere'});
    await h.chat.upsertImportedChatMessageAsync(message,{insertByCreatedAt:true});
    assert.equal(h.disk.messages.get(message.id).content,'edited elsewhere');
    assert.equal(h.chat.loadChatMessages('s')[0].content,'edited elsewhere');
});
await test('Cloud timestamp: missing or invalid legacy times fall back to receipt time',async()=>{
    for(const created_at of [undefined,'invalid']){
        const h=chatHarness(), before=Date.now();
        h.state.entries=[{...entry(),created_at}];
        await h.outbox.consumeServerOutbox({force:true});
        for(const message of h.chat.loadChatMessages('s')){
            assert.ok(Date.parse(message.createdAt)>=before && Date.parse(message.createdAt)<=Date.now());
        }
        assert.equal(h.disk.messages.size,2);
        assert.deepEqual(h.state.acks,['e']);
    }
});
await test('Cloud timestamp: call-only batch preserves its original time and chronological position',async()=>{
    const h=chatHarness();
    h.chat.pushChatMessage({sessionId:'s',role:'user',content:'later',createdAt:'2026-09-07T10:40:00.000Z'});
    h.state.entries=[{...entry(),raw_text:'call',created_at:'2026-09-07T08:09:19.239Z'}];
    await h.outbox.consumeServerOutbox({force:true});
    assert.equal(h.chat.loadChatMessages('s')[0].createdAt,'2026-09-07T08:09:19.239Z');
    assert.equal(h.chat.loadChatMessages('s')[1].content,'later');
    assert.deepEqual(h.state.acks,['e']);
});
for (const failAt of ['messages','sessions','responseBatches']) for (const bridge of [false,true]) await test(`Outbox ${bridge?'bridge':'normal'} ${failAt} failure rolls back whole batch; retry publishes once`, async()=>{
    const h=chatHarness(); h.state.failAt=failAt; h.state.entries=[entry(bridge?{kind:'bridge',reply:{sessionId:'s'}}:{})];
    await h.outbox.consumeServerOutbox({force:true});
    assert.equal(h.disk.messages.size,0); assert.equal(h.chat.loadChatMessages('s').length,0); assert.equal(h.state.acks.length,0); assert.equal(h.state.published,0);
    h.state.failAt=''; await h.outbox.consumeServerOutbox({force:true});
    assert.equal(h.disk.messages.size,2); assert.equal(h.chat.loadChatMessages('s').length,2); assert.deepEqual(h.state.acks,['e']); assert.equal(h.state.transforms,1); assert.equal(h.state.hooks,2); assert.equal(h.state.published,2);
});
await test('Outbox ack failure retry preserves both bubbles without rerunning plugins', async()=>{
    const h=chatHarness(); h.state.entries=[entry()]; h.state.ackFail=true; await h.outbox.consumeServerOutbox({force:true});
    assert.equal(h.disk.messages.size,2); h.chat.seed(h.session,[...h.disk.messages.values()].map(clone));
    h.state.ackFail=false; await h.outbox.consumeServerOutbox({force:true});
    assert.equal(h.disk.messages.size,2); assert.equal(h.state.transforms,1); assert.deepEqual(h.state.acks,['e']);
});
await test('New page after failed transaction can import the complete cloud batch', async()=>{
    const old=chatHarness(); old.state.entries=[entry()]; old.state.failAt='sessions'; await old.outbox.consumeServerOutbox({force:true});
    const fresh=chatHarness(); for(const name of ["messages","sessions","responseBatches"]) fresh.disk[name]=new Map([...old.disk[name]].map(([k,v])=>[k,clone(v)])); fresh.chat.seed(fresh.session,[...old.disk.messages.values()].map(clone)); fresh.state.entries=clone(old.state.entries);
    await fresh.outbox.consumeServerOutbox({force:true}); assert.equal(fresh.disk.messages.size,2); assert.deepEqual(fresh.state.acks,['e']);
});
await test('New page after successful commit skips plugins and only retries cloud ack', async()=>{
    const old=chatHarness(); old.state.entries=[entry()]; old.state.ackFail=true; await old.outbox.consumeServerOutbox({force:true});
    const fresh=chatHarness(); for(const name of ["messages","sessions","responseBatches"]) fresh.disk[name]=new Map([...old.disk[name]].map(([k,v])=>[k,clone(v)])); fresh.chat.seed(fresh.session,[...old.disk.messages.values()].map(clone)); fresh.state.entries=clone(old.state.entries);
    await fresh.outbox.consumeServerOutbox({force:true}); assert.equal(fresh.disk.messages.size,2); assert.equal(fresh.state.transforms,0); assert.deepEqual(fresh.state.acks,['e']);
});
await test('Transfer action notice and original message update commit together',async()=>{
    const h=chatHarness(); const input={id:'transfer-in',sessionId:'s',role:'user',content:'transfer',mediaType:'transfer',mediaData:{status:'pending'},createdAt:new Date().toISOString()};
    h.chat.seed(h.session,[input]); h.disk.messages.set(input.id,clone(input)); h.state.entries=[{...entry(),raw_text:'transfer'}]; h.state.failAt='sessions';
    await h.outbox.consumeServerOutbox({force:true}); assert.equal(h.disk.messages.size,1); assert.equal(h.chat.loadChatMessages('s')[0].mediaData.status,'pending'); assert.equal(h.state.acks.length,0);
    h.state.failAt=''; await h.outbox.consumeServerOutbox({force:true}); assert.equal(h.disk.messages.size,2); assert.equal(h.disk.messages.get(input.id).mediaData.status,'received'); assert.deepEqual(h.state.acks,['e']);
});
await test('Existing memory-only batch is not acknowledged while persistence fails', async()=>{
    const h=chatHarness(); h.state.entries=[entry()]; h.chat.seed(h.session,[{id:'old',role:'assistant',content:'old',sessionId:'s',responseBatchId:'push-outbox:e',createdAt:new Date().toISOString()}]);
    h.state.failAt='messages'; await h.outbox.consumeServerOutbox({force:true}); assert.equal(h.state.acks.length,0);
    h.state.failAt=''; await h.outbox.consumeServerOutbox({force:true}); assert.deepEqual(h.state.acks,['e']); assert.equal(h.disk.messages.size,2); assert.equal(h.chat.loadChatMessages('s').length,2);
});
await test('Outbox draft cleanup never removes another session with the same copied batch ID',async()=>{
    const h=chatHarness(); const copied={id:'copy',sessionId:'other',role:'assistant',content:'copy',responseBatchId:'push-outbox:e',createdAt:'2026-09-07T08:00:00Z'};
    h.chat.seed(h.session,[copied]);h.state.entries=[entry()];
    await h.outbox.consumeServerOutbox({force:true});
    assert.equal(h.chat.loadChatMessages('other').length,1);assert.equal(h.chat.loadChatMessages('s').length,2);
});
await test('Outbox empty parsed response retains receipt across failed ack without replaying transforms',async()=>{
    const h=chatHarness(); h.state.entries=[{...entry(),raw_text:''}]; h.state.ackFail=true;
    await h.outbox.consumeServerOutbox({force:true});
    assert.equal(h.disk.messages.size,0); assert.equal(h.disk.responseBatches.size,1);
    h.state.ackFail=false; await h.outbox.consumeServerOutbox({force:true});
    assert.equal(h.state.transforms,1);assert.deepEqual(h.state.acks,['e']);
});
await test('Call-only replies use stable batch identity and do not duplicate after ack failure', async()=>{
    const h=chatHarness(); h.state.entries=[{...entry(),raw_text:'call'}]; h.state.ackFail=true; await h.outbox.consumeServerOutbox({force:true});
    h.state.ackFail=false; await h.outbox.consumeServerOutbox({force:true}); assert.equal(h.disk.messages.size,1); assert.equal(h.state.transforms,1);
});
await test('Retry with changed action selection never substitutes an old notice for a text bubble',async()=>{
    const h=chatHarness();const first=h.chat.createChatMessageBatch('changed');
    first.push({sessionId:'s',role:'system',content:'action notice'});first.push({sessionId:'s',role:'assistant',content:'text'});
    h.state.failAt='sessions';await assert.rejects(first.commit());h.state.failAt='';
    const retry=h.chat.createChatMessageBatch('changed');retry.push({sessionId:'s',role:'assistant',content:'text'});await retry.commit();
    assert.equal(h.disk.messages.size,1);assert.equal([...h.disk.messages.values()][0].content,'text');assert.equal(h.state.hooks,2);
});
await test('Bridge causal input is durable before cache insertion, retry uses original ID', async()=>{
    const h=chatHarness(), msg={id:'bridge-fixed',sessionId:'s',role:'user',content:'input',createdAt:new Date().toISOString(),status:'sent'};
    h.state.failAt='sessions'; await assert.rejects(h.chat.upsertImportedChatMessageAsync(msg)); assert.equal(h.chat.loadChatMessages('s').length,0);
    h.state.failAt=''; await h.chat.upsertImportedChatMessageAsync(msg); await h.chat.upsertImportedChatMessageAsync(msg); assert.equal(h.disk.messages.size,1); assert.equal(h.chat.loadChatMessages('s').length,1);
});
class NextResponse extends Response { static json(v, init) { return Response.json(v, init); } }
for (const phase of ['text','binary','discovery','request-discovery','post','post-body','reply']) await test(`Proxy deadline covers ${phase} and releases timers/readers`, async()=>{
    const timers=new Map(),signals=[]; let sequence=0;
    const stream=(signal,first='')=>new ReadableStream({start(c){if(first)c.enqueue(new TextEncoder().encode(first)); signal.addEventListener('abort',()=>{try{c.error(new DOMException('aborted','AbortError'));}catch{}},{once:true});}});
    const method=phase==='discovery'?'SSE_DISCOVER':['request-discovery','post','post-body','reply'].includes(phase)?'SSE_REQUEST':'GET';
    const api=load('app/api/tool-proxy/route.ts',{NextResponse,process:{env:{}},UnsafeOutboundUrlError:class extends Error{},setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),safeOutboundFetch:async(_url,init)=>{
        signals.push(init.signal);
        if(signals.length===2){
            if(phase==='post') return new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
            if(phase==='post-body') return new Response(stream(init.signal),{status:500});
            return new Response(null,{status:202});
        }
        return new Response(stream(init.signal,['post','post-body','reply'].includes(phase)?'event: endpoint\ndata: /messages\n\n':''),{headers:{'Content-Type':phase==='binary'?'image/png':method==='GET'?'application/json':'text/event-stream'}});
    }},'POST');
    const run=api.POST(new Request('http://test.invalid',{method:'POST',body:JSON.stringify({url:'https://upstream.invalid',method,timeoutMs:1000,body:method==='SSE_REQUEST'?{}:undefined})}));
    await flush(); const timeout=[...timers.values()].find(t=>t.ms===1000); assert.ok(timeout); timeout.fn();
    const response=await run; assert.equal(response.status,504); assert.match((await response.json()).error,/1秒/); assert.ok(signals.every(signal=>signal===signals[0]&&signal.aborted)); assert.equal(timers.size,0);
});
await test('Client cancellation interrupts response-body reads and releases the deadline',async()=>{
    const timers=new Map();let upstreamSignal;
    const api=load('app/api/tool-proxy/route.ts',{NextResponse,process:{env:{}},UnsafeOutboundUrlError:class extends Error{},setTimeout:fn=>{timers.set(1,fn);return 1;},clearTimeout:id=>timers.delete(id),safeOutboundFetch:async(_url,init)=>{
        upstreamSignal=init.signal;
        return new Response(new ReadableStream({start(c){init.signal.addEventListener('abort',()=>c.error(new DOMException('aborted','AbortError')),{once:true});}}));
    }},'POST');
    const client=new AbortController();
    const run=api.POST(new Request('http://test.invalid',{method:'POST',signal:client.signal,body:JSON.stringify({url:'https://upstream.invalid',method:'GET'})}));
    await flush();client.abort();const response=await run;
    assert.notEqual(response.status,200);assert.ok(upstreamSignal.aborted);assert.equal(timers.size,0);
});
await test('Proxy normal and SSE success keep response format and clean up',async()=>{
    for(const sse of [false,true]){
        const timers=new Map();let seq=0,emit;
        const api=load('app/api/tool-proxy/route.ts',{NextResponse,process:{env:{}},UnsafeOutboundUrlError:class extends Error{},setTimeout:(fn)=>{const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),safeOutboundFetch:async(_url,init)=>{
            if(!sse)return Response.json({ok:true});
            if(init.method==='POST'){emit.enqueue(new TextEncoder().encode('event: message\ndata: {"result":"ok"}\n\n'));return new Response(null,{status:202});}
            return new Response(new ReadableStream({start(c){emit=c;c.enqueue(new TextEncoder().encode('event: endpoint\ndata: /messages\n\n'));}}));
        }},'POST');
        const response=await api.POST(new Request('http://test.invalid',{method:'POST',body:JSON.stringify({url:'https://upstream.invalid',method:sse?'SSE_REQUEST':'GET',body:sse?{}:undefined})}));
        assert.equal(response.status,200);assert.deepEqual(await response.json(),sse?{result:'ok'}:{ok:true});assert.equal(timers.size,0);
    }
});
console.log(`Passed ${checks} persistence/proxy regression checks.`);
