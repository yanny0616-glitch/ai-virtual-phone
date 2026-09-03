// 朋友圈节奏 · 聊天插件（apiVersion 1）
// 宿主原来的规则：发完一条，下一条 = 24～48 小时里随机一个点，到点必发。
// 这个插件把它换成「每小时掷一次骰子」：概率 = 目标频率 × 时段权重 × 精力 × 事件加成。
// 作息从 ctx.data.replyGate 拿（挂念留的），精力/正在做什么从变量池 presence 拿，好感从 affection 拿。
export default {
  manifest: {
    id: "moments-rhythm",
    name: "朋友圈节奏",
    apiVersion: 1,
    version: "1.0.0",
    author: "自制",
    description: "角色发朋友圈不再到点必发：每小时按时段、作息、精力、当天的事掷一次骰子。有时一天两条，有时几天没动静。刚做完一件事、今天聊得多、好感刚涨，都更想发，而且会把由头带进提示词。",
    permissions: ["chat.read", "storage"],
    settings: [
      { key: "weeklyTarget", label: "平均每周大约发几条", type: "number", default: 3 },
      { key: "minGapHours", label: "两条之间至少隔几小时", type: "number", default: 6 },
      { key: "carryHint", label: "把由头（刚做完什么、聊得多）带进提示词", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    const HOUR = 3600000;
    // 没有作息时按这张表：0～7 点睡觉，晚上最想发
    const HOUR_W = [0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.6, 0.6, 0.6, 0.9, 0.9, 0.6, 0.6, 0.6, 0.7, 1.0, 1.2, 1.3, 1.3, 1.2, 0.8];
    const W_SUM = HOUR_W.reduce((a, b) => a + b, 0);
    const num = (k, d) => { const v = Number(ctx.system.settings.get(k)); return Number.isFinite(v) && v >= 0 ? v : d; };
    const hm = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const obj = (v) => (v && typeof v === "object" ? v : null);
    const mem = (cid) => obj(ctx.system.storage.get("c:" + cid)) || {};
    const remember = (cid, patch) => ctx.system.storage.set("c:" + cid, { ...mem(cid), ...patch });

    // 时段权重：作息优先（睡着 0、忙着 0.2），没作息按小时表
    function slotWeight(cid, now) {
      const gate = ctx.data.replyGate.get(cid);
      const cur = hm(now);
      if (gate) {
        const s = gate.sleep;
        if (s && s.bed !== s.wake) {
          const asleep = s.bed > s.wake ? (cur >= s.bed || cur < s.wake) : (cur >= s.bed && cur < s.wake);
          if (asleep) return { w: 0, why: "睡着" };
        }
        const b = gate.busy;
        if (b && b.date === ymd(now)) {
          const win = (b.windows || []).find((x) => cur >= x.from && cur < x.to);
          if (win) return { w: 0.2, why: "忙着" + (win.title ? "（" + win.title + "）" : "") };
        }
        const w = HOUR_W[now.getHours()];
        return { w: Math.max(w, 0.4), why: "" };
      }
      return { w: HOUR_W[now.getHours()], why: "" };
    }

    function todayChatCount(cid) {
      const s = ctx.data.sessions.list().find((x) => !x.isGroup && x.contactId === cid);
      if (!s) return 0;
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return ctx.data.messages.list(s.id).filter((m) => m.role !== "system" && new Date(m.createdAt).getTime() >= start.getTime()).length;
    }

    function decide(cid, lastPostTime) {
      const now = new Date();
      const nowMs = now.getTime();
      const minGap = num("minGapHours", 6) * HOUR;
      if (lastPostTime && nowMs - lastPostTime < minGap) return { post: false, retry: lastPostTime + minGap - nowMs, why: "离上一条太近" };

      const slot = slotWeight(cid, now);
      const m = mem(cid);
      const pr = obj(ctx.data.variables.get("presence", "character", cid));
      const doing = pr ? String(pr.doing || "").trim() : "";
      const hints = [];
      let boost = 1;

      // 精力：0～100 → 0.5～1.3
      if (pr && Number.isFinite(Number(pr.energy))) boost *= 0.5 + (Math.max(0, Math.min(100, Number(pr.energy))) / 100) * 0.8;
      // 刚做完一件事：上次看到的 doing 和现在不一样
      if (m.lastDoing && doing !== m.lastDoing && !(pr && pr.asleep)) { boost *= 1.5; hints.push("刚做完：" + m.lastDoing); }
      // 今天聊得多
      const chats = todayChatCount(cid);
      if (chats >= 20) { boost *= 1.3; hints.push("今天和对方聊了很多"); }
      // 好感刚涨（3 小时内有正向记录）
      const af = obj(ctx.data.variables.get("affection", "character", cid));
      const last = af && Array.isArray(af.history) ? af.history[af.history.length - 1] : null;
      if (last && Number(last.delta) > 0 && nowMs - Number(last.at || 0) < 3 * HOUR) { boost *= 1.4; hints.push("刚才对对方的好感涨了" + (last.reason ? "（" + last.reason + "）" : "")); }
      if (pr && pr.mood) hints.push("此刻情绪：" + pr.mood);
      if (pr && pr.place) hints.push("此刻在：" + pr.place);

      remember(cid, { lastDoing: doing || m.lastDoing || "", lastCheck: nowMs });

      const perDay = num("weeklyTarget", 3) / 7;
      const p = Math.min(0.9, perDay * (slot.w / W_SUM) * boost);
      const roll = Math.random();
      const post = roll < p;
      ctx.system.log(`[${cid.slice(-4)}] ${slot.why || "时段" + now.getHours() + "点"} p=${p.toFixed(3)} roll=${roll.toFixed(3)} → ${post ? "发" : "不发"}`);
      // 不发就下个整点再问；睡着直接跳到醒
      let retry = HOUR - (nowMs % HOUR) + 60000;
      if (slot.w === 0) {
        const gate = ctx.data.replyGate.get(cid);
        const wake = gate && gate.sleep ? gate.sleep.wake : "07:30";
        const [wh, wm] = wake.split(":").map(Number);
        const t = new Date(now); t.setHours(wh, wm + Math.floor(Math.random() * 30), 0, 0);
        if (t.getTime() <= nowMs) t.setDate(t.getDate() + 1);
        retry = t.getTime() - nowMs;
      }
      const hint = ctx.system.settings.get("carryHint") === false || hints.length === 0 ? "" : "可以顺着这些来，不用全提：" + hints.join("；") + "。";
      return { post, retry, hint, why: slot.why };
    }

    ctx.hooks.transform("moments.beforePost", (p) => {
      const d = decide(p.characterId, p.lastPostTime);
      if (!d.post) { p.cancelled = true; p.retryAfterMs = d.retry; return p; }
      p.hint = d.hint;
      return p;
    });

    // 发完一条不再等 24～48 小时，下个整点继续掷；首次建档也一样
    ctx.hooks.transform("moments.schedule", (p) => {
      const now = Date.now();
      if (p.reason === "postponed") return p;
      p.nextPostAfter = now + HOUR - (now % HOUR) + 60000;
      return p;
    });
  },
};
