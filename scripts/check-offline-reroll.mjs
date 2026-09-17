// 线下「重试以下」回复版本的纯逻辑检查（剥类型后在沙箱里跑，kv 用内存代替）
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const kv = new Map();
const src = fs.readFileSync(new URL('../lib/chat-offline-reroll.ts', import.meta.url), 'utf8');
const ctx = vm.createContext({ kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => kv.set(k, v) });
vm.runInContext(stripTypeScriptTypes(src).replace(/^import .*$/gm, '').replace(/^export /gm, '')
  + '\nglobalThis.api={getLiveOfflineReplyVersions,recordOfflineReplyVersionBeforeRetry,describeOfflineReplyVersions,switchOfflineReplyVersion};', ctx);
const api = ctx.api;
const plain = v => JSON.parse(JSON.stringify(v));
const turn = (n, text, summary = '摘要' + n) => ({ id: String(n), sessionId: 's', userContent: 'u' + n, assistantContent: text, summary, summaryTag: 'summary', createdAt: `2026-09-17T10:0${n}:00.000Z` });
const S = 's';

// 重试最后一轮：旧版存下，新版成功后可以换回去，摘要跟着换
let turns = [turn(1, 'A'), turn(2, 'B')];
let rec = api.recordOfflineReplyVersionBeforeRetry(S, turns, 1);
const v2 = turn(3, 'B2', '新摘要');
rec.finish(v2);
turns = [turns[0], v2];
let live = api.getLiveOfflineReplyVersions(S, turns);
assert.ok(live, 'versions live after retry');
assert.deepEqual(plain(api.describeOfflineReplyVersions(live).map(v => [v.lines, v.active])), [[['B'], false], [['B2'], true]]);
turns = api.switchOfflineReplyVersion(S, turns, 0);
assert.deepEqual(plain(turns.map(t => [t.id, t.summary])), [['1', '摘要1'], ['2', '摘要2']], 'old turn and its summary restored');
live = api.getLiveOfflineReplyVersions(S, turns);
assert.equal(live.set.active, 0);
turns = api.switchOfflineReplyVersion(S, turns, 1);
assert.deepEqual(plain(turns.map(t => t.id)), ['1', '3']);
console.log('PASS retry keeps old version, switching swaps turn and summary');

// 再重试一次：同一锚点累加成三版
rec = api.recordOfflineReplyVersionBeforeRetry(S, turns, 1);
const v3 = turn(4, 'B3');
rec.finish(v3);
turns = [turns[0], v3];
assert.equal(api.getLiveOfflineReplyVersions(S, turns).set.versions.length, 3);
// 又聊了一轮：版本作废
assert.equal(api.getLiveOfflineReplyVersions(S, [...turns, turn(5, 'C')]), null, 'new turn clears versions');
console.log('PASS repeated retries accumulate; a new turn invalidates versions');

// 从中间重试：后面的轮次整截存成一版
kv.clear();
turns = [turn(1, 'A'), turn(2, 'B'), turn(3, 'C')];
rec = api.recordOfflineReplyVersionBeforeRetry(S, turns, 1);
const mid = turn(4, 'B2');
rec.finish(mid);
turns = api.switchOfflineReplyVersion(S, [turns[0], mid], 0);
assert.deepEqual(plain(turns.map(t => t.id)), ['1', '2', '3'], 'whole removed tail comes back');
console.log('PASS mid retry restores the whole tail');

// 失败回滚：版本记录恢复原样
kv.clear();
turns = [turn(1, 'A'), turn(2, 'B')];
rec = api.recordOfflineReplyVersionBeforeRetry(S, turns, 1);
rec.rollback();
assert.equal(api.getLiveOfflineReplyVersions(S, turns), null);
assert.equal(kv.get('ai_phone_chat_offline_reply_versions_v1'), '{}');
console.log('PASS failed retry rolls version record back');
