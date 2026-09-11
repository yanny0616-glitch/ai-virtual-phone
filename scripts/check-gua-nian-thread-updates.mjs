import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as promises from '../custom-apps/gua-nian/src/domain/promises.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const now=Date.now(), original='她问我算什么身份 我还没给答案', variant='她问我算什么身份，我还欠一个答案';
const topic={id:'t1',kind:'topic',text:original,since:now-3600000,at:now-1000,done:false,nudge:'said:08:00'};
const parseWhen=value=>value?Date.parse(value):0;
const app=vm.createContext({Date,console,S:{settings:{threadsOn:true,threadDays:3}},GuaNianPromises:promises,parseWhen,upsert:async()=>{},log:async()=>{}});
const generation=read('custom-apps/gua-nian/src/planning/generation.js');
vm.runInContext(read('custom-apps/gua-nian/src/planning/threads.js')+generation.slice(0,generation.indexOf('  async function recentDaysBrief('))+';globalThis.api={applyThreads,threadLines,task:THREAD_TASK};dropThreadSlots=async()=>{};',app);
const source=read('supabase/functions/push-recheck/index.ts'),ast=ts.createSourceFile('worker.ts',source,ts.ScriptTarget.Latest,true);
const names=['applyThreads','threadAlive','threadTextKey','findThreadUpdate','liveThreads','threadPace','threadLines'];
const functions=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
const cloud=vm.createContext({Date,console,updatePromiseThreads:promises.updatePromiseThreads,parseWhen,threadWhen:()=>'',THREAD_KIND:{topic:'话头',promise:'约定',date:'日子'}});
vm.runInContext(ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';globalThis.api={applyThreads,threadLines};',cloud);
async function check(label,input,keep,settle,verify){
 const before=JSON.stringify(input),payload=JSON.stringify(keep);
 const cx={character:{id:'c'},threads:input};let writes=0;app.upsert=async()=>{writes++;};
 await app.api.applyThreads(cx,{keep,settle},now,'cloud');
 const result=cloud.api.applyThreads({threads:input,threadDays:3},keep,settle,now,0,()=>{});
 verify(cx.threads,{writes,side:'app'});verify(result||input,{writes:result?1:0,side:'cloud'});
 assert.equal(JSON.stringify(input),before);assert.equal(JSON.stringify(keep),payload);
 const normalize=rows=>JSON.parse(JSON.stringify(rows)).map(r=>({...r,id:input.some(t=>t.id===r.id)?r.id:'new'}));
 assert.deepEqual(normalize(cx.threads),normalize(result||input),label+' app/cloud parity');
 console.log('PASS '+label);
}
await check('same ID updates paraphrased topic without replacing identity or schedule references',[topic],[{id:' [ t1 ] ',kind:'topic',text:variant}],[],rows=>{assert.equal(rows.length,1);assert.equal(rows[0].text,variant);assert.equal(rows[0].id,'t1');assert.equal(rows[0].since,topic.since);assert.equal(rows[0].nudge,topic.nudge);assert.equal(rows[0].at,now);});
await check('punctuation-only change without ID updates and persists the existing entry',[topic],[{kind:'topic',text:'她问我算什么身份，我还没给答案。'}],[],(rows,state)=>{assert.equal(rows.length,1);assert.equal(rows[0].at,now);assert.equal(state.writes,1);});
await check('invalid or mismatched IDs do not silently create new topics',[topic],[{id:'invented',kind:'topic',text:variant},{id:'t1',kind:'date',text:'生日',when:'2026-09-12 12:00'}],[],rows=>assert.deepEqual(JSON.parse(JSON.stringify(rows)),[topic]));
await check('omitted kind preserves the referenced entry type',[topic],[{id:'t1',text:variant}],[],rows=>{assert.equal(rows.length,1);assert.equal(rows[0].kind,'topic');assert.equal(rows[0].text,variant);});
await check('settled entry stays settled for explicit ID and identical text',[{...topic,done:true}],[{id:'t1',text:variant},{kind:'topic',text:original}],[],rows=>{assert.equal(rows.length,1);assert.equal(rows[0].done,true);assert.equal(rows[0].at,topic.at);});
await check('settle wins over keep in the same decision',[topic],[{id:'t1',kind:'topic',text:variant}],['t1'],rows=>{assert.equal(rows.length,1);assert.equal(rows[0].done,true);});
await check('new topic is still created normally',[topic],[{kind:'topic',text:'周末想去看展览'}],[],rows=>assert.equal(rows.length,2));
await check('two identical new items in one decision create only one entry',[],[{kind:'topic',text:original},{kind:'topic',text:original}],[],rows=>assert.equal(rows.length,1));
await check('existing duplicates require ID, not arbitrary merging or a third copy',[topic,{...topic,id:'t2'}],[{kind:'topic',text:original}],[],rows=>assert.equal(rows.length,2));
await check('topic text matching does not overwrite a promise',[{...topic,kind:'promise',subject:'character',due:now+3600000}],[{kind:'topic',text:original}],[],rows=>{assert.equal(rows.length,2);assert.equal(rows[0].kind,'promise');});
const due=parseWhen('2026-09-20 12:00');
await check('date update keeps the ID and updates its due time',[{...topic,kind:'date',due:now+3600000,yearly:true}],[{id:'t1',kind:'date',text:'纪念日',when:'2026-09-20 12:00'}],[],rows=>{assert.equal(rows.length,1);assert.equal(rows[0].due,due);assert.equal(rows[0].yearly,true);});
const refs={threads:[topic,{...topic,id:'closed',done:true},{...topic,id:'old',done:true,at:now-8*86400000}]};
for(const lines of [app.api.threadLines(refs,now),cloud.api.threadLines({...refs,threadDays:3},now,0)]){
 assert.ok(lines.some(t=>t.includes('[t1]')));assert.ok(lines.some(t=>t.includes('[closed] 已了结')&&t.includes('仅供判重')));assert.ok(!lines.some(t=>t.includes('[old]')));
}
assert.match(app.api.task,/keep.id 必须填原编号/);assert.ok(source.includes('keep.id 必须填原编号'));
console.log('PASS live IDs and recent settled references reach the model; expired references stay out');
