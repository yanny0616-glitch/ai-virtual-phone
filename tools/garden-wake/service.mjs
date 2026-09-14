import http from 'node:http';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {loadConfig,runBridge}=await import(pathToFileURL(`${process.env.GARDEN_BRIDGE_ROOT||'/root/vibe-coding/float/galatea-garden-wake-bridge'}/dist/index.js`).href);

export class WakeStore {
 constructor(path){this.path=path;this.data={config:null,events:[]};}
 async load(){await mkdir(this.path,{recursive:true,mode:0o700});try{this.data=JSON.parse(await readFile(`${this.path}/state.json`,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
 async save(){const tmp=`${this.path}/state.tmp`;await writeFile(tmp,JSON.stringify(this.data),{mode:0o600});await rename(tmp,`${this.path}/state.json`);}
 async enqueue(input){
  if(!input.message?.trim()||input.message.length>4096||!input.reason?.trim()||input.reason.length>128)throw Error('Invalid wake envelope');
  const c=this.data.config;if(!c)throw Error('No target configured');
  // Wake messages are hints; coalesce identical outstanding hints, never a consumed event.
  if(this.data.events.some(e=>e.characterId===c.characterId&&e.message===input.message&&e.reason===input.reason))return;
  if(this.data.events.length>=200)throw Error('Wake inbox full');
  this.data.events.push({id:randomUUID(),characterId:c.characterId,serverId:c.serverId,mode:c.mode,message:input.message,reason:input.reason,createdAt:new Date().toISOString()});
  try{await this.save();}catch(error){this.data.events.pop();throw error;}
 }
}
export async function startService({dir='/var/lib/float-garden-wake',port=18062,secretPath='/etc/float-garden-wake/backend-token'}={}){
 const secret=(await readFile(secretPath,'utf8')).trim();const store=new WakeStore(dir);await store.load();
 let controller=null,run=null,status='stopped',lastError='',serial=Promise.resolve();
 const exclusive=fn=>{const p=serial.then(fn);serial=p.catch(()=>{});return p;};
 const stop=async()=>{controller?.abort();await run;controller=null;run=null;status='stopped';};
 const view=()=>({ok:true,status,lastError,pending:store.data.events.length,config:store.data.config?{...store.data.config,token:undefined,hasToken:Boolean(store.data.config.token)}:null});
 const logger={debug(){},info(message){if(message==='Garden SSE connected')status='connected';},warn(){},error(){}};
 const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const supplied=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${secret}`);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(401,{error:'Unauthorized'});
  if(req.method!=='POST')return send(405,{error:'POST required'});
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw Error('Request too large');}
   const b=JSON.parse(raw||'{}');
   // stop must not hold the queue lock while the bridge is persisting an event.
   if(['save','stop','clear'].includes(b.action))await stop();
   const result=await exclusive(async()=>{
    let acceptedIds;
    if(b.action==='save'){
     if(typeof b.characterId!=='string'||!b.characterId||b.characterId.length>150||typeof b.serverId!=='string'||!b.serverId||b.serverId.length>150||!['auto','receive'].includes(b.mode))throw Error('请选择角色和处理方式');
     const token=typeof b.token==='string'&&b.token.trim()?b.token.trim().replace(/^Bearer\s+/i,''):store.data.config?.token;
     if(!token||token.length>12000)throw Error('请配置花园 Machine Token');
     store.data.config={characterId:b.characterId,serverId:b.serverId,mode:b.mode,token};await store.save();lastError='';
    }else if(b.action==='start'){
     if(run)throw Error('已经连接或正在连接');
     const c=store.data.config;if(!c?.token)throw Error('请先保存配置');
     controller=new AbortController();status='connecting';lastError='';
     const config=loadConfig({GARDEN_MACHINE_TOKEN:c.token,GARDEN_BASE_URL:'https://wake-v1.abysslumina.com'});
     const signal=controller.signal;
     run=runBridge(config,{wake:input=>exclusive(()=>store.enqueue(input))},logger,signal).catch(()=>{lastError='花园连接已中断或被拒绝，请检查 Token 和服务状态后手动启动。';}).finally(()=>{status='stopped';run=null;controller=null;});
    }else if(b.action==='clear'){store.data={config:null,events:[]};await store.save();lastError='';
    }else if(b.action==='ack'){
     if(!Array.isArray(b.ids)||b.ids.length>20)throw Error('Invalid acknowledgement');
     const previous=store.data.events;acceptedIds=previous.filter(e=>b.ids.includes(e.id)).map(e=>e.id);
     store.data.events=previous.filter(e=>!b.ids.includes(e.id));
     try{await store.save();}catch(error){store.data.events=previous;throw error;}
    }else if(!['status','events','stop'].includes(b.action))throw Error('Unknown action');
    return {...view(),...(acceptedIds?{acceptedIds}:{}),...(b.action==='events'?{events:store.data.events.slice(0,20)}:{})};
   });send(200,result);
  }catch{send(400,{error:'操作失败，请检查配置；服务未自动重连。'});}
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
 const shutdown=async()=>{await stop();server.close();};process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 return {server,store,shutdown};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await startService();
