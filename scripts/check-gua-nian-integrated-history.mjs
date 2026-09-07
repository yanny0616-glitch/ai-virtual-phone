// Actual mirror snapshot builder -> gateway -> shared worker history -> promise gate.
// Storage/REST are controlled fixtures; no personal cloud or model requests.
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
import {stripTypeScriptTypes} from 'node:module';
import {recheckEvidence} from '../custom-apps/gua-nian/src/domain/promises.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=p=>stripTypeScriptTypes(read(p)).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
const ctx=vm.createContext({Date,Intl,Response,encodeURIComponent});
vm.runInContext(strip('lib/guanian-cloud-history.ts')+';globalThis.api={readGuanianCloudHistory,guanianHistoryText};',ctx);
const out={id:'o1',raw_text:'到了\n我明天三点陪你去医院',created_at:'2026-09-07T08:09:00Z',consumed_at:'2026-09-07T10:52:00Z'};
const batchId='push-outbox:o1';
const records=new Map();let snapshotReadFails=false;let recentOverride;
const history=()=>ctx.api.readGuanianCloudHistory(async p=>{
 if(!p.startsWith('push_chat_mirror'))return Response.json([out]);
 if(p.includes('media_type=eq.response_batch'))return snapshotReadFails?new Response('',{status:503}):Response.json([...records.values()].filter(m=>m.media_type==='response_batch'));
 return Response.json(recentOverride||[...records.values()].filter(m=>m.media_type!=='response_batch'));
},'u','s');
const first={id:'m1',role:'assistant',content:'到了',message_at:out.created_at,response_batch_id:batchId};
records.set(first.id,first);
assert.match((await history()).messages[0].content,/明天三点陪你/);
console.log('PASS R2 partial mirror after ACK retains complete original reply');
records.clear();const fresh={id:'real',role:'assistant',content:'我明天三点陪你去医院',message_at:'2026-09-07T10:53:00Z'};records.set(fresh.id,fresh);
const h=await history();assert.ok(h.messages.some(m=>m.id==='real'));
assert.equal(recheckEvidence(h.messages,[],Date.parse('2026-09-07T10:50:00Z')).promiseUpdate,true);
console.log('PASS R1 unrelated promise within receipt window remains eligible for promise judgement');
records.clear();
const session={id:'s',contactId:'c'},disk={session,batchIds:[batchId],messages:[
 {id:'m1',role:'assistant',sessionId:'s',responseBatchId:batchId,content:'到了',createdAt:out.created_at,order:1},
 {id:'m2',role:'assistant',sessionId:'s',responseBatchId:batchId,content:'我明天三点陪你去医院',createdAt:'2026-09-07T08:09:00.001Z',order:2},
]};
const mirror=vm.createContext({console,Date,registerKvMigration(){},dbReadChatSession:async()=>structuredClone(disk)});
vm.runInContext(strip('lib/chat-mirror-client.ts')+';globalThis.make=mirrorBatchSnapshots;',mirror);
let handler;
vm.runInNewContext(stripTypeScriptTypes(read('supabase/functions/ai-phone-push/index.ts')),{console,Date,Request,Response,URL,Headers,AbortSignal,
 Deno:{env:{get:k=>({SUPABASE_URL:'https://test',SUPABASE_SERVICE_ROLE_KEY:'test'})[k]},serve:f=>handler=f},
 fetch:async(url,init={})=>{if(url.includes('push_chat_mirror')&&init.method==='POST'){for(const r of JSON.parse(init.body))records.set(r.id,r);return Response.json(null);}return Response.json([]);},
});
const affected={id:'m1',sessionId:'s',characterId:'c',responseBatchId:batchId,role:'assistant',content:'到了',createdAt:out.created_at};
const fillers=Array.from({length:49},(_,i)=>({...affected,id:'u'+i,responseBatchId:undefined,role:'user',content:'other'}));
const upload=async(entry=affected)=>{
 const entries=[...fillers,entry];const snapshots=await mirror.make(entries);
 const response=await handler(new Request('https://test?action=chat-mirror',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({entries,snapshots})}));
 assert.equal(response.status,200);return snapshots;
};
await upload();assert.equal(records.has('m2'),false); // 50-entry boundary split the ordinary mirror rows.
let current=await history();assert.match(current.messages.find(m=>m.id===batchId).content,/明天三点陪你/);
assert.equal(current.messages.filter(m=>m.id===batchId).length,1);
console.log('PASS R2 real gateway stores full batch atomically despite a 50-entry boundary');
recentOverride=Array.from({length:200},(_,i)=>({id:'tail'+i,role:'user',content:'recent',message_at:'2026-09-07T09:00:00Z'}));
assert.match((await history()).messages.find(m=>m.id===batchId).content,/明天三点陪你/);recentOverride=undefined;
console.log('PASS R2 targeted snapshot read survives recent-message window truncation');
disk.messages[1].content='改成后天四点见';await upload();current=await history();
assert.match(current.messages.find(m=>m.id===batchId).content,/后天四点/);assert.doesNotMatch(ctx.api.guanianHistoryText(current,480),/明天三点/);
console.log('PASS R2 editing replaces original facts without restoring removed promise text');
const kv=new Map([['chat_mirror_enabled_v1','1']]);let posted;
const client=vm.createContext({console,Date,crypto:webcrypto,AbortController,setTimeout,clearTimeout,
 registerKvMigration(){},kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v),isChatStorageHydrated:()=>true,isPersonalPushCloudActive:()=>true,
 window:{setTimeout:()=>1,clearTimeout(){}},navigator:{locks:{request:async(_name,fn)=>fn()}},dbReadChatSession:async()=>structuredClone(disk),
 personalPushFetch:async(action,init)=>{
  if(action==='health')return Response.json({ok:true,capabilities:['chat-mirror','chat-mirror-batches']});
  posted=JSON.parse(init.body);
  return handler(new Request('https://test?action=chat-mirror',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:init.body}));
 },
});
vm.runInContext(strip('lib/chat-mirror-client.ts')+';globalThis.api={enqueue,flushChatMirrorNow};',client);
client.api.enqueue(affected);const flushed=await client.api.flushChatMirrorNow();
assert.equal(flushed.queued,0);assert.equal(posted.snapshots[0].messages.length,2);
assert.match((await history()).messages.find(m=>m.id===batchId).content,/后天四点/);
console.log('PASS R2 actual client negotiates batch capability and flushes the complete durable snapshot');
disk.messages.splice(0);await upload({...affected,deleted:true});
assert.equal((await history()).messages.some(m=>m.id===batchId),false);
console.log('PASS R2 empty authoritative snapshot preserves whole-batch deletion despite stale bubble rows');
snapshotReadFails=true;await assert.rejects(history(),/整轮聊天镜像读取失败/);snapshotReadFails=false;
const before=JSON.stringify([...records]);
const bad=await handler(new Request('https://test?action=chat-mirror',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({entries:[affected],snapshots:[{batchId,sessionId:'s',createdAt:out.created_at,messages:[{id:'bad',content:'bad'}]}]})}));
assert.equal(bad.status,400);assert.equal(JSON.stringify([...records]),before);
console.log('PASS R2 incomplete/failed snapshots are never silently accepted or used as full history');
