// Run the real workflow scripts, composite executor and local-data result adapter.
// Fixtures replace only persisted reads, IndexedDB messages, and external tool routing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
function js(source) {
  const parsed = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const withoutImports = parsed.statements.filter(n => !ts.isImportDeclaration(n)).map(n => n.getText(parsed)).join('\n');
  return ts.transpileModule(withoutImports.replace(/^export /gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
function declarations(path, names) {
  const text = read(path), ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter(n => names.includes(n.name?.text) || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))));
  assert.equal(selected.length, names.length, 'test must use every requested production declaration');
  return selected.map(n => n.getText(ast)).join('\n');
}
if (process.argv.includes('--time-only')) {
  const timeContext=vm.createContext({});
  vm.runInContext(js(read('lib/builtin-phone-workflows.ts'))+';globalThis.helpers=COMMON_HELPERS;',timeContext);
  vm.runInContext(timeContext.helpers+';globalThis.format=compactDateTime;',timeContext);
  const expected={
    'Asia/Shanghai':['2026-09-10 08:46:00 UTC+08:00','2026-09-11 00:30:00 UTC+08:00'],
    'UTC':['2026-09-10 00:46:00 UTC+00:00','2026-09-10 16:30:00 UTC+00:00'],
    'America/New_York':['2026-09-09 20:46:00 UTC-04:00','2026-09-10 12:30:00 UTC-04:00'],
  }[process.env.TZ];
  assert.equal(timeContext.format('2026-09-10T00:46:00.000Z'),expected[0]);
  assert.equal(timeContext.format('2026-09-10T08:46:00+08:00'),expected[0]);
  assert.equal(timeContext.format('2026-09-10T16:30:00Z'),expected[1]);
  assert.equal(timeContext.format('2026-09-10'),'2026-09-10');
  assert.match(timeContext.format('2026-09-10 08:46:00'),/未标注时区/);
  if(process.env.TZ==='America/New_York') {
    assert.equal(timeContext.format('2026-11-01T05:30:00Z'),'2026-11-01 01:30:00 UTC-04:00');
    assert.equal(timeContext.format('2026-11-01T06:30:00Z'),'2026-11-01 01:30:00 UTC-05:00');
  }
  console.log('PASS device time conversion, explicit offsets and date boundaries: '+process.env.TZ);
  process.exit(0);
}
const characters = Array.from({length:6}, (_, i) => ({id:'c'+i, name:i === 5 ? '沈烬言' : '角色'+i, wechatID:'wx'+i, personality:'长角色设定'.repeat(1000)}));
const sessions = characters.map((c,i) => ({id:'s'+i, contactId:c.id, lastMessagePreview:'你好', updatedAt:'2026-09-10T12:00:00Z'}));
const contacts = characters.map((c,i) => ({id:'ct'+i, characterId:c.id, nickname:i === 5 ? '阿言' : ''}));
let malformed = false, failRead = false, empty = false, enabled = true, messageDbMissing = false, reads = [], messageReads = [];
const request = value => { const r = {}; queueMicrotask(() => {r.result=value; r.onsuccess?.();}); return r; };
const context = vm.createContext({console, Blob, setTimeout, clearTimeout,
  LOCAL_DATA_LIBRARY_CAPABILITY_ID:'local', getInternalCapability:()=>({enabled,mode:'auto'}),
  throwIfAborted(){}, isAbortError:()=>false, buildToolNameMacroContext:()=>({}), expandToolNameMacros:n=>n,
  indexedDB:{open:()=>request({objectStoreNames:messageDbMissing ? [] : ['messages'],close(){},transaction:()=>({objectStore:()=>({indexNames:['sessionId'],index:()=>({getAll:id=>{messageReads.push(id); return request([{role:'user',content:'这是真实的其他会话记录',sessionId:id,createdAt:'2026-09-10',order:1}]);}})})})})},
  IDBKeyRange:{only:x=>x},
});
vm.runInContext(js(read('lib/builtin-phone-workflows.ts'))+';globalThis.workflows=BUILTIN_PHONE_WORKFLOWS;',context);
// Use production projection/sanitization as well, including its 4000-character per-field cap.
vm.runInContext(js(declarations('lib/local-data-fs.ts',['MAX_STRING_LENGTH','isSensitiveKey','sanitizeValue','getFieldValue','setProjectedValue','projectValue']))+';globalThis.project=projectValue;',context);
context.readLocalDataFile = async input => {
  reads.push(input);
  if(failRead) throw Error('fixture storage unavailable');
  if(malformed && input.path.includes('/characters/')) return 'broken payload';
  const rows = empty ? [] : input.path.includes('/characters/') ? characters : input.path.endsWith('/contacts') ? contacts : sessions;
  const values = rows.map(row => context.project(row,input.fields || []));
  return input.path.includes('/characters/') ? {value:values,nextOffset:null} : {records:values.map(value=>({value})),nextOffset:null};
};
vm.runInContext(js(declarations('lib/tool-executor.ts',[
 'STRUCTURED_TOOL_DATA','MAX_RESULT_LENGTH','MAX_COMPOSITE_DEPTH','MAX_LOCAL_DATA_RESULT_LENGTH','truncate',
 'tryParseCompositeJson','resolveCompositePath','renderCompositeString','renderCompositeValue','renderCompositeArgs','formatCompositeDefaultOutput','stringifyCompositeScriptReturn',
 'executeCompositeScriptStep','executeCompositeTool','normalizeInternalToolResult','stringifyLocalDataResult','optionalStringArg','requiredStringArg','stringArrayArg','executeLocalDataTool',
]))+';globalThis.run=executeCompositeTool;globalThis.local=executeLocalDataTool;globalThis.normalize=normalizeInternalToolResult;',context);
context.executeSingleToolCall = async call => context.normalize(await context.local(call));
const workflow = id => context.workflows.find(w=>w.id==='builtin_phone_lookup_'+id);
const run = (id,args={}) => context.run(workflow(id),args,undefined,0);
let result = await run('wechat_contacts');
assert.equal(result.success,true,result.error); assert.match(result.data,/阿言/); assert.match(result.data,/角色0/);
assert.ok(JSON.stringify({value:characters.map(c=>context.project(c,['id','name','personality']))}).length > 12000);
console.log('PASS six long character cards retain contact names across the 12000-character adapter limit');
reads=[]; result=await run('wechat_messages');
assert.equal(result.success,true);assert.match(result.data,/6\/6/);assert.match(result.data,/沈烬言/);
assert.ok(reads.find(r=>r.path.includes('/characters/')).fields.every(f=>['id','name','wechatID'].includes(f)));
console.log('PASS six conversation names; message lookup requests only identity fields');
sessions[5].alias='阿沈';
for(const query of ['沈烬言','阿言','阿沈','wx5']){
 for(const id of ['wechat_messages','wechat_contacts']){result=await run(id,{query});assert.equal(result.success,true);assert.match(result.data,/sid=s5/);}
 result=await run('chat_history',{target:query});assert.equal(result.success,true);assert.match(result.data,/这是真实的其他会话记录/);assert.equal(messageReads.at(-1),'s5');
}
result=await run('chat_history',{sessionId:'s5'});assert.match(result.data,/sid=s5/);
console.log('PASS original name, contact nickname, session alias, WeChat ID and exact session ID reach the correct history');
// Even projected identity data can exceed display limits; internal payload remains intact.
characters[0].name='名'.repeat(4000);characters[1].name='名'.repeat(4000);characters[2].name='名'.repeat(4000);
result=await run('wechat_messages',{query:'沈烬言'});assert.equal(result.success,true);assert.match(result.data,/sid=s5/);
console.log('PASS large identity-only intermediate result still finds the target');
malformed=true;result=await run('wechat_messages');assert.equal(result.success,false);assert.match(result.error,/无法解析/);assert.ok(!result.userNotice?.endsWith('完成'));malformed=false;
failRead=true;result=await run('wechat_messages');assert.equal(result.success,false);assert.match(result.error,/storage unavailable/);failRead=false;
enabled=false;result=await run('wechat_messages');assert.equal(result.success,false);assert.match(result.error,/未启用/);enabled=true;
empty=true;result=await run('wechat_messages');assert.equal(result.success,true);assert.match(result.data,/0\/0/);empty=false;
messageDbMissing=true;result=await run('chat_history',{sessionId:'s5'});assert.equal(result.success,false);assert.match(result.error,/数据表不存在/);messageDbMissing=false;
console.log('PASS malformed/read-failed/disabled/missing message storage results are errors; genuinely empty data stays a valid empty list');
const composed={id:'structured',name:'structured',steps:[{id:'first',toolType:'script',saveAs:'first',script:'return {text:"x".repeat(4000),tail:"preserved"};'},{id:'next',toolType:'script',script:'return steps.first.json.tail + ":" + steps.first.json.text.length;'}],outputTemplate:'{{last.data}}'};
result=await context.run(composed,{},undefined,0);assert.equal(result.data,'preserved:4000');
const local=await context.local({name:'读取资料文件',args:{path:'/characters/test',fields:['name','personality']}});
assert.equal(local.data.length,12000);assert.equal(Object.keys(JSON.parse(JSON.stringify(local))).includes('structuredToolData'),false);
const large={id:'large',name:'large',steps:[{id:'one',toolType:'script',script:'return "x".repeat(4000);'}],outputTemplate:'{{last.data}}'};
result=await context.run(large,{},undefined,0);assert.equal(result.data.length,2000);
console.log('PASS script intermediates stay complete; final text limits and JSON serialization boundary remain intact');
// Readout regressions: exercise the same executor, changing only the stored records.
characters.forEach((c,i)=>{c.name=i===5?'沈烬言':'角色'+i;});
let historyRows=[];
context.indexedDB={open:()=>request({objectStoreNames:['messages'],close(){},transaction:()=>({objectStore:()=>({indexNames:['sessionId'],index:()=>({getAll:id=>{messageReads.push(id);return request(historyRows);}})})})})};
historyRows=Array.from({length:30},(_,i)=>({role:'user',sessionId:'s5',order:i,createdAt:'2026-09-10T00:46:00Z',content:(i===29?'FINAL_LATEST':'MESSAGE_'+i)+' '+ '这是聊天正文。'.repeat(22)}));
result=await run('chat_history',{sessionId:'s5',limit:30});
assert.equal(result.success,true);assert.ok(result.data.length<=2000);assert.match(result.data,/FINAL_LATEST/);assert.match(result.data,/另有 \d+ 条未展示/);
const shown=Number(result.data.match(/聊天记录 (\d+)\/30/)[1]);
assert.ok(shown>0&&shown<30);assert.equal(result.data.split('\n').filter(line=>/用户:/.test(line)).length,shown);
assert.ok(result.data.includes(historyRows[29].content),'the latest formatted message must be complete');
console.log('PASS long history keeps complete newest records with accurate count and omission notice');
sessions.push({id:'newer-group',isGroup:true,groupName:'朋友群',participantIds:['c5'],updatedAt:'2026-09-11'});
await run('chat_history',{target:'沈烬言'});assert.equal(messageReads.at(-1),'s5');
await run('chat_history',{target:'朋友群'});assert.equal(messageReads.at(-1),'newer-group');
sessions.push({id:'duplicate',contactId:'c5',updatedAt:'2026-09-12'});
let before=messageReads.length;result=await run('chat_history',{target:'沈烬言'});assert.match(result.data,/请指定 sessionId/);assert.match(result.data,/sid=s5/);assert.match(result.data,/sid=duplicate/);assert.equal(messageReads.length,before);
await run('chat_history',{sessionId:'s5'});assert.equal(messageReads.at(-1),'s5');
before=messageReads.length;result=await run('chat_history',{sessionId:'not-found',target:'沈烬言'});assert.match(result.data,/没有找到匹配/);assert.equal(messageReads.length,before);
sessions.pop();const direct=sessions.splice(5,1)[0];before=messageReads.length;result=await run('chat_history',{target:'沈烬言'});assert.match(result.data,/请指定 sessionId/);assert.equal(messageReads.length,before);
sessions.pop();sessions.push(direct);
console.log('PASS direct identity beats member-only groups; ambiguous matches require selection; explicit IDs never fall back');
historyRows=[{role:'user',content:'VISIBLE_REAL_MESSAGE',order:0,createdAt:'2026-09-10'},
  {role:'assistant',content:'',silentUpdate:true,order:1},
  {role:'assistant',content:'INTERNAL_TOOL_NOTICE',mediaType:'tool_notice',order:2},
  {role:'assistant',content:'INTERNAL_NATIVE',nativeToolCalls:[{id:'call'}],order:3},
  {role:'system',content:'SYSTEM_RECORD',order:4},
  {role:'assistant',content:'',silentUpdate:true,order:5}];
result=await run('chat_history',{sessionId:'s5',limit:3});assert.match(result.data,/1\/1/);assert.match(result.data,/VISIBLE_REAL_MESSAGE/);assert.doesNotMatch(result.data,/INTERNAL|SYSTEM_RECORD/);
result=await run('chat_history',{sessionId:'s5',includeSystem:true,limit:30});assert.match(result.data,/4\/4/);assert.match(result.data,/SYSTEM_RECORD/);
console.log('PASS silent updates never consume history; system/tool records remain opt-in');
let kvText=null, kvReadFails=false, kvOpenFails=false, kvStoreMissing=false;
context.indexedDB={open:()=>{
  if(kvOpenFails){const r={};queueMicrotask(()=>r.onerror?.());return r;}
  return request({objectStoreNames:kvStoreMissing?[]:['entries'],close(){},transaction:()=>({objectStore:()=>({get:()=>{if(kvReadFails)throw Error('fixture read error');return request(kvText===null?undefined:{value:kvText});}})})});
}};
for(const [id,key] of [['week_calendar','plans'],['shopping_orders','orders']]){
  kvText=null;result=await run(id,{date:'2026-09-10'});assert.equal(result.success,true);assert.match(result.data,/尚未创建/);
  kvText=JSON.stringify({[key]:[]});result=await run(id,{date:'2026-09-10'});assert.equal(result.success,true);assert.match(result.data,/0\/0/);assert.doesNotMatch(result.data,/尚未创建/);
  for(const invalid of ['{bad','', 'null','[]','{}',JSON.stringify({[key]:[null]})]){kvText=invalid;result=await run(id);assert.equal(result.success,false);assert.match(result.error,/损坏/);}
  kvText=JSON.stringify({[key]:[]});kvReadFails=true;result=await run(id);assert.equal(result.success,false);assert.match(result.error,/read error/);kvReadFails=false;
  kvOpenFails=true;result=await run(id);assert.equal(result.success,false);assert.match(result.error,/数据库读取失败/);kvOpenFails=false;
  kvStoreMissing=true;result=await run(id);assert.equal(result.success,false);assert.match(result.error,/数据表不存在/);kvStoreMissing=false;
}
console.log('PASS calendar/orders distinguish missing data, empty lists, invalid JSON/shape and failed storage');
kvText=JSON.stringify({plans:[{ownerType:'user',ownerId:'self',weekStart:'2026-09-07',items:[{date:'2026-09-10',startTime:'08:30',endTime:'09:00',title:'本地日程'}]}]});
result=await run('week_calendar',{date:'2026-09-10'});assert.equal(result.success,true);assert.match(result.data,/2026-09-10 08:30 ?-09:00 本地日程/);
kvText=JSON.stringify({orders:[{id:'o1',paidAt:'2026-09-10T00:46:00Z',timeLabel:'STALE_LABEL',summary:'订单',items:[]}]});
result=await run('shopping_orders');assert.equal(result.success,true);assert.match(result.data,/UTC[+-]\d{2}:\d{2}/);assert.doesNotMatch(result.data,/STALE_LABEL/);
console.log('PASS calendar wall-clock fields remain local; paidAt output carries a timezone');
for(const zone of ['Asia/Shanghai','UTC','America/New_York'])process.stdout.write(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--time-only'],{env:{...process.env,TZ:zone},encoding:'utf8'}));
