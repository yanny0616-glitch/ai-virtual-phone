import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const hooks=new Map(), variables=new Map();
const now=1789082428169;
class Clock extends Date { static now(){return now;} }
const sandbox=vm.createContext({Date:Clock});
vm.runInContext(fs.readFileSync(new URL('../chat-plugins/busy-reply.js',import.meta.url),'utf8').replace('export default','globalThis.plugin ='),sandbox);
const settings=Object.fromEntries(sandbox.plugin.manifest.settings.map(s=>[s.key,s.default]));
sandbox.plugin.setup({
  hooks:{transform:(key,fn)=>hooks.set(key,fn)},
  data:{replyGate:{policyVersion:1,silenceVersion:1},characters:{list:()=>[]},variables:{get:(key,scope,id)=>{assert.notEqual(key,'affection','busy reply must not read affection data');return variables.get(id+':'+key);}}},
  system:{settings:{get:key=>settings[key],all:()=>({...settings}),onChange(){}},storage:{get:()=>true,set(){throw Error('prompt must not write storage');}}},
});
const prompt=(extra={})=>hooks.get('prompt.system')({characterId:'c',sessionId:'s',hint:'既有提示',replyText:'你在做什么',...extra});
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const presence=freeze({at:now,state:'online',label:'',asleep:false,busy:false,doing:'早餐',step:'吃到一半',place:'家里餐厅',mood:'有点堵',energy:54,next:'08:05 车上核数字',managedBy:'INTERNAL_OWNER',appId:'INTERNAL_APP_ID',syncStatus:'INTERNAL_SYNC',syncAt:now,unknown:'UNKNOWN_SENTINEL'});
const affection=freeze({score:15,tier:'TIER_SENTINEL',relation:'养父女',updatedAt:now,todayDate:'2026-09-10',todayDelta:1,history:[{at:now,delta:1,reason:'HISTORY_SENTINEL'}],relationHistory:[{from:'RELATION_HISTORY_SENTINEL'}],pendingRelation:{to:'PENDING_SENTINEL'}});
variables.set('c:presence',presence);variables.set('c:affection',affection);
const before=JSON.stringify([...variables]);
let result=prompt();assert.equal(result.allowSilence,true);assert.ok(result.hint.startsWith('既有提示'));
for(const text of ['日程状态：在线','正在做：早餐','当前进展：吃到一半','地点：家里餐厅','心情：有点堵','精力：54/100','接下来：08:05 车上核数字'])assert.ok(result.hint.includes(text),text);
assert.doesNotMatch(result.hint,/SENTINEL|INTERNAL_|managedBy|appId|syncStatus|syncAt|updatedAt|todayDelta|todayDate|relationHistory|history|presence:|affection:|当前好感|当前关系|养父女|15\/100|score|tier|[{}]/);
assert.equal(JSON.stringify([...variables]),before);
const relationshipHint='两人现在的关系：养父女。';
assert.equal(prompt({hint:relationshipHint}).hint.split('养父女').length-1,1);
console.log('PASS Chinese life-state summary; no affection reads or duplicate relationship; original hint and frozen input preserved');
variables.set('c:presenceOverride',freeze({state:'busy',label:'正在开会',at:now-1000,id:'OVERRIDE_INTERNAL'}));
result=prompt();assert.match(result.hint,/手动状态：忙碌/);assert.match(result.hint,/手动状态说明：正在开会/);assert.doesNotMatch(result.hint,/OVERRIDE_INTERNAL/);
variables.set('c:presenceOverride',{state:'sleep',label:'EXPIRED_LABEL',at:now-61*60000});assert.doesNotMatch(prompt().hint,/手动状态|EXPIRED_LABEL/);
variables.set('c:presenceOverride',{state:'busy',label:'FUTURE_LABEL',at:now+1000});assert.doesNotMatch(prompt().hint,/手动状态|FUTURE_LABEL/);
variables.set('c:presenceOverride',{state:'hidden',at:now-86400000});assert.match(prompt().hint,/手动状态：隐身/);
console.log('PASS active manual statuses render in words; timed expired/future states are omitted');
variables.clear();variables.set('c:presence',{energy:0,doing:'早饭\n稍后出门'});variables.set('c:affection',{score:0,relation:'家人'});
result=prompt();assert.match(result.hint,/精力：0\/100/);assert.doesNotMatch(result.hint,/当前好感|score|tier/);assert.match(result.hint,/正在做：早饭 稍后出门/);
variables.set('c:presence',{energy:NaN,doing:{bad:'OBJECT_SENTINEL'},mood:'长'.repeat(300)});variables.set('c:affection',[]);
result=prompt();assert.doesNotMatch(result.hint,/NaN|OBJECT_SENTINEL|object Object|当前好感/);assert.ok(result.hint.includes('长'.repeat(180)+'…'));
assert.doesNotMatch(prompt({characterId:'other'}).hint,/状态参考|长/);
variables.clear();assert.doesNotMatch(prompt().hint,/状态参考/);
console.log('PASS missing/malformed fields are omitted, zero energy retained, long text bounded and characters isolated');
assert.equal(prompt({isGroup:true}).allowSilence,undefined);assert.equal(prompt({replyText:undefined}).allowSilence,undefined);
assert.equal(prompt({replyText:'快回，我不舒服'}).allowSilence,undefined);
settings.allowSilence=false;assert.equal(prompt().allowSilence,undefined);settings.allowSilence=true;
settings.enabled=false;assert.equal(prompt().allowSilence,undefined);
console.log('PASS existing group, urgency, plugin and silence switches still control injection');
