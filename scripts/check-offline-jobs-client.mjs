// 离线任务分流：同一条任务只挂一边。先撤另一边、确认后才挂；另一边正在生成就不挂；撤销两边都发。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const src = stripTypeScriptTypes(await readFile(new URL('../lib/offline-jobs-client.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

function setup(mode, { used = false, cloudDeleteOk = true, serverRunning = 0, serverPostStatus = 200 } = {}) {
  const calls = [], kv = new Map(used ? [['offline_jobs_server_used_v1', '1']] : []);
  const ctx = vm.createContext({
    Response, JSON, Promise, String, Number, Set, AbortSignal,
    kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => kv.set(k, v), registerKvMigration() {},
    loadOfflineExecutorConfig: () => ({ mode, serverUrl: '' }),
    companionServerUrl: () => 'https://srv', personalCloudCredentials: () => ({ url: 'https://c', key: 'k' }),
    pushJobsFetch: async init => { calls.push(['cloud', init.method, JSON.parse(init.body || '{}')]); return new Response('{}', { status: init.method === 'DELETE' && !cloudDeleteOk ? 500 : 200 }); },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(['server', url.replace('https://srv/app/jobs', '') || '/', body]);
      if (url.endsWith('/cancel')) return Response.json({ ok: true, deleted: 0, running: serverRunning });
      return new Response('{}', { status: serverPostStatus });
    },
  });
  vm.runInContext(src, ctx);
  return { ctx, calls, kv };
}
const post = (triggerKey, kind = 'timed_task') => ({ method: 'POST', body: JSON.stringify({ triggerKey, kind, executeAt: '2026-09-17T00:00:00Z', payload: {} }) });

{ // 后端模式：先撤云端再挂后端
  const e = setup('server');
  assert.equal((await e.ctx.offlineJobsFetch(post('idle:r:0'))).ok, true);
  assert.deepEqual(e.calls.map(c => c.slice(0, 2)), [['cloud', 'DELETE'], ['server', '/']]);
  assert.equal(e.calls[0][2].triggerKey, 'idle:r:0');
  assert.equal(e.kv.get('offline_jobs_server_used_v1'), '1');
}
{ // 云端撤不掉：不挂后端
  const e = setup('server', { cloudDeleteOk: false });
  assert.equal((await e.ctx.offlineJobsFetch(post('idle:r:0'))).ok, false);
  assert.deepEqual(e.calls.map(c => c[0]), ['cloud']);
}
{ // 后端同名正在生成：不算失败
  const e = setup('server', { serverPostStatus: 409 });
  assert.equal((await e.ctx.offlineJobsFetch(post('reply:s', 'reply_bailout'))).ok, true);
}
{ // 云端模式、用过后端：先撤后端；后端正在生成就不挂云端
  const e = setup('cloud', { used: true, serverRunning: 1 });
  assert.equal((await e.ctx.offlineJobsFetch(post('followup:s:1', 'followup'))).ok, true);
  assert.deepEqual(e.calls.map(c => c.slice(0, 2)), [['server', '/cancel']]);
  const f = setup('cloud', { used: true });
  await f.ctx.offlineJobsFetch(post('followup:s:1', 'followup'));
  assert.deepEqual(f.calls.map(c => c.slice(0, 2)), [['server', '/cancel'], ['cloud', 'POST']]);
}
{ // 从没用过后端：原样走云端，不打扰后端
  const e = setup('cloud');
  await e.ctx.offlineJobsFetch(post('idle:r:0'));
  await e.ctx.offlineJobsFetch({ method: 'DELETE', body: JSON.stringify({ triggerPrefix: 'idle:r:' }) });
  assert.deepEqual(e.calls.map(c => c[0]), ['cloud', 'cloud']);
}
{ // 模板、挂念旧预约、快捷续跑：永远走云端
  const e = setup('server');
  await e.ctx.offlineJobsFetch(post('guanian:tpl', 'template'));
  await e.ctx.offlineJobsFetch(post('timedwake:timed_wake_capp_app_gua.nian_01_1_x'));
  await e.ctx.offlineJobsFetch(post('shortcut:cmd', 'shortcut_resume'));
  assert.deepEqual(e.calls.map(c => c.slice(0, 2)), [['cloud', 'POST'], ['cloud', 'POST'], ['cloud', 'POST']]);
}
{ // 撤销、心跳两边都发
  const e = setup('server');
  await e.ctx.offlineJobsFetch({ method: 'DELETE', body: JSON.stringify({ triggerPrefix: 'idle:r:', excludeKey: 'idle:r:1' }) });
  await e.ctx.offlineJobsFetch({ method: 'PATCH', body: JSON.stringify({ triggerKey: 'reply:s' }) });
  // 两边并发发出，不比较先后
  assert.deepEqual(e.calls.map(c => c.slice(0, 2).join(' ')).sort(), ['cloud DELETE', 'cloud PATCH', 'server /cancel', 'server /delay']);
  assert.deepEqual(e.calls.find(c => c[1] === '/cancel')[2], { triggerPrefix: 'idle:r:', excludeKey: 'idle:r:1' });
}
console.log('离线任务分流：先撤后挂、另一边在跑不挂、撤销心跳两边发、模板与挂念旧预约留云端 全部通过');
