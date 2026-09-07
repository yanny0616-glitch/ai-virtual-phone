import './check-shiguang.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
function load(file, modules = {}) {
  const exports = {};
  const source = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: id => modules[id] ?? require(id), console, Date });
  return exports;
}
const types = load('lib/shiguang-types.ts'), tokens = load('lib/token-counter.ts');
const domain = load('lib/shiguang-domain.ts', { './shiguang-types': types, './token-counter': tokens });
const entry = { id:'memory1',type:'shiguang',characterId:'c1',content:'沈烬言记得宁妍画画时循环听《月光》，深夜分享给她。',createdAt:'2026-09-01T02:37:00Z',updatedAt:'2026-09-01T02:37:00Z',sourceMessageIds:['source1'],shiguang:{ title:'月光与画画时的循环习惯',categories:['共同经历'],reason:'宁妍深夜睡不着',story:'沈烬言分享《月光》，提到她上周三放了七遍。',details:[{label:'音乐',value:'《月光》，未说明版本'}],significance:'记住画画习惯',stableSummary:'她会循环播放音乐',recallSummary:'隐藏的旧简述',keywords:['月光','画画'],status:'remembered',followup:'',firstEventAt:'2026-09-01T02:37:00Z',lastEventAt:'2026-09-01T02:37:00Z'} };
const clone = value => JSON.parse(JSON.stringify(value));
const original = clone(entry);
const derived = domain.defaultShiguangSummary(entry);
assert.match(derived,/《月光》/);assert.match(derived,/七遍/);assert.match(derived,/未说明版本/);
assert.equal(entry.shiguang.promptSummary,undefined);
assert.deepEqual(entry,original);
assert.equal(domain.selectShiguangForPrompt([entry],'今晚吃什么',800,new Date())[0].content,domain.shiguangPromptText(entry));
const manual = clone(entry);manual.shiguang.promptSummary='宁妍循环播放《月光》，沈烬言记得并在深夜分享。';manual.shiguang.recallMode='relevant';
assert.equal(domain.selectShiguangForPrompt([manual],'吃什么',800,new Date()).length,0);
assert.equal(domain.selectShiguangForPrompt([manual],'月光',800,new Date())[0].content,domain.shiguangPromptText(manual));
manual.shiguang.recallMode='off';assert.equal(domain.selectShiguangForPrompt([manual],'月光',4000,new Date()).length,0);
manual.shiguang.recallMode='priority';manual.shiguang.status='pending';manual.shiguang.followup='已联系老师，尚无回复';
assert.match(domain.shiguangPromptText(manual),/当前进展：尚待兑现。 最新进展：已联系老师，尚无回复/);
assert.equal(domain.selectShiguangForPrompt([manual],'月光',800,new Date(),domain.shiguangPromptText(manual)).length,0);
const candidate = domain.buildShiguangExtractionPrompt('test', [manual]);
assert.match(candidate, /test/);
assert.ok(candidate.includes(manual.shiguang.promptSummary));
assert.ok(!candidate.includes('隐藏的旧简述'));
console.log('PASS legacy facts, one visible summary, explicit recall modes, progress and deduplication');

let saved=clone(entry), config={ shiguangEnabled:true,shiguangAutoEnabled:true,shiguangRoundInterval:20,shiguangTokenBudget:800,longTermTokenBudget:9000 };
const api=load('lib/shiguang-app-api.ts',{
  './character-storage':{loadCharacters:()=>[{id:'c1',name:'角色'},{id:'c2',name:'另一个角色'}]},
  './chat-storage':{hydrateChatStorage:async()=>{}},
  './memory-storage':{loadMemoryConfig:()=>({...config}),saveMemoryConfig:value=>{config=value;},loadMemoryEntriesByType:async(cid,type)=>cid==='c1'&&type==='shiguang'?[clone(saved)]:[],saveShiguangEdit:async(value,expected)=>{assert.equal(expected,saved.updatedAt);saved=clone(value);}},
  './shiguang-domain':domain,'./shiguang-types':types,'./token-counter':tokens,
  './shiguang-summarizer':{runShiguangPipeline:async(id)=>({success:true,saved:0,characterId:id})},
  './short-term-assembler':{loadNativeTimeline:()=>[{id:'source1',content:'原消息',authorType:'user'},{id:'not-associated',content:'别的消息'}]},
});
const result=await api.readShiguangApp({characterId:'c1'});
assert.equal(result.entries[0].promptText,domain.shiguangPromptText(entry));
assert.equal((await api.readShiguangApp({characterId:'c2'})).entries.length,0);
const draft={...result.entries[0].shiguang,content:entry.content,promptSummary:'精简但保留《月光》、沈烬言分享的事实。',recallMode:'relevant'};
const req={characterId:'c1',id:entry.id,expectedUpdatedAt:entry.updatedAt,draft};
await assert.rejects(api.saveShiguangApp({...req,characterId:'c2'}),/不存在/);
await assert.rejects(api.saveShiguangApp({...req,draft:{...draft,promptSummary:''}}),/摘要/);
await assert.rejects(api.saveShiguangApp({...req,draft:{...draft,recallMode:'all'}}),/方式/);
await assert.rejects(api.saveShiguangApp({...req,draft:{...draft,dueAt:'2026-02-30'}}),/日期/);
await assert.rejects(api.saveShiguangApp({...req,draft:{...draft,keywords:Array(9).fill('词')}}),/关键词/);
const updated=await api.saveShiguangApp(req);
assert.equal(updated.shiguang.promptSummary,draft.promptSummary);assert.equal(updated.shiguang.userEdited,true);
assert.equal(updated.promptText,domain.selectShiguangForPrompt([saved],'月光',800,new Date())[0].content);
assert.deepEqual(saved.sourceMessageIds,entry.sourceMessageIds);
assert.equal((await api.shiguangAppSources({characterId:'c1',id:entry.id})).length,1);
api.configureShiguangApp({tokenBudget:1200,longTermTokenBudget:1});assert.equal(config.longTermTokenBudget,9000);assert.equal(config.shiguangTokenBudget,1200);
assert.throws(()=>api.configureShiguangApp({tokenBudget:NaN}),/tokenBudget/);
assert.throws(()=>api.configureShiguangApp({enabled:'yes'}),/开关/);
await api.deleteShiguangApp({characterId:'c1',id:entry.id,expectedUpdatedAt:saved.updatedAt});
assert.ok(saved.shiguang.deletedAt);assert.equal((await api.readShiguangApp({characterId:'c1'})).entries.length,0);
console.log('PASS app API field validation, character isolation, exact prompt text, settings isolation and tombstone deletion');

const runner=read('components/app-market/custom-app-runner.tsx');
for(const [method,permission] of [['readShiguang','readShiguang'],['saveShiguang','writeShiguang'],['deleteShiguang','writeShiguang'],['configureShiguang','writeShiguang'],['shiguangSources','readShiguang'],['shiguangSettings','readShiguang'],['organizeShiguang','organizeShiguang']]) {
  const start=runner.indexOf(`if (action === "memory.${method}")`),end=runner.indexOf('\n    }',start);
  assert.ok(start>0);assert.ok(runner.slice(start,end).includes(`requirePermission("memory.${permission}")`));
}
const manifest=JSON.parse(read('custom-apps/shiguang/manifest.json'));
assert.equal(manifest.id,'float.shiguang');assert.ok(manifest.permissions.includes('memory.organizeShiguang'));
assert.ok(!manifest.permissions.includes('chat.context'),'no second injection path');
console.log('PASS host permission gates and single injection path');
