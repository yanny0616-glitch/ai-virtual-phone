import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { recheckFixture } from './lib/gua-nian-recheck-fixture.mjs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

function app() {
  const h = { calls: [], result: { id: 'new', armed: true }, upload: 'synced' };
  const cx = { character: { id:'c' }, plan: {date:'2026-09-09', items:[]} };
  const S = { settings: { cloudRecheck:true, sentinels:{c:{wakeId:'old',armed:true}} } };
  const c = vm.createContext({ console, S, Date, Set, Promise,
    cloudCfg:()=>({url:'https://test'}), cloudRecheckOn:()=>true, todayStr:()=>cx.plan.date,
    patchSettings:async fn=>{ if(h.saveFails)throw Error('local write failed'); S.settings={...S.settings,...fn(S.settings)}; },
    renderCloudSync(){}, log:async()=>{}, toast(){}, render(){}, owns:()=>true,
    pullCloudDecisionsBody:async()=>{h.calls.push('read');},
    cloudFetchBounded:async(action)=>{h.calls.push(action);return {ok:true};},
    AiPhone:{push:{wake:async()=>{h.calls.push('arm');return h.result;},cancelWake:async id=>h.calls.push('cancel:'+id),listWakes:async()=>[]}},
    timeToMs:()=>0,
  });
  vm.runInContext(read('custom-apps/gua-nian/src/planning/wakes.js') + read('custom-apps/gua-nian/src/cloud/plans.js')
    + '\n globalThis.api={armSentinel,retryPlanSync,cancelTodayWakes};', c);
  c.uploadResult = async()=>{ h.calls.push('upload'); return {status:h.upload}; };
  vm.runInContext('uploadPlanCloud=globalThis.uploadResult;',c);
  return {h,c,cx,S,a:c.api};
}
{
  const {h,cx,S,a}=app(); h.result={id:'unarmed',armed:false,reason:'no confirmation'};
  await assert.rejects(()=>a.armSentinel(cx),/no confirmation/);
  assert.equal(S.settings.sentinels.c.wakeId,'old'); assert.deepEqual(h.calls,['arm']);
  assert.equal(cx._planSync.status,'failed');
  console.log('PASS failed registration retains old template and exposes failure');
}
{
  const {h,cx,S,a}=app();h.saveFails=true;
  await assert.rejects(()=>a.armSentinel(cx),/local write failed/);
  assert.equal(S.settings.sentinels.c.wakeId,'old'); assert.deepEqual(h.calls,['arm']);
  console.log('PASS local persistence failure never deletes old cloud template');
}
{
  const {h,cx,S,a}=app();await a.armSentinel(cx);
  assert.equal(S.settings.sentinels.c.wakeId,'new');assert.equal(S.settings.sentinels.c.previousWakeIds[0],'old');
  assert.deepEqual(h.calls,['arm']);
  console.log('PASS confirmed new template replaces reference while retaining historical template');
}
for(const status of ['synced','failed']) {
  const {h,cx,a}=app();h.upload=status;await a.retryPlanSync(cx);
  assert.deepEqual(h.calls,status==='synced'?['read','arm','upload','scheduler-retry']:['read','arm','upload']);
  assert.equal(cx._planLock,false);assert.equal(cx._syncRetrying,false);
  console.log('PASS recovery only resumes after template creation and confirmed plan upload: '+status);
}
{
  const {h,cx,a}=app();h.result={armed:false,reason:'offline'};await a.retryPlanSync(cx);
  assert.deepEqual(h.calls,['read','arm']);assert.equal(cx._planSync.status,'failed');
  console.log('PASS failed template repair does not resume stopped worker');
}
{
  const {h,c,cx,a}=app();c.cloudCfg=()=>null;await a.armSentinel(cx);assert.equal(h.calls.length,0);
  console.log('PASS local-only planning does not require cloud templates');
}
{
  const {h,c,cx,S,a}=app();S.settings.sentinels.c.previousWakeIds=['older'];cx._session='s';
  c.cloudFetch=async()=>({jobs:['old','older','timed_wake_capp_app_gua.nian_test_sentinel_123_abc','regular'].map(id=>({status:'pending',sessionId:'s',triggerKey:'timedwake:'+ (id==='old'||id==='older'||id==='regular'?'timed_wake_capp_'+id:id)}))});
  S.settings.sentinels.c.wakeId='timed_wake_capp_old';S.settings.sentinels.c.previousWakeIds=['timed_wake_capp_older'];
  await a.cancelTodayWakes(cx);
  assert.deepEqual(h.calls,['cancel:timed_wake_capp_regular']);
  console.log('PASS ordinary replanning preserves current and historical templates');
}

// Actual host bailout function; only provider construction/network are faked.
const code=read('lib/push-bailout-client.ts');
const arm=stripTypeScriptTypes(code.slice(code.indexOf('export async function armTimedWakeBailout('),code.indexOf('export const TEMPLATE_BAILOUT_TTL_MS'))).replace(/^export /gm,'');
const storage=stripTypeScriptTypes(read('lib/timed-wake-storage.ts')).replace(/^import.*;$/gm,'').replace(/^export /gm,'');
let posted=0, subscriptionReads=0;
const host=vm.createContext({console,Date,registerKvMigration(){},bailoutEnabled:()=>true,
  hasAccountPushSubscription:async()=>{subscriptionReads++;return false;}, isWithinPushQuietHours:()=>true,
  loadChatSessions:()=>[{id:'s',contactId:'c'}],loadChatMessages:()=>[],resolveTimedWakeElapsedMinutes:()=>1,
  buildChatPromptMessages:async()=>({llmMessages:[],character:{id:'c',name:'角色'},config:{},preset:{},regexes:[]}),
  maybeAppendCallInvite(){},maybeAppendShortcutCapability(){},maybeAppendWeixinChannel(){},
  buildProviderRequest:()=>({url:'https://model.test',headers:{},body:{},providerKind:'openai-compatible'}),toLlmRequestMessages:x=>x,
  buildOfflineShortcutContinuation:()=>null,postBailoutJob:async()=>{posted++;return true;},
});
vm.runInContext(storage+arm+';globalThis.arm=armTimedWakeBailout;',host);
const sched={id:'timed_wake_capp_app_gua.nian_test_sentinel_123_abc',intent:'后台模板',sessionId:'s',characterId:'c',fireAt:Date.now()+100000};
assert.equal((await host.arm(sched)).ok,true);assert.equal(posted,1);assert.equal(subscriptionReads,0);
assert.equal((await host.arm({...sched,id:'ordinary'})).ok,false);
host.hasAccountPushSubscription=async()=>true;
assert.match((await host.arm({...sched,id:'ordinary'})).reason,/安静时段/);
console.log('PASS template registration bypasses notification/quiet gates; ordinary messages still obey them');

for(const [flag,expect] of [['noTemplate',/预约记录不存在/],['templateReadFails',/读取失败：HTTP 503/],['templateDecryptFails',/解密失败/]]) {
  const {h,run}=recheckFixture();h[flag]=true;
  h.mirrors=[{id:'m',role:'user',content:'今晚再问问我',message_at:new Date(h.now-60000).toISOString()}];
  await run();assert.equal(h.calls.length,0);assert.match(h.plan.retry_error,expect);
  console.log('PASS worker distinguishes template failure: '+flag);
}
{
  const {h,run}=recheckFixture();Object.assign(h.plan.context,{selfImpulseCap:3,selfSilenceMin:30,impulseMode:1,echoOn:0,quota:4});
  h.mirrors=[{id:'old-user',role:'user',content:'晚点再聊',message_at:new Date(h.now-4*3600000).toISOString()}];
  await run();assert.equal(h.calls.length,1);assert.equal(h.plan.context.selfUsed,1);
  assert.ok(h.plan.decisions.some(d=>d.kind==='self'&&/没有新增念头/.test(d.note)));
  assert.equal(h.jobs.length,0);
  console.log('PASS empty self-judgement is recorded without fabricating a message');
}
