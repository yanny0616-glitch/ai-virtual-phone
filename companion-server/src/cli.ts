// 运维命令：不经过 HTTP，直接读配置执行（服务在跑时也能用，SQLite 是 WAL）。
//   cli.ts diagnose            各角色最近聊天与快照时间
//   cli.ts push-test           给手机发一条测试推送
//   cli.ts status              模式、每个角色此刻在做什么、今天的念头、最近判断
//   cli.ts import [--force]    从个人云迁入（--force 覆盖后端状态、清掉影子定时器）
//   cli.ts mode shadow|live    切换模式（服务下一轮生效）
//   cli.ts test-send <角色名或id> <意图>   塞一条立刻到点的念头，按当前模式走一遍完整发送链路

import { join } from "node:path";

import { loadConfig } from "./config.ts";
import { collectDiagnostics } from "./diagnostics.ts";
import { importFromCloud } from "./importer.ts";
import { characterTz, tickCharacter } from "./engine.ts";
import { hhmm, localDate } from "./life.ts";
import { sendPushMessages, sendPushToUser } from "./push.ts";
import { Store } from "./store.ts";
import { characterStatus } from "./status.ts";
import { createRest, resolveUserId } from "./supabase.ts";
import type { Runner } from "./runner.ts";

const [command, arg] = process.argv.slice(2);
const config = loadConfig();
const rest = createRest(config);
const userId = await resolveUserId(rest, config.userId);
const store = new Store(join(config.dataDir, "companion.db"));

try {
  if (command === "diagnose") {
    const report = await collectDiagnostics(rest, store, userId);
    for (const c of report.characters) {
      console.log(`\n角色 ${c.characterId}  镜像最新 ${c.mirrorLatestAt ?? "无"}  快照 ${c.snapshots.map(s => `${s.purpose}@${new Date(s.capturedAt).toISOString().slice(0, 16)}`).join(" ") || "未收到"}`);
      for (const m of c.recent) console.log(`  ${m.at.slice(5, 16)} ${m.role === "user" ? "你" : "TA"}：${m.text.replace(/\s+/g, " ")}`);
    }
  } else if (command === "push-test") {
    const result = await sendPushToUser(rest, userId, {
      title: "挂念后端", body: "测试推送：来自 VPS ✓", tag: `companion-test-${Date.now()}`, url: "/",
    });
    console.log(`订阅 ${result.total} 个，送出 ${result.sent}，清理失效 ${result.removed}，跳过安卓壳 ${result.skippedShell}`
      + (result.errors.length ? `，错误：${result.errors.join("; ")}` : ""));
    process.exitCode = result.sent > 0 ? 0 : 1;
  } else if (command === "import") {
    const report = await importFromCloud(rest, store, userId, { force: arg === "--force" });
    for (const c of report.characters) console.log(`${c.name || c.characterId}：${c.skipped || `日子 ${c.days.join(",") || "无"}，快照 ${c.snapshots.join("/") || "无"}，接手定时器 ${c.timers || 0}`}`);
  } else if (command === "mode" && (arg === "shadow" || arg === "live")) {
    store.setMeta("mode", arg);
    console.log(`模式已设为 ${arg}，服务下一轮生效`);
  } else if (command === "test-send") {
    const intent = process.argv.slice(4).join(" ");
    const c = store.listCharacters().find(x => x.characterId === arg || x.name === arg);
    if (!c || !intent) throw new Error("用法：cli.ts test-send <角色名或id> <意图>");
    const tz = characterTz(c) ?? 480;
    const nowMs = Date.now();
    const date = localDate(nowMs, tz);
    const row = store.getDay(c.characterId, date) || {
      characterId: c.characterId, date, day: null, items: [], selfUsed: 0, recheckCount: 0, judgedAt: 0, judgedChatAt: 0,
      genTries: 0, genError: "", genLog: [], source: "", updatedAt: 0,
    };
    const wakeId = `srv_test_${nowMs.toString(36)}`;
    row.items.push({ time: hhmm(nowMs, tz), fireAt: nowMs, kind: "extra", act: true, intent, why: "手动测试发送", source: "测试", sem: "", topic: "", from: "", wakeId, matterId: "matter:" + wakeId });
    store.saveDay(row);
    store.addTimer({ id: wakeId, characterId: c.characterId, date, fireAt: nowMs, kind: "extra", status: "pending", note: "手动测试" });
    const mode = store.getMeta("mode") === "live" ? "live" : "shadow";
    const trace = await tickCharacter({
      store, rest, userId, fetchModel: (url, init) => fetch(url, init), push: messages => sendPushMessages(rest, userId, messages),
      now: () => Date.now(), random: Math.random, log: line => console.log(line),
    }, mode, c.characterId);
    console.log(`[${mode}] ${c.name}` + (trace.error ? ` 出错：${trace.error}` : ""));
    for (const step of trace.steps) console.log("  " + step);
  } else if (command === "status") {
    const fakeRunner = { lastTraces: new Map(), mode: store.getMeta("mode") } as unknown as Runner;
    console.log(`模式：${store.getMeta("mode") || "未设置"}`);
    for (const c of store.listCharacters()) {
      const s = characterStatus(store, fakeRunner, c.characterId)!;
      console.log(`\n■ ${s.name || s.characterId}  ${s.date}  ${s.enabled ? "" : "（关着）"}快照：${s.snapshots.map(x => x.purpose).join("/") || "无"}`);
      if (s.now) console.log(`  此刻 ${s.now.hm}：${s.now.doing}｜${s.now.mood}｜精力 ${s.now.energy}%${s.now.next ? "｜接下来 " + s.now.next : ""}`);
      else console.log("  今天还没有生活面" + (s.day?.genError ? `（${s.day.genError}）` : ""));
      for (const i of s.day?.items || []) console.log(`  念头 ${i.time} ${i.act ? "●" : "○"} ${i.kind || ""} ${i.intent || i.why}${i.generatedAt ? "（已发）" : ""}`);
      for (const t of s.timers.filter(x => x.status === "pending")) console.log(`  定时器 ${new Date(t.fireAt + (s.tz ?? 0) * 60_000).toISOString().slice(5, 16)} ${t.kind} ${t.note}`);
      for (const d of s.decisions.slice(0, 10)) console.log(`  ${new Date(d.at + (s.tz ?? 0) * 60_000).toISOString().slice(5, 16)} [${d.mode}] ${d.kind}：${d.note}`);
    }
  } else {
    console.error("用法：cli.ts diagnose | push-test | status | import [--force] | mode shadow|live | test-send <角色> <意图>");
    process.exitCode = 2;
  }
} finally {
  store.close();
}
