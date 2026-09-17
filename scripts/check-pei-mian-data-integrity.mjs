import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import * as PmStats from '../custom-apps/pei-mian/src/domain/stats.mjs';
const read=f=>fs.readFileSync(new URL('../custom-apps/pei-mian/src/'+f,import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
 let now=Date.parse('2026-09-12T22:00:00Z'),i=0;const tables={settings:[],nights:[],library:[],mixes:[]},nodes=new Map(),events=new Map();const state={nights:[],library:[],mixes:[],character:{id:'c'},voiceReady:false};
 class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const api={db:{list:async(t,{limit})=>structuredClone(tables[t].slice(0,limit)),create:async(t,d)=>{const row={...structuredClone(d),id:'id'+ ++i};tables[t].unshift(row);return structuredClone(row);},update:async(t,id,d)=>{const r=tables[t].find(x=>x.id===id);if(!r)return null;Object.assign(r,structuredClone(d));return structuredClone(r);},delete:async(t,id)=>{tables[t]=tables[t].filter(x=>x.id!==id);return true;}},media:{delete:async()=>{},put:async()=>({ref:'media-store://x'})},voice:{stopPlayback:async()=>{},stopSTT:async()=>{}},user:{getProfile:async()=>({})}};
 const c=vm.createContext({structuredClone,Object,Array,Map,Set,JSON,Promise,Error,Number,String,Math,Date:Clock,PmStats,PmMixer:{MAX_LAYERS:6},state,api,on:(n,fn)=>events.set(n,fn),emit:(n)=>events.get(n)?.(),fail(){},console,$:id=>{if(!nodes.has(id))nodes.set(id,{classList:{add(){},remove(){},toggle(){}},textContent:''});return nodes.get(id);},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},fmtClock:()=>'',findSound:()=>null,script:{cancelPreview:async()=>{}},engine:{stop:async()=>{},isPlaying:()=>false},sleep:()=>new Promise(()=>{})});
 vm.runInContext(read('data/storage.js')+'\n'+read('session/sleep.js')+'\nglobalThis.sessionApi=session;',c);
 return {c,state,tables,api,advance:ms=>{now+=ms;}};
}
{
 const h=fixture();await h.c.loadSettings();h.state.settings.morningOn=false;h.state.settings.syncChat=false;
 await h.c.sessionApi.start({mode:'sound',timerMin:0});h.advance(2*3600000);await h.c.sessionApi.stop();await h.c.sessionApi.wake(h.state.nights[0],{rating:3,note:'一段'});
 h.advance(3600000);await h.c.sessionApi.start({mode:'sound',timerMin:0});h.advance(3*3600000);await h.c.sessionApi.stop();await h.c.sessionApi.wake(h.state.nights[0],{rating:4,note:'二段'});
 assert.equal(h.tables.nights.length,1);assert.equal(h.state.nights[0].durationMin,300);assert.equal(h.state.nights[0].wakeups,1);assert.equal(h.state.nights[0].sleepIntervals.length,2);
 console.log('PASS same-night reopen: one row, 5 sleeping hours, awake hour excluded');
}
{
 const rows=[{id:'a',date:'2026-09-12',sleepAt:'2026-09-12T22:00:00Z',wakeAt:'2026-09-13T01:00:00Z',note:'旧备注'}, {id:'b',date:'2026-09-12',sleepAt:'2026-09-13T00:00:00Z',wakeAt:'2026-09-13T03:00:00Z',note:'新备注'}];
 const [n]=PmStats.uniqueNights(rows);assert.equal(n.durationMin,300);assert.equal(n.note,'旧备注\n新备注');assert.deepEqual(n.mergedNightIds,['a']);
 assert.equal(PmStats.uniqueNights([n,...rows.filter(r=>r.id!==n.id)]).length,1);assert.equal(PmStats.uniqueNights([n,...rows.filter(r=>r.id!==n.id)])[0].durationMin,300);
 const h=fixture();h.tables.nights.push(...structuredClone(rows));await h.c.loadNights();await h.c.upsertNight(h.state.nights[0]);await h.c.loadNights();assert.equal(h.state.nights.length,1);assert.equal(h.tables.nights.length,2,'legacy raw rows retained');
 console.log('PASS legacy duplicates: interval union, notes retained, stable reload without deleting raw rows');
}
{
 const h=fixture();await h.c.loadSettings();h.state.settings.currentMix.layers.push({key:'rain',volume:.6});await h.api.db.update('settings',h.state.settings.id,{weeklyLines:{old:'周评'}});
 h.tables.nights=Array.from({length:501},(_,i)=>({id:'n'+i}));h.tables.library=Array.from({length:501},(_,i)=>({id:'l'+i,mediaRef:'ref'+i}));
 await h.c.resetAll();await h.c.loadSettings();assert.equal(h.tables.nights.length,0);assert.equal(h.tables.library.length,0);assert.equal(h.tables.settings.length,1);assert.equal(h.state.settings.weeklyLines,undefined);assert.equal(h.state.settings.currentMix.layers.length,0);
 const oldEpoch=vm.runInContext('dataEpoch',h.c);await h.c.resetAll();await assert.rejects(h.c.writeData(()=>h.api.db.create('library',{key:'late'}),oldEpoch),/取消/);assert.equal(h.tables.library.length,0);
 await h.api.db.update('settings',h.state.settings.id,{currentMix:{layers:[{key:'x'},{key:'x'},...Array.from({length:8},(_,i)=>({key:'s'+i}))]}});await h.c.loadSettings();assert.equal(h.state.settings.currentMix.layers.length,6);assert.equal(new Set(h.state.settings.currentMix.layers.map(l=>l.key)).size,6);
 console.log('PASS reset >500 records, weekly text/default pollution removed, old writes rejected, saved layers normalized');
}
{
 const h=fixture();await h.c.loadSettings();const d=defer();h.api.media.put=()=>d.promise;h.c.SOUND_SOURCES={};h.c.BUILTIN_SOUNDS=[];
 vm.runInContext(read('audio/store.js').replace('  return { search,','  globalThis.persistForTest = persistSound;\n  return { search,'),h.c);
 const epoch=vm.runInContext('dataEpoch',h.c);const pending=h.c.persistForTest('data:audio/wav;base64,AA==',{key:'late'},epoch);await flush();
 const reset=h.c.resetAll();d.resolve({ref:'late'});await assert.rejects(pending,/取消/);await reset;assert.equal(h.tables.library.length,0);
 console.log('PASS reset during media upload leaves no late library record');
}
// Run real toggle/applyPreset with rendering replaced by no-ops only.
{
 const h=fixture();await h.c.loadSettings();const gates=new Map();h.c.PmMixer={MAX_LAYERS:6};h.c.toast=()=>{};h.c.findSound=key=>({key,user:false,ready:false});h.c.store={ensureBuiltin:s=>{if(!gates.has(s.key))gates.set(s.key,defer());return gates.get(s.key).promise;},ensureAll:async()=>{}};
 let code=read('ui/sounds.js');code=code.replace('  return { render, bind };','  globalThis.actions={toggle,applyPreset}; renderLayers=()=>{}; renderTiles=()=>{}; renderPresets=()=>{};\n  return { render, bind };');vm.runInContext(code,h.c);
 const a=h.c.actions.toggle('x'),b=h.c.actions.toggle('x');gates.get('x').resolve({});await Promise.all([a,b]);assert.equal(h.state.settings.currentMix.layers.length,1);
 h.state.settings.currentMix.layers=[];const jobs=Array.from({length:7},(_,i)=>h.c.actions.toggle('s'+i));for(const d of gates.values())d.resolve({});await Promise.all(jobs);assert.equal(h.state.settings.currentMix.layers.length,6);assert.equal(new Set(h.state.settings.currentMix.layers.map(l=>l.key)).size,6);
 h.state.settings.currentMix.layers=[];const pending=h.c.actions.toggle('old');await h.c.actions.applyPreset({name:'new',layers:[{key:'new',volume:.5}]});gates.get('old').resolve({});await pending;assert.deepEqual(Array.from(h.state.settings.currentMix.layers,l=>l.key),['new']);
 console.log('PASS repeated click, seven parallel downloads, old download after preset switch');
}
