import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const src = fs.readFileSync(new URL('../lib/memory-recall.ts', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(src).replace(/^export /gm, '') + '\nglobalThis.api={rankMemoriesByRelevance,describeMemoryTime,tokenizeForRecall,mergeRecallContext};', ctx);
const { rankMemoriesByRelevance, describeMemoryTime, mergeRecallContext } = ctx.api;

const now = new Date(2026, 8, 15, 12).getTime();
const day = 86_400_000;
const mem = (id, content, daysAgo, extra = {}) => ({ id, content, importance: 0.8, time: now - daysAgo * day, ...extra });
const ids = hits => Array.from(hits, h => h.id);

const pool = [
  mem('cat', '用户说家里新养了一只橘猫，取名叫年糕，常常半夜踩人', 20),
  mem('job', '用户提到自己在准备教师资格证面试，下周三要去试讲', 5),
  mem('trip', '用户和角色约好国庆一起去杭州看西湖，用户负责订酒店', 12),
  mem('food', '用户不吃香菜，喜欢重辣的火锅，最近在减少奶茶', 40),
  mem('rain', '那天下雨，用户加班到很晚，角色一直陪着聊天', 3),
];

let hits = rankMemoriesByRelevance('用户：年糕昨晚又踩我脸了', pool, { topK: 8, now });
assert.equal(hits[0]?.id, 'cat', 'cat memory should rank first for 年糕');
assert.ok(!ids(hits).includes('food'), 'unrelated memory must not pass the gate');
console.log('PASS keyword hit ranks first, unrelated filtered');

hits = rankMemoriesByRelevance('用户：早安', pool, { topK: 8, now });
assert.deepEqual(ids(hits), [], 'small talk with only common words recalls nothing');
console.log('PASS small talk recalls nothing');

hits = rankMemoriesByRelevance('杭州的酒店订好了吗，面试准备得怎么样', pool, { topK: 1, now });
assert.equal(hits.length, 1, 'topK caps result count');
hits = rankMemoriesByRelevance('杭州的酒店订好了吗，面试准备得怎么样', pool, { topK: 8, now });
assert.deepEqual(ids(hits).sort(), ['job', 'trip'], 'both topics recalled when topK allows');
console.log('PASS topK cap and multi-topic recall');

const dupPool = [...pool, mem('trip2', '用户和角色约好国庆一起去杭州看西湖，用户负责订酒店。', 11)];
hits = rankMemoriesByRelevance('国庆去杭州西湖', dupPool, { topK: 8, now });
assert.equal(ids(hits).filter(id => id.startsWith('trip')).length, 1, 'near-duplicate dropped');
console.log('PASS near-duplicate dropped');

const vecPool = [
  mem('pet', '那只小家伙最近胃口很差，带去医院打了针', 8, { embedding: [0.9, 0.1, 0] }),
  mem('work', '用户换了新工位，靠窗', 8, { embedding: [0, 0.2, 0.9] }),
  mem('odd', '维度不同的旧向量', 8, { embedding: [1, 0] }),
];
hits = rankMemoriesByRelevance('我家猫咪生病了', vecPool, { topK: 8, now, queryEmbedding: [0.88, 0.12, 0.05] });
assert.deepEqual(ids(hits), ['pet'], 'vector channel recalls synonym match; dim mismatch ignored');
hits = rankMemoriesByRelevance('我家猫咪生病了', vecPool, { topK: 8, now, queryEmbedding: null });
assert.deepEqual(ids(hits), [], 'without embeddings the synonym is missed (known keyword limit)');
console.log('PASS vector channel adds synonym recall, mismatched dims ignored');

const recentVsOld = [
  mem('old', '用户喜欢樱花季去公园拍照', 300), mem('new', '用户喜欢樱花季去河边拍照', 2),
  mem('x1', '用户最近在学吉他', 30), mem('x2', '用户周末去爬山', 30),
];
hits = rankMemoriesByRelevance('樱花 拍照', recentVsOld, { topK: 8, now });
assert.equal(hits[0].id, 'new', 'recent memory wins near-ties');
console.log('PASS recency breaks near-ties');

const tiny = [mem('only', '用户说阿澈做的蛋炒饭太咸了', 4)];
hits = rankMemoriesByRelevance('今天吃什么', tiny, { topK: 8, now });
assert.deepEqual(ids(hits), ['only'], 'one or two memories are always kept');
console.log('PASS tiny pool keeps everything');

const named = [
  mem('n1', '阿澈陪用户看了一整晚的电影', 10), mem('n2', '阿澈给用户做了蛋炒饭，有点咸', 9),
  mem('n3', '阿澈说下个月要出差去上海', 8), mem('n4', '阿澈和用户吵了一架又和好了', 7), mem('n5', '阿澈送了用户一条围巾', 6),
];
hits = rankMemoriesByRelevance('阿澈：早安呀\n用户：早', named, { topK: 8, now });
assert.deepEqual(ids(hits), [], 'character name alone does not recall everything');
hits = rankMemoriesByRelevance('阿澈：出差的事定了吗', named, { topK: 8, now });
assert.deepEqual(ids(hits), ['n3'], 'topic still found when name is everywhere');
console.log('PASS ubiquitous name ignored, topic still recalled');

const d = (m, dd) => new Date(2026, m - 1, dd, 20).getTime();
assert.equal(describeMemoryTime(d(9, 14), d(9, 14), now), '9月14日（周一） · 昨天');
assert.equal(describeMemoryTime(d(9, 1), d(9, 3), now), '9月1日–9月3日 · 约 2 周前');
assert.equal(describeMemoryTime(d(9, 15), d(9, 15), now), '9月15日（周二） · 今天');
assert.equal(describeMemoryTime(new Date(2025, 2, 3).getTime(), new Date(2025, 2, 3).getTime(), now), '2025年3月3日（周一） · 1 年多前');
console.log('PASS date labels');

const offlineHistory = [
  { content: '（推开酒馆的门）' }, { content: '撤回的话', isRetracted: true },
  ...Array.from({ length: 9 }, (_, i) => ({ content: `第${i}句` })), { content: '  那把钥匙你还留着吗  ' }, { content: null },
];
const merged = mergeRecallContext('线上：晚安\n', offlineHistory);
const lines = merged.split('\n');
assert.equal(lines[0], '线上：晚安', 'timeline context stays first');
assert.equal(lines.length, 9, 'timeline + last 8 request messages');
assert.equal(lines.at(-1), '那把钥匙你还留着吗', 'current input is last and trimmed');
assert.ok(!merged.includes('撤回') && !merged.includes('推开酒馆'), 'retracted and older lines dropped');
const keyPool = [...pool, mem('key', '角色把旧公寓的钥匙交给了用户保管', 30)];
hits = rankMemoriesByRelevance(merged, keyPool, { topK: 8, now });
assert.ok(ids(hits).includes('key'), 'offline input reaches the recall query');
console.log('PASS request messages merged into recall query (offline scene)');
