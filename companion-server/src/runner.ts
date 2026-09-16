// 每分钟一轮：上一轮没跑完就跳过，不叠加。模式存在 SQLite meta 里，切换不用重启。

import { tickAll, tickCharacter, type EngineDeps, type Mode, type Trace } from "./engine.ts";
import { syncTemplates } from "./templates.ts";

export class Runner {
  #deps: EngineDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  lastTraces = new Map<string, Trace>();
  lastTickAt = 0;

  constructor(deps: EngineDeps, defaultMode: Mode) {
    this.#deps = deps;
    if (!deps.store.getMeta("mode")) deps.store.setMeta("mode", defaultMode);
  }

  get mode(): Mode {
    return this.#deps.store.getMeta("mode") === "live" ? "live" : "shadow";
  }

  setMode(mode: Mode): void {
    this.#deps.store.setMeta("mode", mode);
    this.#deps.log(`[companion] 模式切换为 ${mode === "live" ? "真发" : "影子"}`);
  }

  get running(): boolean { return this.#running; }

  start(intervalMs = 60_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, intervalMs);
    setTimeout(() => { void this.tick(); }, 5_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(characterId?: string): Promise<Trace[]> {
    if (this.#running) return [];
    this.#running = true;
    try {
      // 先取 App 刚寄来的模板：TA 刚回复完、刚改完预设，这一轮就用上
      try {
        const updated = await syncTemplates(this.#deps.rest, this.#deps.store, this.#deps.userId);
        if (updated.length) this.#deps.log(`[companion] 收到新模板：${updated.join("、")}`);
      } catch (e) { this.#deps.log(`[companion] 取模板失败：${e instanceof Error ? e.message : String(e)}`); }
      const traces = characterId ? [await tickCharacter(this.#deps, this.mode, characterId)] : await tickAll(this.#deps, this.mode);
      for (const trace of traces) {
        this.lastTraces.set(trace.characterId, trace);
        if (trace.error) this.#deps.log(`[companion] ${trace.characterId}：${trace.error}`);
      }
      this.lastTickAt = this.#deps.now();
      return traces;
    } finally {
      this.#running = false;
    }
  }
}
