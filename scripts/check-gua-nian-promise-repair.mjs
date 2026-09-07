import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { promiseNeedsTask, updatePromiseThreads } from '../custom-apps/gua-nian/src/domain/promises.mjs';
import { fixture } from './lib/gua-nian-worker-fixture.mjs';
import { stripTypeScriptTypes } from 'node:module';

const now = Date.parse('2026-09-07T14:00:00Z');
class Clock extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
const html = fs.readFileSync(new URL('../custom-apps/gua-nian/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
const host = fs.readFileSync(new URL('../lib/custom-app-host-api.ts', import.meta.url), 'utf8');
const minimum = Number(host.match(/CUSTOM_APP_TIMED_WAKE_MIN_DELAY_MS = ([\d_]+)/)[1].replaceAll('_', ''));
function app() {
  const h = { cloud: false, wakes: [], cancelled: [], rows: {}, logs: [] };
  const c = vm.createContext({ console, Date: Clock, URLSearchParams, AbortController, setTimeout, clearTimeout, h, AiPhone: {
    chat: { readHistory: async () => ({ sessionId: h.missingSession ? '' : 'real-session', messages: [] }) },
    push: {
      wake: async request => {
        assert.ok(request.fireAt >= Clock.now() + minimum, 'must satisfy the real host minimum');
        if (h.wakeFails) throw Error('offline');
        h.wakes.push(request); return { id: 'local-' + h.wakes.length, armed: false };
      },
      cancelWake: async id => { if (h.cancelFails) throw Error('cancel unavailable'); h.cancelled.push(id); },
    },
    db: {
      list: async table => h.rows[table] || [],
      create: async (table, row) => { const value = { id: table, ...row }; (h.rows[table] ||= []).push(value); return value; },
      update: async (table, id, row) => Object.assign(h.rows[table].find(r => r.id === id), row),
    },
  } });
  vm.runInContext(html.replace(/  init\(\);\s*\}\)\(\);\s*$/, `
    cloudRecheckOn=()=>h.cloud; cloudFetch=async()=>{if(h.readFails) throw Error('read unavailable');return {plan:h.plan};}; consumeOutbox=async()=>{};
    log=async(cx,message)=>h.logs.push(message);
    toast=message=>h.logs.push(message); render=()=>{}; syncChatContext=async()=>{};
    uploadPlanCloud=async(cx)=>{h.uploaded=JSON.parse(JSON.stringify(cx.plan));return {status:'synced'};};
    globalThis.api={S,ctxOf,syncPromiseTasks,cloudSessionId,pullCloudDecisionsBody,todayStr,editThreadLedger};
  })();`), c);
  c.api.S.settings = { threadsOn: true, threadDays: 3 };
  const cx = c.api.ctxOf({ id: 'c' });
  cx.plan = { items: [] };
  cx.threads = [{ id: 'p1', kind: 'promise', text: '回家', due: now - 600000, revision: 1, at: now - 60000, done: false }];
  return { h, api: c.api, cx };
}

{
  const { h, api, cx } = app();
  assert.equal(await api.cloudSessionId(cx), 'real-session');
  assert.equal(cx._session, 'real-session');
  h.missingSession = true;
  await assert.rejects(api.cloudSessionId(cx), /会话/);
  const planSource = fs.readFileSync(new URL('../custom-apps/gua-nian/src/cloud/plans.js', import.meta.url), 'utf8');
  const kitSource = fs.readFileSync(new URL('../custom-apps/gua-nian/src/cloud/day.js', import.meta.url), 'utf8');
  for (const source of [planSource, kitSource]) assert.match(source, /sessionId: await cloudSessionId\(cx\)/);
  console.log('PASS B1 当前计划和明日原料上传真实会话；缺会话显式失败');
}
{
  const { h, api, cx } = app();
  await api.syncPromiseTasks(cx, cx.plan.items, now);
  assert.equal(h.wakes.length, 1); assert.equal(cx.plan.items.length, 1);
  assert.equal(cx.plan.items[0].origFireAt, now - 600000);
  h.wakeFails = true;
  cx.threads.push({ ...cx.threads[0], id: 'p2' });
  await api.syncPromiseTasks(cx, cx.plan.items, now);
  assert.equal(cx.plan.items.length, 1); assert.ok(h.logs.some(l => l.includes('下次复核重试')));
  h.wakeFails = false;
  await api.syncPromiseTasks(cx, cx.plan.items, now);
  assert.equal(cx.plan.items.length, 2);
  console.log('PASS B4 过点预约满足宿主下限；失败不丢已有项，下一轮可重试');
}
{
  const { h, api, cx } = app(); h.cloud = true;
  await api.syncPromiseTasks(cx, cx.plan.items, now);
  assert.equal(h.wakes.length, 0);
  console.log('PASS B3 云端复核开启时手机不创建第二套约定任务');
}
{
  const { h, api, cx } = app(); h.cloud = true;
  const old = { kind: 'promise', from: 'p1', promiseRevision: 1, wakeId: 'local-old', act: true, fireAt: now + 3600000 };
  cx.plan.items = [old];
  h.plan = { plan_date: api.todayStr(), context: { threads: [{ ...cx.threads[0], revision: 2, at: now, due: now + 7200000 }] },
    items: [{ ...old, act: false }, { ...old, promiseRevision: 2, wakeId: 'cloud-new', fireAt: now + 7200000 }], decisions: [] };
  h.cancelFails = true;
  await assert.rejects(api.pullCloudDecisionsBody(cx), /cancel unavailable/);
  assert.equal(cx.plan.items[0].wakeId, 'local-old'); assert.equal(cx.plan.items[0].act, true);
  h.cancelFails = false;
  await api.pullCloudDecisionsBody(cx);
  assert.deepEqual(h.cancelled, ['local-old']);
  assert.equal(cx.plan.items.filter(w => w.act).length, 1);
  assert.equal(cx.plan.items.find(w => w.act).wakeId, 'cloud-new');
  await api.pullCloudDecisionsBody(cx);
  assert.equal(h.cancelled.length, 1);
  console.log('PASS B8 导入改期撤旧留新；取消失败保留原 ID，重复同步恢复且不重复撤销');
}
{
  const mentioned = { id: 'p1', kind: 'promise', text: '回家', due: now - 3600000, revision: 1, mentionedAt: now - 3600000, done: false };
  assert.equal(promiseNeedsTask(mentioned, [], now, now + 86400000), false);
  const [changed] = updatePromiseThreads([mentioned], [{ id: 'p1', due: now + 3600000 }], now, 'app');
  assert.equal(changed.revision, 2); assert.equal(promiseNeedsTask(changed, [], now, now + 86400000), true);
  console.log('PASS B6 已交代的同版本跨天不重挂，明确改期才重新预约');
}
{
  const { h, api, cx } = app(); h.cloud = true;
  h.plan = { plan_date: api.todayStr(), context: { threads: [{ ...cx.threads[0], revision: 2, at: now }] }, items: [], decisions: [] };
  h.readFails = true; let edits = 0;
  await api.editThreadLedger(cx, async () => { edits++; });
  assert.equal(edits, 0); assert.equal(h.uploaded, undefined); assert.equal(cx._planLock, false);
  assert.ok(h.logs.some(l => l.includes('read unavailable')));
  h.readFails = false;
  await api.editThreadLedger(cx, async () => { edits++; assert.equal(cx.threads[0].revision, 2); assert.equal(cx._planLock, true); });
  assert.equal(edits, 1); assert.ok(h.uploaded); assert.equal(cx._planLock, false);
  console.log('PASS 手动账本先读取当前版本再修改；读取失败不编辑、不上传并释放锁');
}
{
  for (const mode of ['missing-item', 'already-generated']) {
    const { h, c, init, run } = fixture(); await init();
    h.plan.context.day.schedule = [];
    h.plan.context.threads = [{ id: 'p1', kind: 'promise', revision: 1, due: h.now, done: false }];
    Object.assign(h.plan.items[0], { kind: 'promise', from: 'p1', promiseRevision: 1 });
    h.job.payload = await c.api.encryptPayload(JSON.stringify({
      request: { url: 'https://model.test', headers: {}, body: { messages: [] }, providerKind: 'openai-compatible' },
      notify: { characterId: 'c', title: '角色' }, merge: { sessionId: 's', guanianPromise: { id: 'p1', revision: 1 } },
    }), 'test-key');
    if (mode === 'missing-item') h.plan.items = [];
    else h.outbox.push({ id: 'already', job_id: 'other-job', raw_text: '到了', created_at: new Date(h.now - 60000).toISOString(), meta: { pushGenerated: true, guanianContext: { eventId: 'p1', revision: 1 } } });
    await run(); assert.equal(h.calls.length, 0); assert.match(h.job.result_note, /promise skip/);
  }
  console.log('PASS B3 孤儿约定不能冒充普通起念；同事件同版本已有输出不再次成文');
}
{
  const code = stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/ai-phone-push/index.ts', import.meta.url), 'utf8'));
  for (const ready of [false, true]) {
    let handler; const writes = [];
    vm.runInNewContext(code, {
      Date: Clock, console, Response, Request, URL, Headers, AbortSignal,
      Deno: { env: { get: key => ({ SUPABASE_URL: 'https://cloud.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test' })[key] }, serve: f => { handler = f; } },
      fetch: async (url, init) => {
        if (url.includes('rpc/push_promise_storage_ready')) return ready ? Response.json(true) : new Response('', { status: 404 });
        if (url.includes('rpc/push_save_recheck_plan')) { writes.push(JSON.parse(init.body).p_row); return Response.json({ok:true,stateVersion:1}); }
        return Response.json([]);
      },
    });
    const result = await handler(new Request('https://cloud.invalid?action=recheck-plan', {
      method: 'POST', headers: { 'x-ai-phone-service-key': 'test' }, body: JSON.stringify({
        characterId: 'c', planDate: '2026-09-07', sessionId: 'real-session', resetDecisions: true,
        context: { threads: [{ id: 'p1', kind: 'promise', text: '回家', due: now + 3600000, revision: 1 }] }, items: [],
      }),
    }));
    assert.equal(result.status, ready ? 200 : 409);
    assert.equal(writes.length, ready ? 1 : 0);
    if (ready) assert.equal(writes[0].session_id, 'real-session');
  }
  console.log('PASS 约定迁移缺失时保存前拒绝，无半保存；迁移齐全后保留真实会话');
}
