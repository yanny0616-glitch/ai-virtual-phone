import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {recheckFixture} from './lib/gua-nian-recheck-fixture.mjs';
import {stripTypeScriptTypes} from 'node:module';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const strip=p=>stripTypeScriptTypes(read(p)).replace(/^import\s[\s\S]*?;\s*$/gm,'').replace(/^export /gm,'');
let now=new Date(2026,8,9,10,30).getTime();
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const day={date:'2026-09-09',wake:'07:00',bed:'23:00',mood:'平静',energy:80,doing:'看看书',location:'家',schedule:[
  {time:'10:00',end:'11:00',title:'开会',place:'公司',cost:-10,mood:'专注',steps:[{time:'10:00',what:'讨论'},{time:'10:30',what:'总结'}]},
  {time:'12:00',end:'13:00',title:'吃饭',place:'食堂',cost:5},
],conds:[{startAt:now-3600000,halfLifeMin:180,intensity:40,energyDelta:-5,mood:'有点累',cause:'忙了一天'}]};
const pure=vm.createContext({Date:Clock});vm.runInContext(strip('lib/guanian-presence.ts')+';globalThis.calc=calculateGuanianPresence;',pure);

// Compare the shared calculation with the pre-change app implementation.
const old=read('scripts/lib/gua-nian-presence-legacy.txt');
const legacy=old.slice(old.indexOf('  async function publishPresence(')).replace('publishPresence','legacyPresence');
let captured;
const app=vm.createContext({Date:Clock,console,AiPhone:{variables:{set:async(_name,value)=>{captured=value;},unset:async()=>{captured=null;}}}});
const bundle=read('custom-apps/gua-nian/index.html').match(/<script>([\s\S]*)<\/script>/)[1];
vm.runInContext(bundle.replace(/  init\(\);\s*\}\)\(\);\s*$/,legacy+';globalThis.api={S,legacyPresence};\n})();'),app);
app.api.S.settings={quietStart:'23:00',quietEnd:'07:00'};
for(const previous of [false,true])for(const [h,m]of [[0,30],[6,59],[7,0],[9,59],[10,0],[10,30],[11,0],[12,30],[16,0],[23,0]]){
  now=new Date(2026,8,9,h,m).getTime();
  await app.api.legacyPresence({character:{id:'c'},day:previous?null:day,prev:previous?day:null});
  const result=pure.calc(previous?null:day,previous?day:null,app.api.S.settings,now);
  for(const key of ['asleep','busy','doing','step','place','mood','energy','next'])assert.equal(result[key],captured[key],`${previous?'previous':'today'} ${h}:${m} ${key}`);
}
console.log('PASS shared status matches existing Gua Nian behavior at 20 schedule/sleep boundaries');

// Actual host service with controlled cloud, clock, storage and browser events.
now=new Date(2026,8,9,10,30).getTime();
const h={requests:[],rows:[],failed:false};
const events=new EventTarget(),doc=new EventTarget();doc.visibilityState='visible';
events.setInterval=fn=>{h.tick=fn;return 1;};events.clearInterval=()=>{};events.setTimeout=setTimeout;events.clearTimeout=clearTimeout;
const vars=new Map(),kv=new Map(),gates=new Map();
const settings={characterIds:['c'],cloudUrl:'https://test',cloudKey:'test',quietStart:'23:00',quietEnd:'07:00',planSync:{c:{date:'2026-09-09',status:'synced',at:now}}};
let days=[{...day,characterId:'c',updatedAt:new Date(now-3600000).toISOString()}];
let installed=[{id:'app',manifest:{id:'gua.nian'},permissions:['chat.context']}];
class Realtime{
  constructor(){h.connections=(h.connections||0)+1;}
  channel(_name,opts){assert.equal(opts.config.private,true);return this;}
  on(_event,_filter,fn){h.broadcast=fn;return this;}
  subscribe(fn){h.subscribe=fn;return this;}
  disconnect(){h.disconnections=(h.disconnections||0)+1;}
}
const ctx=vm.createContext({Date:Clock,console,Event,CustomEvent,AbortController,URLSearchParams,Response,window:events,document:doc,RealtimeClient:Realtime,
  loadInstalledCustomApps:()=>installed,readCustomAppCollection:(_id,c)=>c==='settings'?[settings]:c==='plans'?[{characterId:'c',date:'2026-09-09',cloudStateVersion:h.localVersion||0}]:days,
  getChatPluginVar:(name,_scope,id)=>vars.get(id+':'+name),
  setChatPluginVar:(name,value,_scope,id)=>{vars.set(id+':'+name,value);events.dispatchEvent(new CustomEvent('vars',{detail:{name}}));},
  unsetChatPluginVar:(name,_scope,id)=>vars.delete(id+':'+name),
  setCustomAppReplyGate:(_app,id,gate)=>gates.set(id,gate),normalizeReplyGate:x=>x,
  kvGet:k=>kv.get(k),kvSet:(k,v)=>kv.set(k,v),registerKvMigration(){},
  CUSTOM_APPS_UPDATED_EVENT:'apps',CUSTOM_APP_DATA_UPDATED_EVENT:'data',CHAT_PLUGIN_VARS_CHANGED_EVENT:'vars',
  fetch:async(url,init)=>{h.requests.push({url,init});const q=new URL(url).searchParams;return h.failed?new Response('{}',{status:503}):Response.json({ok:true,date:q.get('date'),rows:h.rows});},
});
vm.runInContext(strip('lib/guanian-presence.ts')+strip('lib/guanian-presence-sync.ts')+';globalThis.start=startGuanianPresenceSync;',ctx);
const flush=()=>new Promise(r=>setImmediate(r));
const stop=ctx.start();await flush();
assert.equal(vars.get('c:presence').doing,'开会');assert.equal(vars.get('c:presence').busy,true);
assert.equal(h.requests.length,1);assert.equal(gates.get('c').legacyReplySettings.peekMin,3);
now=new Date(2026,8,9,11,0).getTime();h.tick();await flush();assert.equal(vars.get('c:presence').busy,false);
console.log('PASS status changes with the clock without opening the custom app');
h.rows=[{characterId:'c',date:'2026-09-09',updatedAt:new Date(now).toISOString(),version:2,settings:{},day:{...day,schedule:[{time:'11:00',end:'14:00',title:'门诊',busy:true}]}}];
h.broadcast();await flush();assert.equal(vars.get('c:presence').doing,'门诊');
assert.ok(h.requests.every(r=>r.init.headers['x-ai-phone-service-key']==='test'));
console.log('PASS private cloud change notification reloads the current role schedule');
days=[{...day,characterId:'c',updatedAt:new Date(now+1000).toISOString(),schedule:[{time:'11:00',end:'14:00',title:'散步'}]}];
events.dispatchEvent(new CustomEvent('data',{detail:{collection:'days'}}));await flush();assert.equal(vars.get('c:presence').doing,'散步');
console.log('PASS unsynced local edits remain authoritative over an older server snapshot');
settings.planSync.c.at=now+2000;h.failed=true;events.dispatchEvent(new Event('online'));await flush();
assert.equal(vars.get('c:presence').doing,'门诊');assert.equal(vars.get('c:presence').syncStatus,'cached');
console.log('PASS network failure preserves cached schedule and marks it as cached');
h.localVersion=3;events.dispatchEvent(new CustomEvent('data',{detail:{collection:'settings'}}));await flush();
assert.equal(vars.get('c:presence').doing,'散步');h.localVersion=0;
console.log('PASS an older cloud plan version cannot replace a successfully synced local edit');
doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));const count=h.requests.length;h.tick();await flush();assert.equal(h.requests.length,count);
doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));await flush();assert.ok(h.requests.length>count);
console.log('PASS hidden host pauses network and foreground resumption immediately checks cloud');
h.failed=false;now=new Date(2026,8,9,23,59,59).getTime();h.tick();await flush();const beforeMidnight=h.requests.length;
now=new Date(2026,8,10,0,0,0).getTime();h.rows=[];h.tick();await flush();assert.ok(h.requests.length>beforeMidnight);
assert.equal(vars.get('c:presence').busy,false);assert.equal(vars.get('c:presence').state,'sleep');
console.log('PASS crossing midnight fetches the new date immediately and never replays yesterday meetings');
settings.characterIds=[];events.dispatchEvent(new CustomEvent('data',{detail:{collection:'settings'}}));await flush();
assert.equal(vars.has('c:presence'),false);assert.equal(gates.get('c'),null);
stop();const final=h.requests.length;events.dispatchEvent(new Event('online'));await flush();assert.equal(h.requests.length,final);
console.log('PASS deselection removes managed state and shutdown removes listeners');

// Exercise the real online-status resolver, including a manual override.
let pluginCode=read('chat-plugins/presence-status.js').replace('export default', 'globalThis.plugin=');
pluginCode=pluginCode.replace('    const painters = new Set();','    globalThis.resolvePresence=presenceOf;\n    const painters = new Set();');
const statusVars=new Map([['presence',{managedBy:'guanian-host',at:now,state:'busy',doing:'门诊'}]]);
const plugin=vm.createContext({Date:Clock,console});
vm.runInContext(pluginCode,plugin);
plugin.plugin.setup({ui:{injectCSS(){},slot(){}},hooks:{on(){}},data:{variables:{get:name=>statusVars.get(name)},replyGate:{get:()=>({sleep:{bed:'00:00',wake:'23:59'}})}},system:{settings:{get:()=>true,onChange(){}},timers:{setInterval(){}},log(){}}});
assert.equal(plugin.resolvePresence('c').state,'busy');
statusVars.set('presenceOverride',{state:'hidden'});assert.equal(plugin.resolvePresence('c').state,'hidden');
statusVars.delete('presenceOverride');assert.equal(plugin.resolvePresence('c').state,'busy');
console.log('PASS manual visibility override wins; automatic status uses current host data');

// Gateway only returns schedule fields for requested roles/dates, never model credentials.
let gateway;let failed=false;const calls=[];
vm.runInNewContext(stripTypeScriptTypes(read('supabase/functions/ai-phone-push/index.ts')),{console,Date,Request,Response,URL,Headers,AbortSignal,crypto:webcrypto,TextEncoder,btoa,
 Deno:{env:{get:k=>({SUPABASE_URL:'https://test',SUPABASE_SERVICE_ROLE_KEY:'test'})[k]},serve:fn=>gateway=fn},
 fetch:async(url,init={})=>{calls.push({url,init});if(url.includes('/auth/v1/admin/'))return new Response('',{status:401});return failed?new Response('',{status:503}):Response.json([
 {character_id:'c',plan_date:'2026-09-09',context:{day,genKit:{sensitive:'must-not-return'},quietStart:'23:00'}},
 {character_id:'other',plan_date:'2026-09-09',context:{day}},
 {character_id:'c',plan_date:'2026-09-10',context:{day}},
 ]);},
});
const query=(date='2026-09-09',ids=['c'],key='test')=>gateway(new Request('https://test?action=presence-days&date='+date+'&characterIds='+encodeURIComponent(JSON.stringify(ids)),{headers:{'x-ai-phone-service-key':key}}));
let response=await query();assert.equal(response.status,200);const data=await response.json();assert.equal(data.rows.length,1);
assert.equal(data.rows[0].characterId,'c');assert.equal(JSON.stringify(data).includes('must-not-return'),false);
assert.equal((await query('2026-02-31')).status,400);assert.equal((await query('2026-09-09',['c&bad'])).status,400);
assert.equal((await query('2026-09-09',['c'],'wrong')).status,401);
failed=true;assert.equal((await query()).status,503);assert.ok(calls.every(c=>(c.init.method||'GET')==='GET'));
console.log('PASS authenticated schedule endpoint isolates dates/roles and does not return template data');

for(const fail of [false,true]){
 const {h,run}=recheckFixture();h.broadcastFails=fail;
 Object.assign(h.plan.context,{selfImpulseCap:3,selfSilenceMin:30,impulseMode:1,echoOn:0,quota:4});
 h.mirrors=[{id:'old-user',role:'user',content:'晚点聊',message_at:new Date(h.now-4*3600000).toISOString()}];
 await run();assert.ok(h.broadcasts.length);assert.equal(h.broadcasts[0].messages[0].private,true);
 assert.equal(Object.keys(h.broadcasts[0].messages[0].payload).length,0);assert.equal(h.plan.context.selfUsed,1);
}
console.log('PASS actual cloud worker emits private data-free change signals; broadcast failure does not undo the saved plan');
