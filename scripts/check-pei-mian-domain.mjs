#!/usr/bin/env node
// 陪眠领域层：节奏表、统计、混音、WAV。不碰宿主。
import assert from "node:assert/strict";
import { buildSchedule, normalizeRhythm, totalScheduleSeconds, RHYTHM_PRESETS } from "../custom-apps/pei-mian/src/domain/rhythm.mjs";
import { nightKeyFor, minutesBetween, bedtimeMinutes, formatBedtime, summarizeWeek, compareWeeks, streakDays, monthGrid, weekStartKey, addDays } from "../custom-apps/pei-mian/src/domain/stats.mjs";
import { loopSamples, mixLayers, fadeTail, resample, toMono, MIX_SAMPLE_RATE } from "../custom-apps/pei-mian/src/domain/mixer.mjs";
import { encodeWav } from "../custom-apps/pei-mian/src/domain/wav.mjs";

// 节奏
const steps = buildSchedule(RHYTHM_PRESETS.gentle);
assert.equal(steps.length, 5);
assert.equal(steps[0].chars, 90); assert.equal(steps[4].chars, 20); assert.equal(steps[4].gapAfterSec, 0);
for (let i = 1; i < steps.length; i += 1) { assert.ok(steps[i].chars <= steps[i - 1].chars, "字数递减"); }
for (let i = 1; i < steps.length - 1; i += 1) { assert.ok(steps[i].gapAfterSec >= steps[i - 1].gapAfterSec, "间隔递增"); }
assert.equal(normalizeRhythm({ segments: 99 }).segments, 12);
assert.equal(normalizeRhythm(null).segments, 5);
assert.ok(totalScheduleSeconds(RHYTHM_PRESETS.brief) < totalScheduleSeconds(RHYTHM_PRESETS.long));
assert.equal(buildSchedule({ segments: 1 }).length, 1);

// 统计
assert.equal(nightKeyFor(new Date(2026, 8, 12, 1, 30)), "2026-09-11", "凌晨算前一晚");
assert.equal(nightKeyFor(new Date(2026, 8, 12, 23, 30)), "2026-09-12");
assert.equal(minutesBetween("2026-09-11T23:30:00", "2026-09-12T07:00:00"), 450);
assert.equal(minutesBetween("2026-09-12T07:00:00", "2026-09-11T23:30:00"), 0);
assert.equal(formatBedtime(bedtimeMinutes("2026-09-11T23:30:00")), "23:30");
assert.equal(formatBedtime(bedtimeMinutes("2026-09-12T01:10:00")), "01:10");
assert.ok(bedtimeMinutes("2026-09-12T01:10:00") > bedtimeMinutes("2026-09-11T23:30:00"), "凌晨排在深夜之后");
const ws = weekStartKey(new Date(2026, 8, 12)); assert.equal(ws, "2026-09-07");
const nights = [
  { date: "2026-09-07", sleepAt: "2026-09-07T23:00:00", wakeAt: "2026-09-08T07:00:00", durationMin: 480, rating: 4, wakeups: 0, mixName: "雨夜壁炉" },
  { date: "2026-09-08", sleepAt: "2026-09-09T01:00:00", wakeAt: "2026-09-09T07:00:00", durationMin: 360, rating: 2, wakeups: 2, mixName: "雨夜壁炉" },
  { date: "2026-09-10", sleepAt: "2026-09-10T23:30:00", wakeAt: "2026-09-11T07:30:00", durationMin: 480, rating: 5, wakeups: 0, mixName: "机舱" },
];
const week = summarizeWeek(nights, ws, { bedtime: "23:30", hours: 7.5 });
assert.equal(week.nightsLogged, 3); assert.equal(week.avgDurationMin, 440); assert.equal(week.totalWakeups, 2);
assert.equal(week.topMix.name, "雨夜壁炉"); assert.equal(week.goalDurationHits, 2); assert.equal(week.goalBedtimeHits, 2);
assert.equal(week.days.length, 7); assert.equal(week.days[2].night, null);
const prev = summarizeWeek([], addDays(ws, -7), null);
assert.deepEqual(compareWeeks(week, prev), { durationDeltaMin: null, bedtimeDeltaMin: null });
assert.equal(streakDays(nights, "2026-09-10"), 1); assert.equal(streakDays(nights, "2026-09-08"), 2);
const grid = monthGrid(2026, 9); assert.equal(grid.length % 7, 0); assert.equal(grid[1], "2026-09-01", "2026-09-01 是周二");

// 混音
const sr = MIX_SAMPLE_RATE;
const tone = new Float32Array(sr * 2); for (let i = 0; i < tone.length; i += 1) tone[i] = Math.sin(i / 20) * .5;
const looped = loopSamples(tone, sr * 5, sr, 7);
assert.equal(looped.length, sr * 5);
assert.ok(looped.reduce((m, v) => Math.max(m, Math.abs(v)), 0) <= .5 * Math.SQRT2 + 1e-6, "等功率交叉不超过 √2 倍峰值");
const mixed = mixLayers([{ samples: tone, volume: .8, seed: 1 }, { samples: [tone, new Float32Array(tone.length)], volume: .3, drift: true, seed: 2 }], { loopSeconds: 4 });
assert.equal(mixed.channels.length, 2); assert.equal(mixed.channels[0].length, sr * 4); assert.ok(mixed.peak > 0 && mixed.peak <= 1);
assert.notEqual(mixed.channels[0][1000], mixed.channels[1][1000], "第二层右声道静音，左右应不同");
assert.equal(mixLayers([], { loopSeconds: 1 }).peak, 0);
const tail = fadeTail(mixed.channels, 2); assert.equal(tail.length, 2); assert.equal(tail[0].length, sr * 2); assert.ok(Math.abs(tail[1][tail[1].length - 1]) < 1e-3, "尾巴归零");
assert.equal(resample(new Float32Array(44100), 44100, 22050).length, 22050);
assert.equal(toMono([new Float32Array([1, 1]), new Float32Array([0, 0])])[0], .5);

// WAV
const wav = encodeWav(new Float32Array([0, 1, -1]), 8000);
assert.equal(wav.length, 44 + 6); assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
assert.equal(new DataView(wav.buffer).getInt16(46, true), 0x7FFF); assert.equal(new DataView(wav.buffer).getInt16(48, true), -0x8000);
const wav2 = encodeWav([new Float32Array([1, 0]), new Float32Array([0, -1])], 44100);
assert.equal(wav2.length, 44 + 8); assert.equal(new DataView(wav2.buffer).getUint16(22, true), 2, "双声道");
assert.equal(new DataView(wav2.buffer).getInt16(44, true), 0x7FFF); assert.equal(new DataView(wav2.buffer).getInt16(46, true), 0); assert.equal(new DataView(wav2.buffer).getInt16(50, true), -0x8000, "交错存放");

console.log("[pei-mian] 领域层检查通过。");
