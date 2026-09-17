// 真正执行定时快照刷新和挂单函数，只替换存储/模型组装/网络边界。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const read = file => readFile(new URL('../'+file,import.meta.url),'utf8');
const source=await read('lib/push-bailout-client.ts');
const arm=source.slice(source.indexOf('export async function armTimedWakeBailout('),source.indexOf('export const TEMPLATE_BAILOUT_TTL_MS'));
const refresh=source.slice(source.indexOf('export async function refreshScheduledBailouts('),source.indexOf('/** 安装刷新钩子：'));
const ownership=(await read('lib/guanian-wake-ownership.ts')).replace(/^import .*;\n/m,'');
for(const scenario of ['server','switch-during-build','local','other-app']) {
  let serverBrain=scenario==='server'||scenario==='other-app';
  const id=`timed_wake_capp_${scenario==='other-app'?'app_other':'app_gua.nian_01'}_123_x`;
  const schedules=[{id,characterId:'c1',sessionId:'s1',fireAt:Date.now()+3600000,source:'tool',intent:'问候'}];
  const writes=[],removed=[];let builds=0;
  const noop=()=>{};
  const ctx=vm.createContext({console,Date,refreshingScheduled:false,
    bailoutEnabled:()=>true,isGuanianTemplateWake:()=>false,hasAccountPushSubscription:async()=>true,isWithinPushQuietHours:()=>false,
    loadInstalledCustomApps:()=>[{id:'app_gua.nian_01',manifest:{id:'gua.nian'}}],readCustomAppCollection:()=>[{serverBrain}],
    loadTimedWakeSchedules:()=>schedules.slice(),removeTimedWakeSchedule:key=>{removed.push(key);schedules.splice(schedules.findIndex(s=>s.id===key),1);},
    loadChatSessions:()=>[{id:'s1',contactId:'c1'}],loadChatMessages:()=>[],resolveTimedWakeElapsedMinutes:()=>1,
    loadIdleReconnectRules:()=>[],armPeriodCareBailouts:async()=>{},
    buildChatPromptMessages:async()=>{builds++;if(scenario==='switch-during-build')serverBrain=true;return{llmMessages:[],character:{id:'c1',name:'测试'},config:{},preset:{},regexes:[]};},
    maybeAppendCallInvite:noop,maybeAppendShortcutCapability:noop,maybeAppendWeixinChannel:noop,buildOfflineShortcutContinuation:noop,
    toLlmRequestMessages:x=>x,buildProviderRequest:()=>({url:'https://model.invalid',body:{},headers:{},providerKind:'anthropic'}),
    postBailoutJob:async x=>{writes.push(x.triggerKey);return true;}
  });
  vm.runInContext(stripTypeScriptTypes((ownership+arm+refresh).replaceAll('export ','')),ctx);
  await ctx.refreshScheduledBailouts();
  if(scenario==='server'||scenario==='switch-during-build') {
    assert.equal(writes.length,0);assert.deepEqual(removed,[id]);assert.equal(builds,scenario==='server'?0:1);
    // 接管时退休的本地登记不会在切回本机后复活。
    serverBrain=false;await ctx.refreshScheduledBailouts();assert.equal(writes.length,0);
  } else {assert.deepEqual(writes,['timedwake:'+id]);assert.equal(removed.length,0);}
}
console.log('PASS VPS 挂念不重挂、组装中切换不重挂、退休登记不复活、本机与其他 APP 不受影响');
