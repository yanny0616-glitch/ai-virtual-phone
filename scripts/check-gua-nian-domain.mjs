#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import * as time from "../custom-apps/gua-nian/src/domain/time.mjs";
import * as scoring from "../custom-apps/gua-nian/src/domain/scoring.mjs";
import { checkGuaNianBuild } from "./build-gua-nian.mjs";

if (!process.argv.includes("--zone")) {
  checkGuaNianBuild();
  for (const zone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--zone"], {
      env: { ...process.env, TZ: zone }, encoding: "utf8", timeout: 60000,
    });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `模块检查失败：${zone}`);
    process.stdout.write(result.stdout);
  }
} else {
  const now = new Date(2026, 8, 4, 12, 0).getTime();
  for (const [input, expected] of [["8:30", "08:30"], ["08：30", "08:30"], ["14时", "14:00"], ["25:75", "23:59"], ["无时间", ""], [null, ""]]) {
    assert.equal(time.normalizeTime(input), expected);
  }
  assert.equal(time.timeOnLocalDay("bad", now), null);
  const base = new Date(now);
  assert.equal(time.timeOnLocalDay("08:30", base), new Date(2026, 8, 4, 8, 30).getTime());
  assert.equal(base.getTime(), now, "不能修改传入的 Date");
  assert.equal(time.addMinutes("23:30", 90), "23:59");
  assert.equal(time.addMinutes("08:30", 15), "08:45");
  assert.equal(time.addMinutes("bad", 15), "bad");
  assert.equal(time.localDateKey(time.parseLocalDate("2026-09-04", now)), "2026-09-04");
  assert.equal(time.parseLocalDate("bad", now).getTime(), now);
  for (const [hm, expected] of [["23:29", false], ["23:30", true], ["00:00", true], ["07:59", true], ["08:00", false]]) {
    assert.equal(time.isInTimeWindow(hm, "23:30", "08:00"), expected);
  }
  assert.equal(time.isInTimeWindow("13:00", "13:00", "14:00"), true);
  assert.equal(time.isInTimeWindow("14:00", "13:00", "14:00"), false);
  assert.equal(time.isInTimeWindow("00:00", "08:00", "08:00"), false);
  const settings = Object.freeze({ quietStart: "23:30", quietEnd: "08:00" });
  const day = Object.freeze({ bed: "01:00", wake: "09:00" });
  assert.equal(time.isAsleep(null, "00:00", settings), true);
  assert.equal(time.isAsleep(day, "00:00", settings), false);
  assert.equal(time.isAsleep(day, "01:00", settings), true);
  assert.equal(time.isAsleep(day, "09:00", settings), false);
  assert.deepEqual(time.getSleepWindow(day, settings), { bed: "01:00", wake: "09:00", overnight: true });
  assert.equal(time.getSleepWindow({ bed: "08:00", wake: "08:00" }, settings), null);

  // 日期锚定使用本地日历，不以固定 24 小时偏移替代，覆盖夏令时切换日期。
  for (const [month, date] of [[2, 8], [10, 1]]) {
    const anchor = new Date(2026, month, date, 0, 30);
    assert.equal(time.timeOnLocalDay("08:30", anchor), new Date(2026, month, date, 8, 30).getTime());
  }
  if (process.env.TZ === "America/New_York") {
    assert.equal(time.formatLocalTime(time.timeOnLocalDay("02:30", new Date(2026, 2, 8))), "03:30");
  }

  const input = Object.freeze({ localHour: 13, fireAt: now, armedBefore: 2, streak: 2, lastArmedAt: now - 30 * 60000, quota: 4, maxUnanswered: 4, minGapMin: 30 });
  const result = scoring.calculateScore(input);
  assert.deepEqual([result.pq, result.pr, result.pg, result.press], [50, 50, 50, 50]);
  const full = scoring.calculateScore({ ...input, armedBefore: 10, streak: 10, lastArmedAt: now });
  assert.deepEqual([full.pq, full.pr, full.pg, full.press], [100, 100, 100, 100]);
  assert.equal(scoring.calculateScore({ ...input, lastArmedAt: now - 60 * 60000 }).pg, 0);
  assert.equal(scoring.calculateScore({ ...input, minGapMin: 0 }).pg, 0);
  assert.equal(scoring.calculateScore({ ...input, maxUnanswered: 0, streak: 2 }).pr, 50);
  assert.equal(scoring.calculateScore({ ...input, quota: 0, armedBefore: 1 }).pq, 100);
  assert.ok(scoring.fitScore(21) > scoring.fitScore(3));
  const message = (age, role = "assistant") => Object.freeze({ role, t: now - age * 60000 });
  assert.equal(scoring.countUnansweredRounds([message(29.999)], now), 0);
  assert.equal(scoring.countUnansweredRounds([message(30)], now), 1);
  assert.equal(scoring.countUnansweredRounds(Object.freeze([message(40), message(37)]), now), 1);
  assert.equal(scoring.countUnansweredRounds([message(40), message(36)], now), 2);
  assert.equal(scoring.countUnansweredRounds([message(60), message(45, "user"), message(30)], now), 1);

  // 同时验证发布用的经典脚本与 ESM 的结果一致，以及薄封装每次读取最新设置。
  const html = readFileSync(new URL("../custom-apps/gua-nian/index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const marker = "  init();\n})();";
  assert.ok(script.includes(marker));
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const ctx = vm.createContext({ Date: Clock });
  vm.runInContext(script.replace(marker, "  globalThis.api = { S, normHM, timeToMs, sleepWindow, asleepAt, inQuiet, calcScore, unansweredStreak, dateOf, todayStr, GuaNianTime, GuaNianScoring };\n})();"), ctx);
  const api = ctx.api;
  api.S.settings = { ...settings, quota: 4, maxUnanswered: 4, minGapMin: 30 };
  assert.equal(api.todayStr(), "2026-09-04");
  assert.equal(api.timeToMs("08:30"), time.timeOnLocalDay("08:30", now));
  assert.equal(api.dateOf("bad").getTime(), now);
  assert.equal(api.normHM("8点30"), "08:30");
  assert.equal(api.asleepAt(day, "09:00"), false);
  assert.equal(api.inQuiet("00:00"), true);
  assert.equal(api.calcScore(now, 2, 2, now - 30 * 60000).pq, 50);
  api.S.settings.quota = 2;
  assert.equal(api.calcScore(now, 2, 2, now - 30 * 60000).pq, 100);
  assert.ok(Object.isFrozen(api.GuaNianTime) && Object.isFrozen(api.GuaNianScoring));
  assert.deepEqual(Object.keys(api.GuaNianTime).sort(), Object.keys(time).sort());
  assert.deepEqual(Object.keys(api.GuaNianScoring).sort(), Object.keys(scoring).sort());
  console.log(`[gua-nian-domain] ${process.env.TZ}：时间边界、评分、未回应轮次、独立导入与打包接线通过。`);
}
