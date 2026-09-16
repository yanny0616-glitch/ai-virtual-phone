// 运维命令：不经过 HTTP，直接读配置执行。
//   node --no-warnings src/cli.ts diagnose    打印各角色最近聊天与快照时间
//   node --no-warnings src/cli.ts push-test   给手机发一条测试推送

import { join } from "node:path";

import { loadConfig } from "./config.ts";
import { collectDiagnostics } from "./diagnostics.ts";
import { sendPushToUser } from "./push.ts";
import { Store } from "./store.ts";
import { createRest, resolveUserId } from "./supabase.ts";

const command = process.argv[2];
const config = loadConfig();
const rest = createRest(config);
const userId = await resolveUserId(rest, config.userId);

if (command === "diagnose") {
  const store = new Store(join(config.dataDir, "companion.db"));
  const report = await collectDiagnostics(rest, store, userId);
  store.close();
  for (const c of report.characters) {
    console.log(`\n角色 ${c.characterId}  镜像最新 ${c.mirrorLatestAt ?? "无"}  快照 ${c.snapshot?.receivedAt ?? "未收到"}`);
    for (const m of c.recent) console.log(`  ${m.at.slice(5, 16)} ${m.role === "user" ? "你" : "TA"}：${m.text.replace(/\s+/g, " ")}`);
  }
} else if (command === "push-test") {
  const result = await sendPushToUser(rest, userId, {
    title: "挂念后端", body: "测试推送：来自 VPS ✓", tag: `companion-test-${Date.now()}`, url: "/",
  });
  console.log(`订阅 ${result.total} 个，送出 ${result.sent}，清理失效 ${result.removed}，跳过安卓壳 ${result.skippedShell}`
    + (result.errors.length ? `，错误：${result.errors.join("; ")}` : ""));
  process.exitCode = result.sent > 0 ? 0 : 1;
} else {
  console.error("用法：cli.ts diagnose | push-test");
  process.exitCode = 2;
}
