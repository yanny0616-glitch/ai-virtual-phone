import {NextRequest,NextResponse} from "next/server";
import {timingSafeEqual} from "node:crypto";
import {readFile} from "node:fs/promises";
import {ACCOUNT_GATE_COOKIE,ACCOUNT_SESSION_COOKIE} from "@/lib/account-cookie-constants";
import {verifyAccountGateCookieValue} from "@/lib/account-gate-cookie";
import {isSelfHostedModeEnabled} from "@/lib/self-hosting";
export const runtime="nodejs";
export async function POST(req:NextRequest){
 const origin=req.headers.get("origin");
 const loggedIn=isSelfHostedModeEnabled()||await verifyAccountGateCookieValue(req.cookies.get(ACCOUNT_GATE_COOKIE)?.value||"",req.cookies.get(ACCOUNT_SESSION_COOKIE)?.value||"");
 if(!loggedIn||req.headers.get("sec-fetch-site")!=="same-origin"||!origin||(origin!==req.nextUrl.origin&&origin!==`https://${req.headers.get("host")}`))return NextResponse.json({error:"请登录 Float 并从本站配置页访问"},{status:403});
 try{
  const expected=Buffer.from((await readFile("/etc/float-garden-wake/client-token","utf8")).trim());
  const supplied=Buffer.from(req.headers.get("x-float-garden-key")||"");
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return NextResponse.json({error:"请填写正确的唤醒连接码"},{status:401});
  const raw=await req.text();if(raw.length>20000)throw Error("请求过大");
  const body=JSON.parse(raw);
  if(!["status","save","start","stop","clear","events","ack"].includes(body.action))throw Error("未知操作");
  const secret=(await readFile("/etc/float-garden-wake/backend-token","utf8")).trim();
  const response=await fetch("http://127.0.0.1:18062",{method:"POST",headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data=await response.json();return NextResponse.json(data,{status:response.status,headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"唤醒服务不可用，请检查本机服务状态。"},{status:503,headers:{"Cache-Control":"no-store"}});}
}
