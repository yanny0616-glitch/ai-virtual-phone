// 执行真实保存/停用函数，验证后端确认前不切换本机；不连接个人云。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const settings = await read('custom-apps/gua-nian/src/ui/settings.js');
const server = await read('custom-apps/gua-nian/src/cloud/server.js');
const save = settings.slice(settings.indexOf('  function hostWantsServer()'));
const forget = server.slice(server.indexOf('  async function serverForget('), server.indexOf('  // 手动操作'));

for (const outcome of ['confirmed', 'queued', 'network', 'unconfirmed']) {
  const calls = [], toasts = [];
  const cx = { character: { id: 'c1' } };
  const S = { settings: { serverBrain: true, serverUrl: 'old', cloudKey: 'old-key' }, order: ['c1'], cur: 'c1', byId: { c1: cx } };
  const ctx = vm.createContext({
    S, document: { querySelectorAll: () => [{ dataset: { id: 'c1' } }] },
    readSheet: () => ({}), hostCfg: () => ({ mode: 'cloud' }),
    validateUserSleepSettings() {},
    serverPath: () => '/app/characters/c1',
    serverFetch: async (_path, init) => {
      calls.push('disable');
      assert.equal(S.settings.serverBrain, true);
      assert.equal(JSON.parse(init.body).enabled, false);
      if (outcome === 'network') throw Error('offline');
      return outcome === 'queued' ? { queued: true } : { character: { enabled: outcome !== 'confirmed' } };
    },
    patchSettings: async fn => { calls.push('save'); Object.assign(S.settings, fn()); },
    settingsSaveEffects: () => [], renderSettingsEffects() {}, closeSheet() {},
    allCx: () => [cx], serverBrainOn: () => S.settings.serverBrain,
    cloudCfg: () => null, syncChatContext: async () => { calls.push('local'); },
    syncUsageCloud: async () => {}, render() {}, toast: text => toasts.push(text),
    setTimeout: () => { calls.push('reload'); },
  });
  vm.runInContext(forget + '\n' + save, ctx);
  await ctx.saveSettings();
  if (outcome === 'confirmed') {
    assert.deepEqual(calls, ['disable', 'save', 'local', 'reload']);
    assert.equal(S.settings.serverBrain, false);
  } else {
    assert.deepEqual(calls, ['disable']);
    assert.equal(S.settings.serverBrain, true);
    assert.match(toasts[0], /设置未保存/);
  }
}
console.log('VPS 停用切换：成功、排队、断网、未确认 4 个场景通过');

const handoff = server.slice(server.indexOf('  async function serverHandoff('), server.indexOf('  async function serverForget('));
for (const outcome of ['confirmed', 'queued', 'network', 'unconfirmed']) {
  const calls=[],toasts=[];
  const cx={character:{id:'c1',name:'test'}};
  const S={settings:{serverBrain:false,cloudRecheck:true,cloudGen:false},order:['c1'],cur:'c1',byId:{c1:cx}};
  const ctx=vm.createContext({
    S,document:{querySelectorAll:()=>[{dataset:{id:'c1'}}]},readSheet:()=>({cloudRecheck:true,cloudGen:false}),hostCfg:()=>({mode:'server'}),validateUserSleepSettings(){},
    myDev:()=> 'device', serverPath:(_cx,tail)=>'/app/characters/c1'+tail,
    serverFetch:async(path,init)=>{
      calls.push('handoff'); assert.equal(S.settings.serverBrain,false);
      assert.equal(path,'/app/characters/c1/handoff');assert.equal(JSON.parse(init.body).owner,'device');
      if(outcome === 'network') throw Error('offline'); return outcome === 'queued' ? {queued:true} : {stopped:outcome === 'confirmed'};
    },
    patchSettings:async fn=>{calls.push('save');Object.assign(S.settings,fn());},settingsSaveEffects:()=>[],renderSettingsEffects(){},closeSheet(){},
    allCx:()=>[cx],serverBrainOn:()=>S.settings.serverBrain,cloudCfg:()=>({url:'cloud'}),
    freezeServerTemplates:async()=>calls.push('freeze'),generationStopState:()=>null,
    serverEnsure:async()=>calls.push('enable'),serverPull:async()=>{},syncUsageCloud:async()=>{},render(){},toast:msg=>toasts.push(msg),setTimeout(){},
  });
  vm.runInContext(handoff+'\n'+save,ctx);await ctx.saveSettings();
  if(outcome === 'confirmed') {
    assert.deepEqual(calls,['handoff','save','freeze','enable']);assert.equal(S.settings.cloudRecheck,false);assert.equal(S.settings.cloudGen,false);
  } else {
    assert.deepEqual(calls,['handoff']);assert.equal(S.settings.serverBrain,false);assert.match(toasts[0],/设置未保存/);
  }
}
console.log('VPS 启用交接：跟随小手机离线执行位置，确认旧调度停止后才保存/启用，失败路径通过');

// 运行真实本地定时发送入口的保护段：VPS 接管后不发消息，也不删云端凭据。
const ownership = (await read('lib/guanian-wake-ownership.ts')).replace(/^import .*;\n/m, '').replace('export ', '').replace('schedule: { id: string }', 'schedule');
const follow = await read('lib/follow-up-service.ts');
const guard = follow.slice(follow.indexOf('async function fireTimedWake('),follow.indexOf('    // 本地接手触发：撤销服务端兜底预约'))
  .replace('sched: TimedWakeSchedule','sched') + '\nreturn "legacy";\n}';
for (const owned of [true,false]) {
  const removed=[];const firing=new Set();
  const ctx=vm.createContext({timedWakeFiringSet:firing,removeTimedWakeSchedule:id=>removed.push(id),
    loadInstalledCustomApps:()=>[{id:'app_gua.nian_01',manifest:{id:'gua.nian'}}],readCustomAppCollection:()=>[{serverBrain:owned}]});
  vm.runInContext(stripTypeScriptTypes(ownership + "\n" + guard),ctx);
  const id='timed_wake_capp_app_gua.nian_01_123_x';
  const result=await ctx.fireTimedWake({id});assert.equal(result,owned?undefined:'legacy');assert.deepEqual(removed,[id]);
}
console.log('旧本地定时发送：VPS 模式让位，非 VPS 模式保留原路径');

// 小手机改了离线执行位置：挂念按保存流程交接；位置一致不动，失败 5 分钟内不重试。
{
  const follow = settings.slice(settings.indexOf('  async function followHostMode()'), settings.indexOf('  async function applySettings('));
  const applied = [];
  const S = { host: { mode: 'server' }, settings: { serverBrain: false, quota: 3, cloudRecheck: true }, order: ['c1'] };
  const ctx = vm.createContext({
    S, Date, toast() {}, allCx: () => [{}], serverBrainOn: () => S.settings.serverBrain,
    hostWantsServer: () => S.host.mode === 'server',
    SET_FIELDS: () => [{ type: 'stepper', key: 'quota' }, { type: 'toggles', items: [{ key: 'cloudRecheck' }] }, { type: 'hostOffline' }],
    applySettings: async (ids, sheet) => { applied.push({ ids, sheet: { ...sheet } }); },
  });
  vm.runInContext(follow, ctx);
  assert.equal(await ctx.followHostMode(), false);
  assert.deepEqual(applied, [{ ids: ['c1'], sheet: { quota: 3, cloudRecheck: true, serverBrain: true } }]);
  assert.equal(await ctx.followHostMode(), false); // 交接失败，5 分钟内不再试
  assert.equal(applied.length, 1);
  S.host.mode = 'cloud'; S._followAt = 0;
  assert.equal(await ctx.followHostMode(), false); // 位置一致
  assert.equal(applied.length, 1);
}
console.log('跟随小手机离线执行：不一致才交接，失败不刷屏重试');
