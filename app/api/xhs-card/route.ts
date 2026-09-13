import { NextRequest, NextResponse } from "next/server";
import { readXhsNote } from "@/lib/server/xhs-reader";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
    try {
        const raw = await req.text();
        if (raw.length > 10000) throw new Error("链接请求过长");
        const { url } = JSON.parse(raw);
        if (typeof url !== "string") throw new Error("缺少笔记链接");
        return NextResponse.json({ ok: true, note: await readXhsNote(url, req.signal) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "读取笔记失败" }, { status: 400 });
    }
}
