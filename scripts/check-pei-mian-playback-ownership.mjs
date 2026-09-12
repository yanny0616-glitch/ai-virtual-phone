import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const read = f => fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const source=read('components/app-market/custom-app-runner.tsx');
const play=source.slice(source.indexOf('    if (action === "voice.play")'),source.indexOf('    if (action === "media.put")'));
const stop=source.slice(source.indexOf('    if (action === "voice.stopPlayback")'),source.indexOf('    if (action === "voice.pausePlayback")'));
function host() {
 const channels=new Map(),media=new Map(),urls=new Set();let urlId=0;const h={channels,media,urls,plays:[],nextPlay:null};
 const cleanup=source.slice(source.indexOf('function cleanupFrameAudioChannel('),source.indexOf('// iOS 的播放解锁'));
 const c=vm.createContext({Number,Math,Promise,Error,String,URL:{createObjectURL:()=>{const u='blob:'+ ++urlId;urls.add(u);return u;},revokeObjectURL:u=>urls.delete(u)},requirePermission(){},normalizeFrameAudioChannelName:x=>x||'voice',isMediaStoreRef:x=>x.startsWith('media-store://'),loadMediaBlob:ref=>media.get(ref)?.promise??Promise.resolve({blob:{}}),frameAudioChannelsRef:{current:channels},getFrameAudioChannel:k=>{
  if(!channels.has(k))channels.set(k,{revision:0,settle:null,objectUrl:null,el:{src:'',running:false,pause(){this.running=false;},removeAttribute(){this.src='';},load(){},play(){this.running=true;h.plays.push(this.src);const p=h.nextPlay;h.nextPlay=null;return p?.promise??Promise.resolve();}}});return channels.get(k);
 }});
 vm.runInContext(stripTypeScriptTypes(cleanup+'\nasync function dispatch(action,record){'+play+stop+'}'),c);h.dispatch=c.dispatch;
 const cleanupStart=source.indexOf('      for (const entry of channels.values())');const cleanupEnd=source.indexOf('      for (const url of objectUrls)',cleanupStart);
 h.unmount=()=>{c.channels=channels;vm.runInContext(source.slice(cleanupStart,cleanupEnd),c);};return h;
}
for(const mode of ['stop','new-play','unmount']){
 const h=host(),d=deferred();h.media.set('media-store://old',d);
 const old=h.dispatch('voice.play',{channel:'ambience',dataUrl:'media-store://old',loop:true});await flush();
 if(mode==='stop')await h.dispatch('voice.stopPlayback',{channel:'ambience'});
 if(mode==='new-play')await h.dispatch('voice.play',{channel:'ambience',dataUrl:'data:audio/wav;base64,new',loop:true});
 if(mode==='unmount')h.unmount();
 d.resolve({blob:{}});assert.equal((await old).cancelled,true);assert.equal(h.plays.length,mode==='new-play'?1:0);assert.equal(h.urls.size,0);
 console.log('PASS pending media invalidated by '+mode);
}
for(const loop of [true,false]){
 const h=host(),d=deferred();h.nextPlay=d;
 const old=h.dispatch('voice.play',{channel:'voice',dataUrl:'data:audio/wav;base64,old',loop});await flush();
 await h.dispatch('voice.play',{channel:'voice',dataUrl:'data:audio/wav;base64,new',loop:true});d.reject(Error('late failure'));
 assert.equal((await old).cancelled,true);assert.equal(h.channels.get('voice').el.running,true);assert.equal(h.channels.get('voice').el.src,'data:audio/wav;base64,new');
 console.log('PASS stale '+(loop?'loop':'one-shot')+' playback rejection preserves new audio');
}
{
 const h=host();const p=h.dispatch('voice.play',{dataUrl:'media-store://normal',loop:false});await flush();assert.equal(h.urls.size,1);h.channels.get('voice').el.onended();assert.equal((await p).ok,true);assert.equal(h.urls.size,0);console.log('PASS normal completion releases object URL');
}
function preview() {
 const nodes=new Map(),events=new Map();let active=false;const h={plays:[],ttsCalls:[],generate:async()=>({text:'test'}),tts:async()=>({dataUrl:'speech'}),stop:async()=>{},};
 const $=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,disabled:false,textContent:'',value:'',style:{},classList:{},appendChild(){}});return nodes.get(id);};
 const state={view:'script',character:{id:'a',name:'A'},settings:{rhythm:{},directions:[],ttsOn:true}};
 const c=vm.createContext({console,state,$,PmRhythm:{normalizeRhythm:x=>x,buildSchedule:()=>[{chars:10}],DIRECTIONS:[],RHYTHM_PRESETS:{}},esc:x=>x,fmtClock:()=>'',Date,toast(){},fail(){},on:(n,f)=>events.set(n,f),saveSettings(){},session:{active:()=>active},api:{ai:{generate:p=>h.generate(p)},voice:{tts:p=>{h.ttsCalls.push(p);return h.tts(p);},play:p=>{h.plays.push(p);return new Promise(()=>{});},stopPlayback:()=>h.stop()}}});
 vm.runInContext(read('custom-apps/pei-mian/src/ui/script.js')+'\nglobalThis.s=script;',c);c.s.bind();h.click=()=>$('#btn-try-line'.slice(1)).onclick();h.cancel=c.s.cancelPreview;h.state=state;h.nodes=nodes;h.events=events;h.start=async()=>{await h.cancel();active=true;};return h;
}
for(const phase of ['generate','tts'])for(const reason of ['leave','session','character']){
 const h=preview(),d=deferred();h[phase]=()=>d.promise;const pending=h.click();await flush();
 if(reason==='leave'){h.state.view='home';h.events.get('view')('home');}
 if(reason==='session')await h.start();
 if(reason==='character'){h.state.character={id:'b',name:'B'};h.events.get('character')();}
 d.resolve(phase==='generate'?{text:'late'}:{dataUrl:'late'});await pending;assert.equal(h.plays.length,0);if(phase==='generate')assert.equal(h.ttsCalls.length,0);if(phase==='tts')assert.equal(h.ttsCalls[0].characterId,'a');
 console.log('PASS trial '+phase+' discarded after '+reason);
}
{
 const h=preview(),d=deferred();void h.click();await flush();assert.equal(h.plays.length,1);h.stop=()=>d.promise;
 let started=false;const start=h.start().then(()=>{started=true;});await flush();assert.equal(started,false);d.resolve({ok:true});await start;assert.equal(started,true);console.log('PASS formal session waits for trial audio stop');
}
