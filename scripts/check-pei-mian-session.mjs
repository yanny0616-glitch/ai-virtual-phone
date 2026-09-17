import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import * as PmRhythm from '../custom-apps/pei-mian/src/domain/rhythm.mjs';
import * as PmStats from '../custom-apps/pei-mian/src/domain/stats.mjs';
import * as PmMixer from '../custom-apps/pei-mian/src/domain/mixer.mjs';
const read = f => fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const flush = async () => { for(let i=0;i<40;i++) await Promise.resolve(); };
const deferred = () => { let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; };
function harness() {
 let now=Date.parse('2026-09-12T23:00:00Z'), next=0; const timers=new Map(), nodes=new Map();
 const h={plays:[],stops:[],requests:[],sttStops:[],saved:[],generate:async()=>({text:'晚安'}),tts:async()=>({dataUrl:'speech'}),stt:async()=>({text:'你好'})};
 class Clock extends Date {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
 const setTimeout=(fn,ms=0)=>{const id=++next;timers.set(id,{fn,at:now+ms});return id;};
 const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',classList:{add(){},remove(){},toggle(){}}});return nodes.get(id);};
 const state={character:{id:'c',name:'C'},voiceReady:true,nights:[],settings:{currentMix:{layers:[]},ttsOn:true,sttOn:true,syncChat:false,morningOn:false,directions:[],rhythm:PmRhythm.RHYTHM_PRESETS.long,fadeMin:5}};
 const api={user:{getProfile:async()=>({})},ai:{generate:p=>{h.requests.push(p);return h.generate(p);}},voice:{tts:p=>h.tts(p),play:async p=>{h.plays.push(p);},stopPlayback:async p=>{h.stops.push(p.channel);},stt:p=>h.stt(p),stopSTT:async p=>{h.sttStops.push(p);}},};
 const c=vm.createContext({console:{warn(){}},Math,Date:Clock,state,resetting:false,dataEpoch:0,dataCurrent:()=>true,$,PmRhythm,PmStats,fmtClock:()=>'',findSound:()=>null,script:{cancelPreview:async()=>{}},setTimeout,clearTimeout:id=>timers.delete(id),setInterval:()=>++next,clearInterval(){},sleep:ms=>new Promise(r=>setTimeout(r,ms)),upsertNight:async n=>{if(!n.id){n.id='n'+state.nights.length;state.nights.push(n);}h.saved.push({...n});},engine:{play:async()=>{},stop:async()=>{h.stops.push('ambience');},fadeOut:async()=>{}},api});
 vm.runInContext(read('custom-apps/pei-mian/src/session/sleep.js')+'\nglobalThis.s=session;',c);
 h.session=c.s;h.state=state;h.nodes=nodes;
 h.advance=async ms=>{const target=now+ms;await flush();for(;;){const due=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();await flush();}now=target;await flush();};return h;
}
for(const pending of ['generate','tts']) {
 const h=harness(), d=deferred();h[pending]=()=>d.promise;
 await h.session.start({mode:'lull',timerMin:0});await h.advance(4000);
 await h.session.stop();const segments=h.state.nights[0].segments;await h.session.start({mode:'sound',timerMin:0});
 d.resolve(pending==='generate'?{text:'旧回复'}:{dataUrl:'旧语音'});await flush();
 assert.equal(h.plays.length,0,`${pending}: old work must not play`);assert.equal(h.state.nights[0].segments,segments);await h.session.stop();
 console.log('PASS stale '+pending+' cannot enter restarted sound session');
}
{
 const h=harness();await h.session.start({mode:'lull',timerMin:15});await h.advance(15*60000);
 const count=h.requests.length;assert.ok(h.stops.includes('voice')&&h.stops.includes('ambience'));assert.equal(h.nodes.get('sleep-status').textContent,'声音停了，晚安');
 await h.advance(40*60000);assert.equal(h.requests.length,count,'no generation after deadline');await h.session.stop();
 console.log('PASS long speech schedule ends at 15 minute deadline');
}
{
 const h=harness(),d=deferred();h.tts=()=>d.promise;
 await h.session.start({mode:'lull',timerMin:15});await h.advance(15*60000);d.resolve({dataUrl:'late'});await flush();assert.equal(h.plays.length,0);await h.session.stop();
 console.log('PASS late TTS cannot play after deadline');
}
{
 const h=harness(),d=deferred();let requestId;h.stt=p=>{requestId=p.requestId;return d.promise;};
 await h.session.start({mode:'sound',timerMin:0});const listening=h.session.listen();await flush();await h.session.stopListening();assert.equal(h.sttStops[0].requestId,requestId);
 await h.session.stop();assert.equal(h.sttStops[1].cancel,true);d.resolve({text:'迟到识别'});await listening;assert.equal(h.requests.length,0);
 console.log('PASS STT release targets request and stop discards result');
}
// Real fadeSegment remains below media.put's base64 cap for all supported fade lengths.
for(const seconds of [60,120,300,600]) {
 const loop=[new Float32Array([1,1]),new Float32Array([1,1])];let previous=1;
 for(let offset=0;offset<seconds;offset+=20){const seg=PmMixer.fadeSegment(loop,seconds,offset);assert.equal(seg.length,2);assert.ok(seg[0].length<=20*44100);assert.ok(4*Math.ceil((44+seg[0].length*4)/3)<34000000);assert.ok(seg[0][0]<=previous+1e-7);previous=seg[0].at(-1);}
}
console.log('PASS 1/2/5/10 minute fade chunks fit media limit and envelope is continuous');
// Actual engine: fail the first fade upload after a successful loop; old loop must stop.
{
 let puts=0, stops=0;const c=vm.createContext({console,Float32Array,Map,Math,JSON,window:{},emit(){},on(){},findSound:()=>({key:'s',mediaRef:'data:audio/wav;base64,AA=='}),atob:()=>String.fromCharCode(0),Uint8Array,TextEncoder,
 PmMixer:{...PmMixer,mixLayers:()=>({channels:[new Float32Array([1]),new Float32Array([1])]})},PmWav:{wavDataUrl:()=> 'data:audio/wav;base64,AA=='},api:{media:{put:async()=>{if(++puts===2)throw Error('upload failed');return {ref:'loop'};},delete:async()=>{}},voice:{play:async()=>{},stopPlayback:async()=>{stops++;}}}});
 vm.runInContext(read('custom-apps/pei-mian/src/audio/engine.js').replace('const samples = await decode(sound);','const samples = [new Float32Array([1]), new Float32Array([1])];')+'\nglobalThis.e=engine;',c);
 await c.e.play({layers:[{key:'s',volume:1}]});await assert.rejects(c.e.fadeOut(300),/upload failed/);assert.equal(stops,1);assert.equal(c.e.isPlaying(),false);
 console.log('PASS failed fade upload stops old loop');
}
// Real host STT functions, mocked recognizer: final text, cancellation, app isolation.
{
 let callbacks,recognizerStops=0;const source=read('lib/custom-app-host-api.ts');const block=source.slice(source.indexOf('const customAppRecognitions'),source.indexOf('/**\n * voice.record'));
 const c=vm.createContext({Map,Error,String,Number,Math,cleanText:v=>String(v||''),resolveCustomAppVoiceConfig:()=>null,window:{setTimeout:()=>1,clearTimeout(){}},createSTTSession:cb=>{callbacks=cb;return {isSupported:true,start(){},abort(){},stop(){recognizerStops++;cb.onFinal('最终文字');}};}});
 vm.runInContext(stripTypeScriptTypes(block).replace(/export /g,''),c);
 const p=c.recognizeCustomAppSpeech({id:'a'},{requestId:'one'});assert.equal(c.stopCustomAppSpeechRecognition({id:'b'},{requestId:'one'}).ok,false);
 c.stopCustomAppSpeechRecognition({id:'a'},{requestId:'one'});assert.equal((await p).text,'最终文字');assert.equal(recognizerStops,1);
 const p2=c.recognizeCustomAppSpeech({id:'a'},{requestId:'two'});callbacks.onInterim('丢弃');c.stopCustomAppSpeechRecognition({id:'a'},{requestId:'two',cancel:true});assert.equal((await p2).text,'');
 console.log('PASS host STT final result, cancel and cross-app isolation');
}
