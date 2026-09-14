import {NextRequest,NextResponse} from "next/server";
import {readFile} from "node:fs/promises";
import {isSelfHostedModeEnabled} from "@/lib/self-hosting";
export const runtime="nodejs";
export async function POST(req:NextRequest){
 const origin=req.headers.get("origin");
 if(!isSelfHostedModeEnabled()||req.headers.get("sec-fetch-site")!=="same-origin"||!origin||(origin!==req.nextUrl.origin&&origin!==`https://${req.headers.get("host")}`))return NextResponse.json({error:"仅限自部署 Float 同源访问"},{status:403});
 try{
  const raw=await req.text();if(raw.length>20000)throw Error("请求过大");
  const body=JSON.parse(raw);
  if(!["status","save","start","stop","clear","events","ack"].includes(body.action))throw Error("未知操作");
  const secret=(await readFile("/etc/float-garden-wake/backend-token","utf8")).trim();
  const response=await fetch("http://127.0.0.1:18062",{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data=await response.json();return NextResponse.json(data,{status:response.status,headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"唤醒服务不可用，请检查本机服务状态。"},{status:503,headers:{"Cache-Control":"no-store"}});}
}
