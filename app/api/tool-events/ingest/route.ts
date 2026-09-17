import {NextRequest,NextResponse} from "next/server";
export const runtime="nodejs";
export async function POST(req:NextRequest){
 const auth=req.headers.get("authorization")||"";
 if(!/^Bearer [A-Za-z0-9_-]{32,200}$/.test(auth))return NextResponse.json({error:"Missing source token"},{status:401});
 try{
  const raw=await req.text();if(raw.length>20000)return NextResponse.json({error:"Request too large"},{status:413});
  const body=JSON.parse(raw);
  // The sender supplies content only. Target, mode and tool binding come from owner configuration.
  const response=await fetch("http://127.0.0.1:18062",{method:"POST",headers:{Authorization:auth,"Content-Type":"application/json"},body:JSON.stringify({action:"ingest",version:body.version,sourceId:body.sourceId,eventId:body.eventId,reason:body.reason,message:body.message}),signal:AbortSignal.timeout(20000)});
  return NextResponse.json(await response.json(),{status:response.status,headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"Event delivery unavailable"},{status:503});}
}
