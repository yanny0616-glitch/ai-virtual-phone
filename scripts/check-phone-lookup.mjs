// Run the real workflow scripts, composite executor and local-data result adapter.
// Fixtures replace only persisted reads, IndexedDB messages, and external tool routing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
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
