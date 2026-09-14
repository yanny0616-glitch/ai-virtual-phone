import http from 'node:http';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {randomUUID,randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {GARDEN_MCP_URL,startGarden} from './adapters/garden.mjs';
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const validText=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export class EventStore{
 constructor(path){this.path=path;this.data={version:2,sources:{},events:[],receipts:[]};}
 async load(){
  await mkdir(this.path,{recursive:true,mode:0o700});
  try{
   const old=JSON.parse(await readFile(`${this.path}/state.json`,'utf8'));
   if(old.version===2){this.data=old;return;}
   const c=old.config;
   if(c)this.data.sources[c.serverId]={...c,adapter:'garden',serverUrl:GARDEN_MCP_URL,ingressToken:randomBytes(32).toString('hex')};
   this.data.events=(old.events||[]).map(e=>({...e,sourceId:e.serverId,serverUrl:GARDEN_MCP_URL,messageId:`garden_wake_${e.id}`}));
   await this.save();
  }catch(e){if(e.code!=='ENOENT')throw e;}
 }
 async save(){await writeFile(`${this.path}/state.tmp`,JSON.stringify(this.data),{mode:0o600});await rename(`${this.path}/state.tmp`,`${this.path}/state.json`);}
 async transaction(fn){const previous=structuredClone(this.data);try{const result=fn();await this.save();return result;}catch(error){this.data=previous;throw error;}}
 async enqueue(sourceId,input){
  const c=this.data.sources[sourceId];if(!c)throw fail('来源未配置',404);
  if(!validText(input.message,4096)||!validText(input.reason,128))throw fail('message/reason 格式无效');
  if(input.eventId!==undefined&&!validText(input.eventId,200))throw fail('eventId 格式无效');
  const key=input.eventId?createHash('sha256').update(JSON.stringify([sourceId,input.eventId])).digest('hex'):null;
  if(key&&this.data.receipts.some(r=>r.key===key))return {duplicate:true};
  // Garden wake events are hints with no delivery ID: coalesce only identical outstanding hints.
  if(!key&&this.data.events.some(e=>e.sourceId===sourceId&&e.message===input.message&&e.reason===input.reason))return {duplicate:true};
  if(this.data.events.length>=200)throw fail('待处理事件已满，请先收件',429);
  return this.transaction(()=>{
   const id=randomUUID();
   this.data.events.push({id,messageId:`tool_event_${id}`,sourceId,serverId:c.serverId,serverUrl:c.serverUrl,characterId:c.characterId,mode:c.mode,message:input.message,reason:input.reason,createdAt:new Date().toISOString()});
   if(key){this.data.receipts.push({key});this.data.receipts=this.data.receipts.slice(-10000);}
   return {id,duplicate:false};
  });
 }
}
export async function startService({dir='/var/lib/float-garden-wake',port=18062,secretPath='/etc/float-garden-wake/backend-token',gardenFactory=startGarden}={}){
 const secret=(await readFile(secretPath,'utf8')).trim();const store=new EventStore(dir);await store.load();
 const connections=new Map();let serial=Promise.resolve(),management=Promise.resolve();
 const exclusive=fn=>{const task=serial.then(fn);serial=task.catch(()=>{});return task;};
 const manage=fn=>{const task=management.then(fn);management=task.catch(()=>{});return task;};
 const stop=async id=>{const c=connections.get(id);if(c){c.status='stopped';c.stop?.();await c.done?.catch(()=>{});connections.delete(id);}};
 const safeConfig=c=>c?{serverId:c.serverId,serverUrl:c.serverUrl,characterId:c.characterId,mode:c.mode,adapter:c.adapter,hasToken:Boolean(c.token)}:null;
 const view=id=>({ok:true,status:connections.get(id)?.status||'stopped',lastError:connections.get(id)?.error||'',pending:store.data.events.filter(e=>!id||e.sourceId===id).length,config:safeConfig(store.data.sources[id]),sources:Object.values(store.data.sources).map(safeConfig)});
 async function handle(b,authorization){
  if(b.action==='ingest')return exclusive(async()=>{
   const c=store.data.sources[b.sourceId];
   if(!c||c.adapter!=='webhook'||!equal(authorization,`Bearer ${c.ingressToken}`))throw fail('Unauthorized source',401);
   if(connections.get(b.sourceId)?.status!=='connected')throw fail('事件来源已停止',409);
   if(b.version!==1||!validText(b.eventId,200))throw fail('需要 version:1 和稳定的 eventId');
   return {ok:true,...await store.enqueue(b.sourceId,b)};
  });
  if(!equal(authorization,`Bearer ${secret}`))throw fail('Unauthorized',401);
  if(b.action==='events')return exclusive(()=>({...view(),events:store.data.events.filter(e=>connections.get(e.sourceId)?.status==='connected').slice(0,20)}));
  if(b.action==='ack')return exclusive(async()=>{
   if(!Array.isArray(b.ids)||b.ids.length>20)throw fail('Invalid acknowledgement');
   const acceptedIds=await store.transaction(()=>{const ids=store.data.events.filter(e=>b.ids.includes(e.id)&&connections.get(e.sourceId)?.status==='connected').map(e=>e.id);store.data.events=store.data.events.filter(e=>!ids.includes(e.id));return ids;});
   return {...view(),acceptedIds};
  });
  return manage(async()=>{
   // Legacy Garden clients may omit serverId; never select an unrelated source.
   const id=b.serverId||Object.values(store.data.sources).find(c=>c.adapter==='garden')?.serverId;
   if(['save','clear','stop'].includes(b.action))await stop(id);
   if(b.action==='save')await exclusive(async()=>{
    const adapter=b.adapter||'garden',url=b.serverUrl||(adapter==='garden'?GARDEN_MCP_URL:'');
    if(!validText(id,150)||! /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)||['constructor','prototype','__proto__'].includes(id)||!validText(b.characterId,150)||!validText(url,2000)||!['auto','receive'].includes(b.mode)||!['garden','webhook'].includes(adapter))throw fail('请选择来源、角色和处理方式');
    if(adapter==='garden'&&url.replace(/\/$/,'')!==GARDEN_MCP_URL)throw fail('花园适配器只适用于花园 MCP');
    const old=store.data.sources[id];
    if(!old&&Object.keys(store.data.sources).length>=32)throw fail('最多配置32个来源');
    const token=typeof b.token==='string'&&b.token.trim()?b.token.trim().replace(/^Bearer\s+/i,''):(old?.adapter===adapter&&old?.serverUrl===url?old.token:'');
    if(adapter==='garden'&&(!token||token.length>12000))throw fail('请配置花园 Machine Token');
    await store.transaction(()=>{store.data.sources[id]={serverId:id,serverUrl:url,characterId:b.characterId,mode:b.mode,adapter,token:adapter==='garden'?token:undefined,ingressToken:old?.ingressToken||randomBytes(32).toString('hex')};});
   });
   else if(b.action==='start'){
    if(connections.get(id)?.status==='connected'||connections.get(id)?.status==='connecting')throw fail('来源已经启动');
    const c=store.data.sources[id];if(!c)throw fail('请先保存配置');
    if(c.adapter==='webhook')connections.set(id,{status:'connected'});
    else{
     const entry={status:'connecting'};connections.set(id,entry);
     try{
      const adapter=await gardenFactory(c,input=>exclusive(()=>store.enqueue(id,input)),status=>{entry.status=status;});
      entry.stop=adapter.stop;
      entry.done=adapter.done.catch(()=>{entry.error='花园连接中断或被拒绝，请检查后手动启动。';}).finally(()=>{entry.status='stopped';});
     }catch{entry.status='stopped';entry.error='花园适配器启动失败，请检查本机安装。';}
    }
   }else if(b.action==='clear')await exclusive(()=>store.transaction(()=>{delete store.data.sources[id];store.data.events=store.data.events.filter(e=>e.sourceId!==id);}));
   else if(b.action==='credentials'){
    const c=store.data.sources[id];if(c?.adapter!=='webhook')throw fail('只对 Webhook 来源提供投递凭据');
    return {...view(id),sourceId:id,ingressToken:c.ingressToken};
   }else if(!['status','stop'].includes(b.action))throw fail('Unknown action');
   return view(id);
  });
 }
 const server=http.createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(req.method!=='POST')return send(405,{error:'POST required'});
  try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw fail('Request too large',413);}send(200,await handle(JSON.parse(raw||'{}'),req.headers.authorization));}
  catch(e){send(e.status||400,{error:e.status?e.message:'操作失败，配置或存储不可用。'});}
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const shutdown=async()=>{await manage(async()=>{for(const id of connections.keys())await stop(id);});server.close();};
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 return {server,store,shutdown};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await startService();
