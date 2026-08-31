import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import { isSelfHostedModeEnabled } from "@/lib/self-hosting";

// 自部署实例的版本检查与一键更新：
// GET 对比 /opt/float/current/VERSION 与 GitHub 最新 Release；
// POST 触发 float-deploy.service（--no-block：部署会重启本服务自身，必须先把响应发回去）。
// 下载校验、切软链、失败回滚都由 ops/float-deploy.sh 负责，这里只是扳一下开关。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPO = "yanny0616-glitch/ai-virtual-phone";
const VERSION_FILE = "/opt/float/current/VERSION";
const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "float-self-host-updater" };

async function readCurrentSha(): Promise<string> {
  try {
    return (await readFile(VERSION_FILE, "utf8")).trim().slice(0, 40);
  } catch {
    return "";
  }
}

async function fetchGithubJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: GITHUB_HEADERS, cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json() as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function GET() {
  if (!isSelfHostedModeEnabled()) {
    return NextResponse.json({ ok: false, error: "仅自部署模式可用。" }, { status: 403 });
  }
  const [current, release, head] = await Promise.all([
    readCurrentSha(),
    fetchGithubJson(`https://api.github.com/repos/${REPO}/releases/latest`),
    fetchGithubJson(`https://api.github.com/repos/${REPO}/commits/main`),
  ]);
  const tag = typeof release?.tag_name === "string" ? release.tag_name : "";
  const releaseSha = /^float-build-([0-9a-f]{12})$/.exec(tag)?.[1] ?? "";
  const publishedAt = typeof release?.published_at === "string" ? release.published_at : "";
  const mainSha = typeof head?.sha === "string" ? head.sha.slice(0, 12) : "";
  return NextResponse.json({
    ok: true,
    current: current.slice(0, 12),
    latest: releaseSha ? { sha: releaseSha, tag, publishedAt } : null,
    // main 领先于最新 Release：多半在构建，也可能是 [skip ci] 提交
    building: Boolean(mainSha && releaseSha && mainSha !== releaseSha),
    updateAvailable: Boolean(releaseSha && current && releaseSha !== current.slice(0, 12)),
  });
}

export async function POST() {
  if (!isSelfHostedModeEnabled()) {
    return NextResponse.json({ ok: false, error: "仅自部署模式可用。" }, { status: 403 });
  }
  return await new Promise<NextResponse>(resolve => {
    execFile("systemctl", ["start", "--no-block", "float-deploy.service"], { timeout: 10_000 }, error => {
      if (error) resolve(NextResponse.json({ ok: false, error: `触发部署失败：${error.message}` }, { status: 500 }));
      else resolve(NextResponse.json({ ok: true }));
    });
  });
}
