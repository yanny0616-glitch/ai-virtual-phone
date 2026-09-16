// 给挂念 App 和诊断看的状态：每个角色此刻的生活、今天的念头、定时器、最近的判断。不含快照内容（里面有密钥）。

import { forkDay, guanianNow, localDate } from "./life.ts";
import { characterTz, type Mode } from "./engine.ts";
import type { Store } from "./store.ts";
import type { Runner } from "./runner.ts";

export function characterStatus(store: Store, runner: Runner, characterId: string, nowMs = Date.now()) {
  const c = store.getCharacter(characterId);
  if (!c) return null;
  const tz = characterTz(c);
  const date = tz === null ? "" : localDate(nowMs, tz);
  const row = date ? store.getDay(characterId, date) : null;
  const day = row?.day ? forkDay({ ...row.day, tz: tz ?? 0 }, nowMs, c.state.affection ?? c.settings.affection) : null;
  const now = day ? guanianNow(day, nowMs, c.settings.quietStart, c.settings.quietEnd) : null;
  return {
    characterId, name: c.name, enabled: c.enabled, sessionId: c.sessionId, tz, date,
    now: now && { hm: now.hm, doing: now.doing, step: now.step, place: now.place, mood: now.mood, energy: now.energy, next: now.next, asleep: now.asleep },
    day: row && { source: row.source, day: row.day, items: row.items, selfUsed: row.selfUsed, recheckCount: row.recheckCount, judgedAt: row.judgedAt, genError: row.genError, genLog: row.genLog },
    threads: c.state.threads || [],
    outbox: c.state.outbox || [],
    fb: c.state.fb || {},
    settings: c.settings,
    timers: store.listTimers(characterId, nowMs - 36 * 3600_000),
    snapshots: store.listSnapshots().filter(s => s.characterId === characterId),
    decisions: store.listDecisions(characterId, 60),
    lastTrace: runner.lastTraces.get(characterId) || null,
  };
}

export function overview(store: Store, runner: Runner, nowMs = Date.now()): { mode: Mode; running: boolean; lastTickAt: number; characters: unknown[] } {
  return {
    mode: runner.mode, running: runner.running, lastTickAt: runner.lastTickAt,
    characters: store.listCharacters().map(c => {
      const s = characterStatus(store, runner, c.characterId, nowMs)!;
      return {
        characterId: s.characterId, name: s.name, enabled: s.enabled, date: s.date, now: s.now,
        dayFrom: s.day?.source || "", items: (s.day?.items || []).map(i => ({ time: i.time, act: i.act, kind: i.kind, intent: i.intent, sent: !!i.generatedAt })),
        pendingTimers: s.timers.filter(t => t.status === "pending").length,
        snapshots: s.snapshots.map(x => x.purpose),
        recent: s.decisions.slice(0, 8).map(d => ({ at: new Date(d.at).toISOString(), kind: d.kind, note: d.note, mode: d.mode })),
        lastError: s.lastTrace?.error || "",
      };
    }),
  };
}
