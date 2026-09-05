// 个性签名 · 聊天插件（apiVersion 1）
// 朋友圈主页上那句签名由TA自己写：每次回你消息时按小概率（心情刚变过时翻倍）允许TA在正文末尾用
// [签名]xxx 换一句；截下来存进变量池 profile.signature（scope character），主页读的就是这份。
// 还没有签名时每次都问，第一句尽快落下来。你在主页上改过的（by=user）也照样可能被TA再换掉。
export default {
  manifest: {
    id: "profile-signature",
    name: "个性签名",
    apiVersion: 1,
    version: "1.0.0",
    author: "自制",
    description: "朋友圈主页的签名让TA自己写：回消息时偶尔（默认 8%）顺手换一句，心情刚变过时更容易换。截下来存到 profile 变量，主页直接显示。",
    permissions: ["chat.read", "ui"],
    settings: [
      { key: "prob", label: "每次回复换签名的概率（%）", type: "number", default: 8 },
      { key: "moodBoost", label: "心情刚变过时概率翻倍", type: "boolean", default: true },
      { key: "toast", label: "换了签名弹一下提示", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    const VAR = "profile";
    const MAX_LEN = 40;
    const num = (k, d) => { const v = Number(ctx.system.settings.get(k)); return Number.isFinite(v) ? v : d; };
    const bool = (k, d) => { const v = ctx.system.settings.get(k); return v === undefined ? d : !!v; };
    // 同一次生成里 prompt.system 和 llm.response 分属两个钩子，用 sessionId 记「这次问了没」；没问的回复里出现标记也不收，
    // 免得模型自作主张时把正文一句话截走。
    const asked = new Map();

    function charOf(sessionId) {
      const s = sessionId ? ctx.data.sessions.get(sessionId) : null;
      if (!s || s.isGroup) return null;
      return s.contactId || null;
    }
    function load(cid) {
      const v = ctx.data.variables.get(VAR, "character", cid);
      return v && typeof v === "object" ? { ...v } : {};
    }
    function moodOf(cid) {
      const pr = ctx.data.variables.get("presence", "character", cid);
      return pr && typeof pr === "object" ? String(pr.mood || "") : "";
    }

    ctx.hooks.transform("prompt.system", (p) => {
      if (p.isGroup || !p.characterId) return p;
      const st = load(p.characterId);
      const sig = String(st.signature || "").trim();
      const mood = moodOf(p.characterId);
      let prob = Math.max(0, Math.min(100, num("prob", 8))) / 100;
      if (bool("moodBoost", true) && mood && mood !== String(st.moodSeen || "")) prob = Math.min(1, prob * 2);
      const ask = !sig || Math.random() < prob;
      if (mood !== String(st.moodSeen || "")) { st.moodSeen = mood; ctx.data.variables.set(VAR, st, "character", p.characterId); }
      if (!ask) return p;
      if (p.sessionId) asked.set(p.sessionId, Date.now());
      p.hint = (p.hint ? p.hint + "\n\n" : "") + [
        "## 个性签名",
        sig
          ? "你朋友圈主页现在的签名是「" + sig + "」。如果此刻的心境和它不一样了，可以在回复最末尾另起一行写 [签名]新的一句 来换掉；没想换就什么都别写。"
          : "你朋友圈主页还没有签名。在回复最末尾另起一行写 [签名]一句话，给自己定一句签名（像你平时会挂在主页上的那种，不解释）。",
        "签名要短（" + MAX_LEN + " 字以内），是你自己的口吻，不要复述人设，不要引号。正文里别提签名这回事。",
      ].join("\n");
      return p;
    });

    const RE = /^[ \t]*[\[【]\s*签名\s*[\]】][ \t]*[:：]?[ \t]*(.+?)[ \t]*$/m;
    ctx.hooks.transform("llm.response", (p) => {
      if (!p.sessionId || !p.text) return p;
      const askedAt = asked.get(p.sessionId);
      if (!askedAt) return p;
      asked.delete(p.sessionId);
      const cid = charOf(p.sessionId);
      if (!cid) return p;
      const m = p.text.match(RE);
      if (!m) return p;
      p.text = p.text.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
      const sig = m[1].replace(/^["“「『]+|["”」』]+$/g, "").trim().slice(0, MAX_LEN);
      if (!sig) return p;
      const st = load(cid);
      if (sig === String(st.signature || "").trim()) return p;
      ctx.data.variables.set(VAR, { ...st, signature: sig, at: Date.now(), by: "self" }, "character", cid);
      if (bool("toast", true)) ctx.ui.toast("TA换了签名：" + sig, { durationMs: 4000 });
      return p;
    });
  },
};
