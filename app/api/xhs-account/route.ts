import { NextRequest, NextResponse } from "next/server";
import { ACCOUNT_GATE_COOKIE, ACCOUNT_SESSION_COOKIE } from "@/lib/account-cookie-constants";
import { verifyAccountGateCookieValue } from "@/lib/account-gate-cookie";
import { isSelfHostedModeEnabled } from "@/lib/self-hosting";
import { requestXhsApi } from "@/lib/server/xhs-api";

export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(req: NextRequest) {
    const origin = req.headers.get("origin");
    const sameOrigin = req.headers.get("sec-fetch-site") === "same-origin" && Boolean(origin)
        && (origin === req.nextUrl.origin || origin === `https://${req.headers.get("host")}`);
    const loggedIn = sameOrigin && (isSelfHostedModeEnabled() || await verifyAccountGateCookieValue(
        req.cookies.get(ACCOUNT_GATE_COOKIE)?.value ?? "", req.cookies.get(ACCOUNT_SESSION_COOKIE)?.value ?? ""));
    if (!loggedIn) return NextResponse.json({error:"请先登录 Float"},{status:401});
    try {
        const raw = await req.text();
        if (raw.length > 25000) throw new Error("请求过大");
        const body = JSON.parse(raw);
        if (!["status","save","clear"].includes(body.action)) throw new Error("未知操作");
        if (body.action === "save" && typeof body.cookie !== "string") throw new Error("缺少 Cookie");
        const data = await requestXhsApi(body.action === "status" ? "status" : "cookie",
            body.action === "status" ? {refresh:body.refresh === true} : {cookie:body.action === "clear" ? "" : body.cookie}, req.signal);
        return NextResponse.json({ok:true,...data},{headers:{"Cache-Control":"no-store"}});
    } catch(error) {
        return NextResponse.json({error:error instanceof Error?error.message:"保存或检测失败"},{status:400,headers:{"Cache-Control":"no-store"}});
    }
}
