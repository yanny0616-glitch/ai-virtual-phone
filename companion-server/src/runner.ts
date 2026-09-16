// 每分钟一轮：上一轮没跑完就跳过，不叠加。模式存在 SQLite meta 里，切换不用重启。

import { tickAll, tickCharacter, type EngineDeps, type Mode, type Trace } from "./engine.ts";

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
