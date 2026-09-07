import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { recheckFixture } from './lib/gua-nian-recheck-fixture.mjs';
import { fixture } from './lib/gua-nian-worker-fixture.mjs';
const code=stripTypeScriptTypes(fs.readFileSync(new URL('../lib/guanian-cloud-history.ts',import.meta.url),'utf8')).replace(/^export /gm,'');
const c=vm.createContext({Date,Intl,Response,encodeURIComponent});
vm.runInContext(code+';globalThis.api={readGuanianCloudHistory,guanianHistoryText,guanianHistoryRounds,guanianTimezone,guanianContextTimezone};',c);
const a=c.api;
const at=Date.parse('2026-09-07T12:00:00Z');
const output={id:'o1',raw_text:'到了',created_at:'2026-09-07T08:09:00Z',consumed_at:'2026-09-07T10:52:00Z'};
for(const mode of ['ambiguous','two-outputs','modified','unrelated']){
 const mirrors=[{id:'m1',role:'assistant',content:mode==='modified'?'到了（表情）':'到了',message_at:'2026-09-07T10:52:00Z'}];
 const outputs=[output];
 if(mode==='ambiguous')mirrors.push({...mirrors[0],id:'m2'});
 if(mode==='two-outputs')outputs.push({...output,id:'o2',created_at:'2026-09-07T09:14:00Z'});
 if(mode==='unrelated')mirrors[0].message_at='2026-09-07T07:00:00Z';
 const before=JSON.stringify({mirrors,outputs});
 const read=async rows=>a.readGuanianCloudHistory(async p=>Response.json(p.startsWith('push_chat_mirror')?mirrors:rows),'u','s');
 const h=await read(outputs),reverse=await read([...outputs].reverse());
 assert.deepEqual(Array.from(h.messages,m=>m.id),Array.from(reverse.messages,m=>m.id));
 if(mode==='unrelated'||mode==='modified'){assert.equal(h.uncertainLegacy.length,0);assert.equal(h.messages.length,2);}
 else{assert.equal(h.messages.length,outputs.length);assert.ok(h.uncertainLegacy.length);assert.equal(a.guanianHistoryRounds(h,at),outputs.length);const prompt=a.guanianHistoryText(h,480);assert.match(prompt,/不能当作新发言/);if(mode==='modified')assert.match(prompt,/到了（表情）/);else assert.equal(prompt.split('：到了').length-1,outputs.length);}
 assert.equal(JSON.stringify({mirrors,outputs}),before);
}
console.log('PASS A5 exact ambiguous copies cannot add fresh rounds; nonmatching edited/unrelated utterances remain factual');
for(const value of [null,undefined,'',true,false,'bad',900])assert.equal(a.guanianTimezone(value),null);
assert.equal(a.guanianTimezone(0),0);assert.equal(a.guanianTimezone('480'),480);
assert.equal(a.guanianContextTimezone({day:{tz:null},userSleepTz:0},at),null);
assert.equal(a.guanianContextTimezone({day:{tz:null},userSleepTimeZone:'Asia/Shanghai'},at),480);
assert.equal(a.guanianContextTimezone({userSleepTimeZone:'America/New_York'},at),-240);
assert.equal(a.guanianContextTimezone({userSleepTimeZone:'bad-zone'},at),null);
assert.equal(a.guanianContextTimezone({tzOffsetMin:840},at),840);
console.log('PASS B19 explicit UTC, IANA recovery, invalid/missing fields, and UTC+14 remain distinct');
for(const mode of ['context','zone','missing']){
 const {h,run}=recheckFixture();delete h.plan.context.day.tz;
 if(mode==='context')h.plan.context.tzOffsetMin=480;
 if(mode==='zone')h.plan.context.userSleepTimeZone='Asia/Shanghai';
 h.mirrors=[{id:'u',role:'user',content:'晚上我等你',message_at:new Date(h.now-60000).toISOString()}];
 const r=await run();
 if(mode==='missing'){assert.equal(r.status,503);assert.equal(h.calls.length,0);assert.equal(h.jobs.length,0);assert.match(h.plan.retry_error,/时区资料缺失/);}
 else{assert.equal(r.status,200);assert.equal(h.calls.length,1);assert.match(JSON.stringify(h.calls[0]),/20:00/);}
}
for(const mode of ['recover','missing']){
 const {h,init,run}=fixture();await init();delete h.plan.context.day.tz;h.plan.context.day.schedule=[];
 if(mode==='recover')h.plan.context.tzOffsetMin=480;
 await run();
 if(mode==='missing'){assert.equal(h.calls.length,0);assert.match(h.job.result_note,/时区资料缺失/);}
 else{assert.equal(h.calls.length,1);assert.match(JSON.stringify(h.calls[0]),/18:15/);}
}
console.log('PASS B19 real recheck/generator use recovered local time; unknown timezone schedules nothing and calls no model');
const gatewayCode=stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/ai-phone-push/index.ts',import.meta.url),'utf8'));
for(const value of [undefined,null,'',false,0,480,900]){
 let handler,saved;
 vm.runInNewContext(gatewayCode,{Date,console,Request,Response,URL,Headers,AbortSignal,
  Deno:{env:{get:key=>({SUPABASE_URL:'https://test',SUPABASE_SERVICE_ROLE_KEY:'test'})[key]},serve:f=>handler=f},
  fetch:async(url,init={})=>{if(url.includes('rpc/push_save_recheck_plan')){saved=JSON.parse(init.body).p_row;return Response.json({ok:true,stateVersion:1});}return Response.json([{context:{}}]);},
 });
 const r=await handler(new Request('https://test?action=recheck-plan',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({characterId:'c',sessionId:'s',planDate:'2026-09-07',context:{tzOffsetMin:value},items:[]})}));
 assert.equal(r.status,200);assert.equal(saved.context.tzOffsetMin,[0,480].includes(value)?value:null);
}
console.log('PASS B19 gateway preserves explicit offsets and never turns missing or invalid fields into UTC');
