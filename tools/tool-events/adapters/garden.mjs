import {pathToFileURL} from 'node:url';
export const GARDEN_MCP_URL='https://galatea.abysslumina.com/mcp';
export async function startGarden(config,emit,onStatus){
 const {loadConfig,runBridge}=await import(pathToFileURL(`${process.env.GARDEN_BRIDGE_ROOT||'/root/vibe-coding/float/galatea-garden-wake-bridge'}/dist/index.js`).href);
 const controller=new AbortController();
 const logger={debug(){},info(message){if(message==='Garden SSE connected')onStatus('connected');},warn(){},error(){}};
 const options=loadConfig({GARDEN_MACHINE_TOKEN:config.token,GARDEN_BASE_URL:'https://wake-v1.abysslumina.com'});
 const done=runBridge(options,{wake:emit},logger,controller.signal);
 return {done,stop:()=>controller.abort()};
}
