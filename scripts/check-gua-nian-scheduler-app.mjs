import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../custom-apps/gua-nian/index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
const now = Date.parse('2026-09-07T16:00Z');
class Clock extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
function app() {
  const h = { rows: {}, chat: [], calls: 0, cancelled: [], cloud: false, result: { decisions: [], extra: [], keep: [], settle: [] } };
  const c = vm.createContext({ h, Date: Clock, console, URLSearchParams, AbortController, setTimeout, clearTimeout, AiPhone: {
    db: { list: async t => h.rows[t] || [], create: async (t, row) => { const r = { id: t, ...row }; (h.rows[t] ||= []).push(r); return r; },
      update: async (t, id, row) => Object.assign(h.rows[t].find(r => r.id === id), row) },
    push: { cancelWake: async id => h.cancelled.push(id), wake: async () => { throw Error('ordinary wake must not be created'); } },
  } });
  vm.runInContext(source.replace(/  init\(\);\s*\}\)\(\);\s*$/, `
    log=async()=>{};toast=()=>{};render=()=>{};renderCloudSync=()=>{};syncChatContext=async()=>{};owns=()=>true;
    cloudRecheckOn=()=>h.cloud;cloudFetch=async()=>({plan:h.remote});cloudFetchBounded=cloudFetch;
    readRecentChat=async()=>h.chat;generateJson=async()=>{h.calls++;return h.result;};uploadPlanCloud=async()=>({status:"synced"});
    globalThis.api={S,SET_DEF,ctxOf,todayStr,fmtHM,recheck,pullCloudDecisionsBody};
  })();`), c);
  const a = c.api; a.S.settings = { ...a.SET_DEF, recheckMin: 1, quota: 1, cloudRecheck: false, momentsOn: false, threadsOn: true, cloudUrl: 'https://test', cloudKey: 'test' };
  const cx = a.ctxOf({ id: 'c', name: '角色' }); cx.day = { date: a.todayStr(), schedule: [], energy: 70 };
  cx.plan = { id: 'p', characterId: 'c', date: a.todayStr(), plannedAt: now - 4*3600000, items: [] }; cx.threads = [];
  h.rows.plans = [cx.plan]; h.rows.settings = [a.S.settings]; h.rows.threads = [];
  return { a, h, cx };
}
{
  const { a, h, cx } = app(); h.chat = [{ role: 'assistant', t: now - 60000, c: '醒了吗' }];
  await a.recheck(cx, '打开'); assert.equal(h.calls, 0);
  h.chat = [{ role: 'assistant', t: now - 60000, c: '我三点半回家' }];
  h.result.extra = [{ time: a.fmtHM(now + 600000), intent: '重复追问' }];
  await a.recheck(cx, '打开'); assert.equal(h.calls, 1); assert.equal(cx.plan.items.length, 0);
  console.log('PASS actual app distinguishes assistant promise bookkeeping from ordinary impulse triggers');
}
{
  const { a, h, cx } = app(); a.S.settings.maxUnanswered = 2;
  h.chat = [{ role: 'user', t: now - 5*3600000, c: '好' }, { role: 'assistant', t: now - 2*3600000, c: '第一轮' }, { role: 'assistant', t: now - 3600000, c: '第二轮' }];
  cx.plan.items = [{ kind: 'extra', act: true, wakeId: 'ordinary', fireAt: now + 3600000 }, { kind: 'promise', act: true, wakeId: 'promise', fireAt: now + 7200000 }];
  await a.recheck(cx, '打开'); assert.equal(h.calls, 0); assert.equal(cx.plan.items[0].act, false); assert.equal(cx.plan.items[1].act, true);
  assert.deepEqual(h.cancelled, ['ordinary']); console.log('PASS assistant-only messages do not bypass local hard cooldown; promises survive');
}
{
  const { a, h, cx } = app(); h.cloud = true;
  cx.plan.cloudStateVersion = 1; cx.plan.cloudSlotKeys = ['old', 'removed'];
  cx.plan.items = [{ kind: 'extra', act: true, wakeId: 'old', source: '话题', time: '13:00', fireAt: now+3600000 }, { kind: 'extra', act: true, wakeId: 'removed', source: '另一个', fireAt: now+7200000 }];
  h.remote = { plan_date: a.todayStr(), state_version: 2, context: {}, decisions: [], items: [
    { kind: 'extra', act: true, wakeId: 'new', source: '话题', time: '14:00', origFireAt: now+3600000, fireAt: now+7200000 },
  ] };
  await a.pullCloudDecisionsBody(cx, true); assert.equal(cx.plan.items.filter(w => w.act).length, 1);
  assert.equal(cx.plan.items[0].wakeId, 'new'); assert.equal(cx.plan.cloudStateVersion, 2); assert.deepEqual(h.cancelled, ['old','removed']);
  await a.pullCloudDecisionsBody(cx, true); assert.deepEqual(h.cancelled, ['old','removed']);
  console.log('PASS app imports ordinary reschedule/deletion after acknowledgement without resurrecting old local wakes');
}
