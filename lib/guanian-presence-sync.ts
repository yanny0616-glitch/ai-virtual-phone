import { RealtimeClient } from '@supabase/realtime-js';
import { loadInstalledCustomApps, readCustomAppCollection, CUSTOM_APPS_UPDATED_EVENT, CUSTOM_APP_DATA_UPDATED_EVENT } from './custom-app-storage';
import { getChatPluginVar, setChatPluginVar, unsetChatPluginVar, CHAT_PLUGIN_VARS_CHANGED_EVENT } from './chat-plugin-storage';
import { normalizeReplyGate, setCustomAppReplyGate } from './chat-reply-gate';
import { calculateGuanianPresence, guanianPresenceGate, presenceDate, type PresenceDay, type PresenceSettings } from './guanian-presence';
import { kvGet, kvSet, registerKvMigration } from './kv-db';

const CACHE_KEY='guanian_presence_days_v1';
registerKvMigration(CACHE_KEY);
const SOURCE='guanian-host';
type CloudDay={characterId:string;date:string;day:PresenceDay;updatedAt:string;version:number;settings:PresenceSettings};
type Cache={url:string;checkedAt:number;rows:CloudDay[]};
type Target={appId:string;characterId:string;settings:Record<string,unknown>;local:PresenceDay|null;previous:PresenceDay|null;localChangedAt:number;localVersion:number};
let stopCurrent:(()=>void)|null=null;

/** Runs only while the host is visible. Reads schedules, never invokes a model or mutates app plans. */
export function startGuanianPresenceSync():()=>void {
  stopCurrent?.();
  let disposed=false,running=false,again=false,publishing=false,lastCloud=0;
  const controllers=new Set<AbortController>();
  const connections=new Map<string,{url:string;key:string;client:RealtimeClient}>();
  const managed=new Map<string,string>();
  const gateSignatures=new Map<string,string>();
  const errors=new Map<string,string>();
  let currentTargets:Target[]=[];
  let targetDate="";
  let cache:Record<string,Cache>={};
  try{cache=JSON.parse(kvGet(CACHE_KEY)||'{}');}catch{cache={};}
  if(!cache||typeof cache!=='object'||Array.isArray(cache))cache={};
  function targets():Target[]{
    const now=Date.now(),today=presenceDate(now),y=new Date(now);y.setDate(y.getDate()-1);const yesterday=presenceDate(y.getTime());
    const result=new Map<string,Target>();
    for(const app of loadInstalledCustomApps()){
      if(app.manifest.id!=='gua.nian'||!app.permissions.includes('chat.context'))continue;
      const settings=readCustomAppCollection(app.id,'settings')[0];if(!settings)continue;
      const ids=Array.isArray(settings.characterIds)?settings.characterIds:[settings.characterId];
      const days=readCustomAppCollection(app.id,'days');
      const plans=readCustomAppCollection(app.id,'plans');
      for(const id of ids){
        if(typeof id!=='string'||!id)continue;
        const local=days.find(d=>d.characterId===id&&d.date===today);
        result.set(id,{appId:app.id,characterId:id,settings,local:(local as PresenceDay)||null,
          previous:(days.find(d=>d.characterId===id&&d.date===yesterday) as PresenceDay)||null,
          localChangedAt:Date.parse(String(local?.updatedAt||local?.createdAt||''))||0,
          localVersion:Number(plans.find(p=>p.characterId===id&&p.date===today)?.cloudStateVersion)||0});
      }
    }
    return [...result.values()];
  }
  const config=(t:Target)=>({url:String(t.settings.cloudUrl||'').trim().replace(/\/+$/,''),key:String(t.settings.cloudKey||'')});
  function publish(list:Target[]){
    if(disposed||document.visibilityState==='hidden')return;
    const selected=new Set(list.map(t=>t.characterId));
    publishing=true;
    try{
      for(const [cid,appId]of managed)if(!selected.has(cid)){
        const p=getChatPluginVar('presence','character',cid) as Record<string,unknown>|null;
        if(p?.managedBy===SOURCE)unsetChatPluginVar('presence','character',cid);
        setCustomAppReplyGate(appId,cid,null);managed.delete(cid);gateSignatures.delete(cid);
      }
      for(const t of list){
        const priorApp=managed.get(t.characterId);
        if(priorApp&&priorApp!==t.appId){setCustomAppReplyGate(priorApp,t.characterId,null);gateSignatures.delete(t.characterId);}
        const now=Date.now(),today=presenceDate(now),cfg=config(t),saved=cache[t.appId];
        const cloud=saved?.url===cfg.url&&Array.isArray(saved.rows)?saved.rows:[];
        const latest=cloud.find(r=>r.characterId===t.characterId&&r.date===today);
        const sync=(t.settings.planSync as Record<string,{date?:string;at?:number;status?:string}>|undefined)?.[t.characterId];
        // Unsynced local edits must never be replaced by an older server snapshot.
        const localDirty=!!t.local&&(!sync||sync.date!==today||sync.status!=='synced'||t.localChangedAt>Number(sync.at||0)||!!latest&&Number(latest.version||0)<t.localVersion);
        const day=localDirty?t.local:latest?.day||t.local;
        const yd=new Date(now);yd.setDate(yd.getDate()-1);
        const prev=cloud.find(r=>r.characterId===t.characterId&&r.date===presenceDate(yd.getTime()))?.day||t.previous;
        const settings=(!localDirty&&latest?.settings)||t.settings;
        const value=calculateGuanianPresence(day,prev,settings,now);
        const presence={...(value||{at:now,state:'away',label:'状态待同步',doing:'',asleep:false,busy:false}),
          managedBy:SOURCE,appId:t.appId,syncStatus:errors.has(t.appId)?'cached':latest&&!localDirty?'synced':'local',
          syncAt:saved?.url===cfg.url?saved.checkedAt:0};
        const old=getChatPluginVar('presence','character',t.characterId) as Record<string,unknown>|null;
        const comparable=(p:Record<string,unknown>|null)=>{const v={...p};delete v.at;return JSON.stringify(v);};
        if(comparable(old)!==comparable(presence)||now-Number(old?.at||0)>=60000)setChatPluginVar('presence',presence,'character',t.characterId);
        const availability=guanianPresenceGate(day,prev,settings,now);
        const st=t.settings;
        const raw=availability?{...availability,legacyReplySettings:{
          enabled:st.replyGate!==false,adaptive:st.smartBusyReply!==false,peekMin:st.busyPeekMin??3,
          focusedPeekProb:st.focusedPeekProb??25,sleepMode:st.sleepMode===2?'chance':'wait',
          wakeProb:st.sleepWakeProb??18,wakeBufferMin:st.busyBufferMin??10,
        }}:null;
        const sig=JSON.stringify(raw?{...raw,updatedAt:0}:null);
        if(gateSignatures.get(t.characterId)!==sig){
          setCustomAppReplyGate(t.appId,t.characterId,normalizeReplyGate(raw));gateSignatures.set(t.characterId,sig);
        }
        managed.set(t.characterId,t.appId);
      }
    }finally{publishing=false;}
  }
  function disconnect(){for(const c of connections.values())c.client.disconnect();connections.clear();}
  function connect(list:Target[]){
    const active=new Set<string>();
    for(const t of list){
      const {url,key}=config(t);if(!/^https:\/\//.test(url)||!key)continue;
      active.add(t.appId);const old=connections.get(t.appId);
      if(old?.url===url&&old.key===key)continue;
      old?.client.disconnect();
      try {
      const client=new RealtimeClient(url.replace(/^http/,'ws')+'/realtime/v1',{params:{apikey:key},accessToken:async()=>key,heartbeatIntervalMs:25000});
      connections.set(t.appId,{url,key,client});
      // Notifications contain no schedule data; always re-read through the authenticated gateway.
      client.channel('guanian-presence:owner',{config:{private:true,broadcast:{self:false,ack:false}}})
        .on('broadcast',{event:'changed'},()=>{void refresh(true);})
        .subscribe(status=>{if(status==='SUBSCRIBED')void refresh(true);});
      } catch { connections.get(t.appId)?.client.disconnect();connections.delete(t.appId); }
    }
    for(const [id,c]of connections)if(!active.has(id)){c.client.disconnect();connections.delete(id);}
  }
  async function refresh(force=false){
    if(disposed||document.visibilityState==='hidden')return;
    force=force||targetDate!==presenceDate(Date.now());
    if(!force&&targetDate===presenceDate(Date.now())&&Date.now()-lastCloud<60000){publish(currentTargets);return;}
    if(running){again=again||force;return;}
    running=true;
    try{
      const list=targets();currentTargets=list;targetDate=presenceDate(Date.now());publish(list);connect(list);
      if(!force&&Date.now()-lastCloud<60000)return;
      lastCloud=Date.now();
      const groups=new Map<string,Target[]>();for(const t of list)groups.set(t.appId,[...(groups.get(t.appId)||[]),t]);
      await Promise.all([...groups].map(async([appId,group])=>{
        const {url,key}=config(group[0]);if(!/^https:\/\//.test(url)||!key)return;
        const ids=group.map(t=>t.characterId),date=presenceDate(Date.now());
        const controller=new AbortController();controllers.add(controller);
        const timeout=window.setTimeout(()=>controller.abort(),10000);
        try{
          const q=new URLSearchParams({action:'presence-days',date,characterIds:JSON.stringify(ids)});
          const response=await fetch(url+'/functions/v1/ai-phone-push?'+q,{headers:{'x-ai-phone-service-key':key},signal:controller.signal,cache:'no-store'});
          const result=await response.json();
          if(!response.ok||!result.ok||result.date!==date||!Array.isArray(result.rows))throw Error('schedule sync failed');
          const current=targets().find(t=>t.appId===appId);
          if(disposed||!current||config(current).url!==url||config(current).key!==key||presenceDate(Date.now())!==date)return;
          const rows=result.rows.filter((r:CloudDay)=>ids.includes(r.characterId)&&r.day&&typeof r.day==='object'&&!Array.isArray(r.day));
          cache[appId]={url,checkedAt:Date.now(),rows};errors.delete(appId);kvSet(CACHE_KEY,JSON.stringify(cache));
        }catch{if(!disposed&&document.visibilityState!=='hidden')errors.set(appId,'同步失败，使用已保存日程');}
        finally{window.clearTimeout(timeout);controllers.delete(controller);}
      }));
      publish(currentTargets);
    }finally{running=false;if(again){again=false;void refresh(true);}}
  }
  const onChange=()=>{currentTargets=targets();targetDate=presenceDate(Date.now());publish(currentTargets);void refresh(true);};
  const onData=(event:Event)=>{const d=(event as CustomEvent).detail;if(d?.collection==='days'||d?.collection==='settings')onChange();};
  const onVars=(event:Event)=>{if(!publishing&&(event as CustomEvent).detail?.name==='presence')publish(currentTargets);};
  const onVisibility=()=>{if(document.visibilityState==='hidden'){disconnect();for(const c of controllers)c.abort();}else onChange();};
  window.addEventListener(CUSTOM_APP_DATA_UPDATED_EVENT,onData);window.addEventListener(CUSTOM_APPS_UPDATED_EVENT,onChange);
  window.addEventListener(CHAT_PLUGIN_VARS_CHANGED_EVENT,onVars);window.addEventListener('guanian-presence-refresh',onChange);
  window.addEventListener('online',onChange);document.addEventListener('visibilitychange',onVisibility);
  // Wall-clock calculation is local; only the 60-second refresh performs network IO.
  const clock=window.setInterval(()=>{void refresh();},1000);
  void refresh(true);
  const stop=()=>{
    disposed=true;disconnect();for(const c of controllers)c.abort();window.clearInterval(clock);
    window.removeEventListener(CUSTOM_APP_DATA_UPDATED_EVENT,onData);window.removeEventListener(CUSTOM_APPS_UPDATED_EVENT,onChange);
    window.removeEventListener(CHAT_PLUGIN_VARS_CHANGED_EVENT,onVars);window.removeEventListener('guanian-presence-refresh',onChange);
    window.removeEventListener('online',onChange);document.removeEventListener('visibilitychange',onVisibility);
    if(stopCurrent===stop)stopCurrent=null;
  };
  stopCurrent=stop;return stop;
}
