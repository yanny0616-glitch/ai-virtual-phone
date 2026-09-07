import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
const code=stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/ai-phone-push/index.ts',import.meta.url),'utf8'));
function gateway(fetcher){
  let handler;
  const c=vm.createContext({console,Date,Request,Response,URL,Headers,AbortSignal,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,
    Deno:{env:{get:k=>({SUPABASE_URL:'https://test',SUPABASE_SERVICE_ROLE_KEY:'test'})[k]},serve:f=>handler=f},fetch:fetcher});
  vm.runInContext(code+';globalThis.encrypt=encryptPayload;',c);
  return {encrypt:c.encrypt,post:(action,body)=>handler(new Request('https://test?action='+action,{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify(body)}))};
}
for(const mode of ['modern','legacy','other-column','permission','legacy-write-failed']){
  const writes=[];
  const g=gateway(async(url,init={})=>{
    if(url.includes('push_chat_mirror')){
      const rows=JSON.parse(init.body);writes.push(rows);
      if(mode==='permission')return Response.json({code:'42501',message:'permission denied'},{status:403});
      if(mode==='other-column')return Response.json({code:'PGRST204',message:'Missing media_type'},{status:400});
      if(mode.startsWith('legacy') && 'response_batch_id' in rows[0])return Response.json({code:'PGRST204',message:"Could not find the 'response_batch_id' column"},{status:400});
      if(mode==='legacy-write-failed')return Response.json({code:'XX000',message:'write failed'},{status:500});
      return Response.json([]);
    }
    return Response.json([]);
  });
  const input={id:'m',sessionId:'s',characterId:'c',role:'user',content:'new message',createdAt:'2026-09-07T08:00:00Z',responseBatchId:'batch'};
  const r=await g.post('chat-mirror',{entries:[input]});
  assert.equal(r.status,['modern','legacy'].includes(mode)?200:500);
  assert.equal(writes.length,mode.startsWith('legacy')?2:1);
  if(mode==='modern')assert.equal(writes[0][0].response_batch_id,'batch');
  if(mode.startsWith('legacy')){assert.equal('response_batch_id' in writes[1][0],false); const {response_batch_id,...expected}=writes[0][0];assert.deepEqual(writes[1][0],expected);}
}
console.log('PASS B20 old mirror columns fall back narrowly; unrelated/failed writes remain errors');
for(const mode of ['pending','generated','output','running','cached','conflict','read-failed','missing','cancelled']){
  let payload,patched=0;
  const g=gateway(async(url,init={})=>{
    if(url.includes('push_server_config'))return Response.json([{payload_key:'test-key'}]);
    if(url.includes('push_outbox'))return Response.json(mode==='output'?[{created_at:'2026-09-07T08:09:00Z'}]:[]);
    if(url.includes('push_jobs')){
      assert.match(url,/user_id=eq.owner/);assert.match(url,/kind=eq.timed_task/);
      if(init.method==='PATCH'){
        patched++;assert.match(url,/status=eq.pending/);assert.match(url,/updated_at=eq./);assert.equal(JSON.parse(init.body).status,'cancelled');
        return Response.json(mode==='conflict'?[]:[{id:'j'}]);
      }
      if(mode==='read-failed')return new Response('',{status:503});
      if(mode==='missing')return Response.json([]);
      return Response.json([{id:'j',status:mode==='generated'?'done':['running','cancelled'].includes(mode)?mode:'pending',result_note:mode==='generated'?'generated, pushed 1':'',updated_at:'2026-09-07T08:09:00Z',payload}]);
    }
    return Response.json([]);
  });
  payload=await g.encrypt(JSON.stringify(mode==='cached'?{generatedResponse:{rawText:'saved'}}:{request:{}}),'test-key');
  const r=await g.post('cancel-wake',{triggerKey:'timedwake:capp_app_gua.nian_w'});const body=await r.json();
  if(['pending','generated','output','missing','cancelled'].includes(mode))assert.equal(r.status,200);else assert.ok(r.status>=400);
  if(['generated','output'].includes(mode)){assert.equal(body.outcome,'generated');assert.equal(patched,0);}
  if(mode==='pending')assert.equal(body.outcome,'cancelled');
  assert.equal(patched,['pending','conflict'].includes(mode)?1:0);
}
console.log('PASS B17 exact cancellation preserves generated output; running/cached/racing jobs cannot be labelled cancelled');
const html=fs.readFileSync(new URL('../custom-apps/gua-nian/index.html',import.meta.url),'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
for(const mode of ['generated','cancelled','running','missing','local-missing','partial']){
  const h={rows:{},cancelled:[],count:0};
  const now=Date.now();
  const c=vm.createContext({console,h,Date,URLSearchParams,AbortController,setTimeout,clearTimeout,
    AiPhone:{push:{cancelWake:async id=>{h.cancelled.push(id);return {ok:false};}},db:{list:async t=>h.rows[t]||[],create:async(t,row)=>{const value={id:t,...row};(h.rows[t]||=[]).push(value);return value;},update:async(t,id,row)=>Object.assign(h.rows[t].find(v=>v.id===id),row)}}});
  vm.runInContext(html.replace(/  init\(\);\s*\}\)\(\);\s*$/,`cloudCfg=()=>h.local?null:{url:'https://test'};
    cloudFetchBounded=async()=>{h.count++;if(h.mode==='running'||h.mode==='partial'&&h.count===2)throw Error('running');return {outcome:h.mode==='partial'?'cancelled':h.mode,generatedAt:new Date().toISOString()};};
    log=async()=>{};globalThis.api={S,ctxOf,dropThreadSlots,decStatus};})();`),c);
  h.mode=mode;h.local=mode==='local-missing';
  c.api.S.settings={};const cx=c.api.ctxOf({id:'c'});
  cx.plan={items:[{act:true,from:'p',wakeId:'w',time:'16:09',fireAt:now-60000,kind:'extra'}]};
  if(mode==='partial')cx.plan.items.push({...cx.plan.items[0],wakeId:'w2'});
  const run=c.api.dropThreadSlots(cx,'p','已了结');
  if(['running','missing','local-missing','partial'].includes(mode))await assert.rejects(run);else await run;
  const w=cx.plan.items[0];
  if(mode==='generated'){assert.equal(w.act,true);assert.equal(w.wakeId,'w');assert.ok(w.sendConfirmed&&w.generatedAt);assert.equal(c.api.decStatus(w,null,cx).status,'sent');}
  else if(['cancelled','partial'].includes(mode)){assert.equal(w.act,false);assert.equal(w.wakeId,'');if(mode==='partial'){assert.equal(cx.plan.items[1].act,true);assert.equal(cx.plan.items[1].wakeId,'w2');}}
  else {assert.equal(w.act,true);assert.equal(w.wakeId,'w');}
}
console.log('PASS B17 actual app preserves sent/unknown records and quota; partial cancellation progress survives a later failure');
