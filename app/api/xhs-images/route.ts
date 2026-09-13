import { NextRequest, NextResponse } from "next/server";
import { readXhsImage } from "@/lib/server/xhs-reader";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
    try {
        const raw = await req.text();
        if (raw.length > 20000) throw new Error("配图请求过长");
        const { urls } = JSON.parse(raw);
        if (!Array.isArray(urls) || urls.length < 1 || urls.length > 3 || urls.some(url => typeof url !== "string")) throw new Error("每次可读取 1–3 张配图");
        const images = await Promise.all(urls.map(async (url: string) => {
            try { return { url, ...await readXhsImage(url, req.signal) }; }
            catch (error) { return { url, error: error instanceof Error ? error.message : "配图读取失败" }; }
        }));
        return NextResponse.json({ ok: true, images }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "配图读取失败" }, { status: 400 });
    }
}
