// 每分钟一轮：上一轮没跑完就跳过，不叠加。模式存在 SQLite meta 里，切换不用重启。
// 手机发来的改动（账本、日程、设置…）也排进同一把锁：一轮判断要调模型，中途改了会被这轮结束时的保存盖掉。

import { tickAll, tickCharacter, type EngineDeps, type Mode, type Trace } from "./engine.ts";
import { syncTemplates } from "./templates.ts";

export class Runner {
  #deps: EngineDeps;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #ops: (() => Promise<() => void>)[] = [];
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

  /** 在锁里改状态：空闲就马上做，正在跑一轮就排到这轮结束后。返回的 Promise 在真正做完、锁放开后兑现 */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const op = async () => {
        try { const value = await fn(); return () => resolve(value); }
        catch (e) { return () => reject(e); }
      };
      this.#ops.push(op);
      if (this.#running) return;
      this.#running = true;
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    const settled: (() => void)[] = [];
    try { while (this.#ops.length) settled.push(await this.#ops.shift()!()); }
    finally {
      this.#running = false;
      // 先放锁再回话：手机紧接着点「立刻跑一轮」不会撞上 409
      for (const done of settled) done();
    }
  }

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
      await this.#drain();
    }
  }
}
