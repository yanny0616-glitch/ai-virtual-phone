// Adapter CLI: one JSON event on stdin; stable eventId must be assigned by the producer.
import {pathToFileURL} from 'node:url';
export async function sendEvent(event,env=process.env,fetcher=fetch){
 const url=new URL(env.FLOAT_EVENT_URL||'');
 if(url.protocol!=='https:'||url.username||url.password)throw Error('FLOAT_EVENT_URL must be credential-free HTTPS');
 if(!env.FLOAT_EVENT_TOKEN||!env.FLOAT_EVENT_SOURCE_ID)throw Error('Missing source configuration');
 if(typeof event.eventId!=='string'||!event.eventId||typeof event.message!=='string'||typeof event.reason!=='string')throw Error('Provide eventId, reason and message');
 const response=await fetcher(url,{method:'POST',headers:{Authorization:`Bearer ${env.FLOAT_EVENT_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({version:1,sourceId:env.FLOAT_EVENT_SOURCE_ID,eventId:event.eventId,reason:event.reason,message:event.message}),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error(`Event delivery failed (HTTP ${response.status}); not retried`);
 return response.json();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16000)throw Error('Event too large');}await sendEvent(JSON.parse(raw));process.stdout.write('Event accepted\n');}
 catch{process.stderr.write('Event delivery failed; check source configuration and event format. No automatic retry.\n');process.exitCode=1;}
}
