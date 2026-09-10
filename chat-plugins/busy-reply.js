// 忙碌回复：规则由插件提供；宿主负责计时、云同步、生成与回填。
const busyReplyPlugin = {
  manifest: {
    id: "busy-reply",
    name: "忙碌回复",
    apiVersion: 1,
    version: "1.1.1",
    author: "Float",
    description: "忙时延后、专注时按概率偷空回复，也允许角色根据情境选择本轮不回。读取挂念或其他 APP 的作息，也支持「在线状态」里的手动忙碌；离线执行复用小手机个人云。首次读取时导入旧挂念设置。",
    permissions: ["chat.read", "storage"],
    settings: [
      { key: "enabled", label: "启用忙碌、睡眠和不回复规则", type: "boolean", default: true },
      { key: "allowSilence", label: "允许角色选择不回复", type: "boolean", default: true, description: "结合人设、关系、情绪和上下文选择沉默；不生成气泡、不安排补回，新消息到来后重新判断。仍会调用模型。" },
      { key: "adaptive", label: "根据日程找空档", type: "boolean", default: true },
      { key: "peekMin", label: "偷空等待／检查间隔（分钟）", type: "number", default: 3, description: "0 不等待；按此间隔上下浮动四成，连续发送不会重置计时。" },
      { key: "focusedPeekProb", label: "专注中偷空回复的概率（%）", type: "number", default: 25, description: "每次检查抽一次。0 只等休息或结束，100 首次检查时回；没有细排也适用。" },
      { key: "sleepMode", label: "睡着时收到消息", type: "select", default: "wait", options: [{ value: "wait", label: "醒来后回复" }, { value: "chance", label: "概率醒来回复" }, { value: "ignore", label: "不因睡眠延后" }] },
      { key: "wakeProb", label: "被消息吵醒的概率（%）", type: "number", default: 18 },
      { key: "wakeBufferMin", label: "醒来后再等（分钟）", type: "number", default: 10 },
      { key: "urgentBypass", label: "紧急消息优先回复", type: "boolean", default: true, description: "识别救命、医院、快回等紧急词；已有云端等待须先确认取消。" },
      { key: "manualBusyMin", label: "手动忙碌／睡觉有效期（分钟）", type: "number", default: 60, description: "在「在线状态」里手动设为忙碌或睡觉时使用；从设置该状态的时刻起计算，不因发消息续期。" },
    ],
  },
  setup(ctx) {
    if (ctx.data.replyGate.policyVersion !== 1) throw new Error("请先更新小手机宿主，再启用忙碌回复插件。");
    if (ctx.data.replyGate.silenceVersion !== 1) throw new Error("请先更新小手机宿主，再使用支持不回复的忙碌回复插件。");
    const fields = ["enabled", "adaptive", "peekMin", "focusedPeekProb", "sleepMode", "wakeProb", "wakeBufferMin", "urgentBypass", "manualBusyMin"];
    const num = (key, fallback, lo, hi) => {
      const n = Number(ctx.system.settings.get(key));
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
    };
    const hm = d => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const ymd = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    let observed = JSON.stringify(ctx.system.settings.all());
    function migrate(source) {
      if (ctx.system.storage.get("migrationDone") || !source) return;
      if (JSON.stringify(ctx.system.settings.all()) !== observed) { ctx.system.storage.set("migrationDone", true); return; }
      const old = source.legacyReplySettings || (!source.availabilityOnly ? {
        enabled: true, adaptive: source.busy?.adaptive === true, peekMin: source.busy?.peekMin ?? 3,
        focusedPeekProb: source.busy?.focusedPeekProb ?? 0,
        sleepMode: source.sleep?.mode === 2 ? "chance" : "wait", wakeProb: source.sleep?.wakeProb ?? 18,
        wakeBufferMin: source.sleep?.bufferMin ?? 10,
      } : null);
      if (!old) return;
      ctx.system.storage.set("migrationDone", true);
      for (const key of fields) if (old[key] != null) ctx.system.settings.set(key, old[key]);
      observed = JSON.stringify(ctx.system.settings.all());
    }
    // Import once, before rendering plugin settings. Later APP uploads cannot overwrite edits.
    for (const character of ctx.data.characters.list()) migrate(ctx.data.replyGate.get(character.id));
    ctx.system.settings.onChange(settings => {
      const next = JSON.stringify(settings);
      if (next !== observed) ctx.system.storage.set("migrationDone", true);
      observed = next;
    });
    function describeReplyState(characterId) {
      const record = name => {
        const value = ctx.data.variables.get(name, "character", characterId);
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      };
      const text = value => {
        if (typeof value !== "string") return "";
        const clean = value.replace(/\s+/g, " ").trim();
        return clean.length > 180 ? clean.slice(0, 180) + "…" : clean;
      };
      const lines = [];
      const add = (label, value) => { const content = text(value); if (content) lines.push(label + "：" + content); };
      const labels = { online: "在线", busy: "忙碌", sleep: "睡觉中", away: "离开", hidden: "隐身" };
      const presence = record("presence");
      add("日程状态", labels[presence.state] || (presence.asleep ? "睡觉中" : presence.busy ? "忙碌" : ""));
      add("状态说明", presence.label);
      add("正在做", presence.doing);
      add("当前进展", presence.step);
      add("地点", presence.place);
      add("心情", presence.mood);
      if (typeof presence.energy === "number" && Number.isFinite(presence.energy)) lines.push("精力：" + presence.energy + "/100");
      add("接下来", presence.next);
      const override = record("presenceOverride");
      const timed = ["busy", "sleep"].includes(override.state);
      const at = Number(override.at), now = Date.now();
      if (!timed || Number.isFinite(at) && at <= now && now < at + num("manualBusyMin", 60, 1, 1440) * 60000) {
        add("手动状态", labels[override.state]);
        if (labels[override.state]) add("手动状态说明", override.label);
      }
      return lines.join("\n");
    }
    ctx.hooks.transform("prompt.system", p => {
      if (p.isGroup || p.replyText == null || ctx.system.settings.get("enabled") === false
          || ctx.system.settings.get("allowSilence") === false) return p;
      const urgent = /救命|出事|紧急|急事|报警|医院|受伤|流血|不舒服|害怕|崩溃|不想活|马上回|立刻回|快回|现在就回/;
      if (ctx.system.settings.get("urgentBypass") !== false && urgent.test(p.replyText.replace(/\s+/g, ""))) return p;
      const states = describeReplyState(p.characterId);
      return { ...p, allowSilence: true, hint: p.hint + "\n" + [
        "是否回应由你结合人设、关系、已有剧情、情绪、当前状态和整段待回应消息判断，不是每条消息都必须回复。",
        "既可以在确认、道别、明确不用回时结束对话，也可以因生气、不知如何回答、需要独处、不愿继续话题，或错过回应时机而选择沉默；这些必须有上下文依据，不要凭空制造矛盾、机械按关键词或随机漏回。即使对方提出问题，也不代表你在任何情境下都必须回答。",
        "新消息到来时重新判断，既不强制补答此前每条消息，也不自动结束符合当前情境的沉默。明确求助或紧急情况应优先回应。",
        "忙碌或睡眠的时间说明只代表现在有机会看消息，不强制你回应。选择不回时不承诺稍后补回，不写沉默旁白、解释或省略号气泡。",
        states ? "状态参考（结合当前时间和对话判断）：\n" + states : "",
      ].filter(Boolean).join("\n") };
    });
    ctx.hooks.transform("chat.replyGate", p => {
      migrate(p.source);
      if (ctx.system.settings.get("enabled") === false) return { ...p, gate: null };
      const source = p.source;
      const mode = ctx.system.settings.get("sleepMode");
      const sleepPolicy = { mode: mode === "chance" ? 2 : 1, wakeProb: num("wakeProb", 18, 0, 100), bufferMin: num("wakeBufferMin", 10, 0, 120) };
      const busyPolicy = { peekMin: num("peekMin", 3, 0, 60), adaptive: ctx.system.settings.get("adaptive") !== false, focusedPeekProb: num("focusedPeekProb", 25, 0, 100) };
      const gate = { urgentBypass: ctx.system.settings.get("urgentBypass") !== false, updatedAt: p.nowMs };
      const override = ctx.data.variables.get("presenceOverride", "character", p.characterId);
      if (override && typeof override === "object" && override.state) {
        // Explicit online/away/hidden cancels inherited busy/sleep; expired overrides do not become permanent gates.
        if (!["busy", "sleep"].includes(override.state)) return { ...p, gate: null };
        const fromMs = Number(override.at);
        const toMs = fromMs + num("manualBusyMin", 60, 1, 720) * 60000;
        if (!Number.isFinite(fromMs) || p.nowMs < fromMs || p.nowMs >= toMs) return { ...p, gate: null };
        const now = new Date(p.nowMs), from = new Date(fromMs), to = new Date(toMs);
        gate.startsAt = fromMs; gate.expiresAt = toMs;
        if (override.state === "sleep" && mode !== "ignore") gate.sleep = { bed: hm(from), wake: hm(to), ...sleepPolicy };
        if (override.state === "busy") {
          const title = String(override.label || "手动忙碌");
          gate.busy = { date: ymd(now), ...busyPolicy, windows: [{ from: "00:00", to: "23:59", title, focused: /专注|开会|会议|上课|考试|驾驶|开车/.test(title) }] };
        }
      } else if (source) {
        if (source.sleep && mode !== "ignore") gate.sleep = { bed: source.sleep.bed, wake: source.sleep.wake, ...sleepPolicy };
        if (source.busy) gate.busy = { date: source.busy.date, ...busyPolicy, windows: source.busy.windows.map(win => ({ ...win,
          focused: typeof win.focused === "boolean" ? win.focused : /专注|开会|会议|例会|晨会|周会|月会|上课|课堂|考试|测验|开车|驾驶|手术|面试|汇报|训练|排练|实验|演出|上台/.test(win.title || ""),
        })) };
      }
      return { ...p, gate: gate.sleep || gate.busy ? gate : null };
    });
  },
};

export default busyReplyPlugin;
