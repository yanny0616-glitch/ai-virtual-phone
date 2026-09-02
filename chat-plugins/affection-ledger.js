// 好感与关系 · 聊天插件（apiVersion 1）
// 安装：设置 → 聊天插件 → 粘贴本文件全文。
// 与挂念共用变量池：scope "character"，affection（插件写）/ presence（挂念写）。
export default {
  manifest: {
    id: "affection-ledger",
    name: "好感与关系",
    apiVersion: 1,
    version: "1.5.0",
    author: "自制",
    description: "角色回复里自带心里话与好感变化量，插件累加成慢变的好感；关系按角色各自存，由TA按人设自己定，转折时可选经你确认或TA自己改。区间、提示词、数值都在面板里改。",
    permissions: ["chat.read", "chat.write", "ui", "storage"],
    settings: [
      { key: "showThought", label: "气泡下显示心里话（折叠）", type: "boolean", default: true },
      { key: "showDelta", label: "心里话里显示好感变化", type: "boolean", default: true },
      { key: "autoRelation", label: "关系变化时TA自己改，不用确认", type: "boolean", default: false },
    ],
  },
  setup(ctx) {
    const VAR = "affection";
    const DEFAULTS = {
      tiers: "0|陌生|还不熟，客气、有保留，不主动交心，不会撒娇也不会依赖\n15|熟人|聊得来的普通朋友，自然但有分寸，不说太私密的事\n35|在意|会惦记TA、会多问一句，愿意说心里话，但还留着一点面子\n60|亲近|很信任，会撒娇、会耍赖、会把坏情绪也给TA看\n80|离不开|TA是最重要的人，情绪被TA牵着走，会吃醋、会等消息",
      startScore: 10, maxUp: 3, maxDown: 3, dailyCap: 4, decayAfterDays: 3, decayPerDay: 1,
      pThought: "第一行起是心里话：回复前一瞬真实的念头、潜台词、没说出口的情绪、对这句话的第一反应。一两句，第一人称，不复述正文，不写任何数字。",
      pDelta: "好感 变化|理由 —— 单独一行。这一轮你对TA的感觉变了多少：-{{maxDown}} 到 +{{maxUp}} 之间的数，可以带小数（如 +0.5）。多数轮次是 0 或 ±1 以内；只有特别打动或特别伤人才到更大。理由 12 字内写具体的事（如「记得我讨厌香菜」），不写「聊得开心」这种空话。你累、忙、心情差的时候更难被打动。",
      pRelation: "关系→新关系|理由 —— 单独一行，只在两人关系真的发生转折时（表白被接受、说开了、决定不再联系、和好）才写；平时绝对不写这一行。新关系按你们的人设写，12 字内（如 朋友、暧昧、恋人、兄妹、闹翻了）。",
      pRelationInit: "两人的关系还没定：这一轮必须在 [内心] 里写一行 关系→xxx|理由，按你的人设和你们之间实际的关系写（如 兄妹、青梅竹马、同事、刚认识），12 字内。",
      pStance: "你现在对TA：{{tier}}（{{tierHint}}）；两人现在的关系：{{relation}}。说话的分寸按这个来，不要越过这个关系该有的界限，也不要冷淡得不像这个关系。",
      pStanceInit: "你现在对TA：{{tier}}（{{tierHint}}）。你们的关系按人设来。",
    };
    const cfg = () => {
      const saved = ctx.system.storage.get("cfg") || {};
      const c = Object.assign({}, DEFAULTS, saved);
      if (saved.maxStep != null && saved.maxUp == null) { c.maxUp = Number(saved.maxStep) || c.maxUp; c.maxDown = Number(saved.maxStep) || c.maxDown; } // 旧配置只有一个上限
      return c;
    };
    const setCfg = (patch) => ctx.system.storage.set("cfg", Object.assign({}, ctx.system.storage.get("cfg") || {}, patch));
    const num = (k) => { const v = Number(cfg()[k]); return Number.isFinite(v) ? v : DEFAULTS[k]; };
    const bool = (k, d) => { const v = ctx.system.settings.get(k); return v === undefined ? d : !!v; };
    const today = () => new Date().toISOString().slice(0, 10);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const parseTiers = () => {
      const rows = String(cfg().tiers).split("\n").map((l) => l.split("|")).filter((p) => p.length >= 2 && Number.isFinite(Number(p[0])))
        .map((p) => ({ min: Number(p[0]), name: p[1].trim(), hint: (p[2] || "").trim() })).sort((a, b) => a.min - b.min);
      return rows.length ? rows : [{ min: 0, name: "陌生", hint: "" }];
    };
    const tierOf = (s) => { const t = parseTiers(); let cur = t[0]; for (const x of t) if (s >= x.min) cur = x; return cur; };
    const fill = (tpl, st) => String(tpl)
      .replace(/\{\{tier\}\}/g, st.tier).replace(/\{\{tierHint\}\}/g, tierOf(st.score).hint || "")
      .replace(/\{\{relation\}\}/g, st.relation || "还没定，按人设来").replace(/\{\{score\}\}/g, String(st.score))
      .replace(/\{\{maxUp\}\}/g, String(num("maxUp"))).replace(/\{\{maxDown\}\}/g, String(num("maxDown"))).replace(/\{\{maxStep\}\}/g, String(Math.max(num("maxUp"), num("maxDown")))).replace(/\{\{stages\}\}/g, "");

    function charOf(sessionId) {
      const s = sessionId ? ctx.data.sessions.get(sessionId) : null;
      if (!s || s.isGroup) return null;
      return s.contactId || null; // 本宿主 session.contactId 即 characterId
    }
    function load(cid) {
      const v = ctx.data.variables.get(VAR, "character", cid);
      const base = v && typeof v === "object" ? v : {};
      const score = Number.isFinite(Number(base.score)) ? Number(base.score) : num("startScore");
      return {
        score, tier: tierOf(score).name,
        relation: String(base.relation || ""),
        updatedAt: Number(base.updatedAt) || 0,
        todayDate: String(base.todayDate || ""), todayDelta: Number(base.todayDelta) || 0,
        history: Array.isArray(base.history) ? base.history : [],
        relationHistory: Array.isArray(base.relationHistory) ? base.relationHistory : [],
        pendingRelation: base.pendingRelation && typeof base.pendingRelation === "object" ? base.pendingRelation : null,
      };
    }
    function save(cid, st) {
      st.score = clamp(Math.round(st.score * 10) / 10, 0, 100);
      st.tier = tierOf(st.score).name;
      st.history = st.history.slice(-40);
      st.relationHistory = st.relationHistory.slice(-20);
      ctx.data.variables.set(VAR, st, "character", cid);
      return st;
    }
    // 几天没动就慢慢回落；只在读提示词时结算，不用定时器
    function settleDecay(cid, st) {
      const after = num("decayAfterDays"), per = num("decayPerDay");
      if (!st.updatedAt || per <= 0) return st;
      const idle = (Date.now() - st.updatedAt) / 86400000;
      if (idle < after) return st;
      const drop = Math.floor(idle - after + 1) * per;
      if (drop <= 0) return st;
      st.score = Math.max(0, st.score - drop);
      st.updatedAt = Date.now();
      st.history.push({ at: Date.now(), delta: -drop, reason: "太久没联系" });
      return save(cid, st);
    }
    const r1 = (v) => Math.round(v * 10) / 10;
    function applyDelta(cid, delta, reason, manual) {
      const st = load(cid);
      const cap = num("dailyCap"), up = num("maxUp"), down = num("maxDown");
      if (st.todayDate !== today()) { st.todayDate = today(); st.todayDelta = 0; }
      let d = r1(Number(delta) || 0);
      if (!manual) {
        d = clamp(d, -down, up);
        if (d > 0) d = r1(Math.max(0, Math.min(d, cap - st.todayDelta)));
      }
      if (d !== 0) {
        st.score += d;
        if (!manual) st.todayDelta = r1(st.todayDelta + Math.max(0, d));
        st.history.push({ at: Date.now(), delta: d, reason: String(reason || "").slice(0, 40) });
      }
      st.updatedAt = Date.now();
      save(cid, st);
      return d;
    }

    // ── 提示词：心里话 + 变化量 + 关系转折，都在同一次回复里带出来 ──
    ctx.hooks.transform("prompt.system", (p) => {
      if (p.isGroup || !p.characterId) return p;
      const st = settleDecay(p.characterId, load(p.characterId));
      const c = cfg();
      p.hint = (p.hint ? p.hint + "\n\n" : "") + [
        "## 心里话与好感",
        "回复正文写完后另起一行，附一个 [内心] 块（正文里不要出现这些内容，也不要解释），格式：",
        "[内心]",
        fill(c.pThought, st),
        fill(c.pDelta, st),
        fill(st.relation ? c.pRelation : c.pRelationInit, st),
        "[/内心]",
        fill(st.relation ? c.pStance : c.pStanceInit, st),
      ].filter(Boolean).join("\n");
      return p;
    });

    // ── 截标记：从正文删掉，结算好感，心里话暂存等落库时挂到消息上 ──
    const RE_BLOCK = /\[内心\]([\s\S]*?)\[\/内心\]/;
    const RE_DELTA = /^\s*[\[（(]?好感\s*[:：]?\s*([+-]?\s*\d+(?:\.\d+)?)\s*[|｜：:]\s*([^\]\n]*)[\]）)]?\s*$/m;
    const RE_REL = /^\s*[\[（(]?关系\s*(?:→|->|:|：)\s*([^|｜\]\n]+?)\s*(?:[|｜]\s*([^\]\n]*))?[\]）)]?\s*$/m;
    ctx.hooks.transform("llm.response", (p) => {
      if (!p.sessionId) return p;
      const cid = charOf(p.sessionId);
      if (!cid) return p;
      const mb = p.text.match(RE_BLOCK);
      if (!mb) return p;
      let inner = mb[1];
      const md = inner.match(RE_DELTA), mr = inner.match(RE_REL);
      if (md) inner = inner.replace(RE_DELTA, "");
      if (mr) inner = inner.replace(RE_REL, "");
      const pend = { thought: inner.trim(), delta: 0, reason: "", relTo: "", relReason: "" };
      if (md) { pend.delta = applyDelta(cid, Number(md[1].replace(/\s/g, "")), md[2]); pend.reason = md[2].trim().slice(0, 40); }
      if (mr) {
        pend.relTo = mr[1].trim().slice(0, 12); pend.relReason = (mr[2] || "").trim().slice(0, 40);
        const st = load(cid);
        if (pend.relTo && !st.relation) { // 第一次是TA按人设定的，不用确认
          st.relationHistory.push({ at: Date.now(), from: "", to: pend.relTo, reason: pend.relReason || "TA自己定的" });
          st.relation = pend.relTo;
          save(cid, st);
          ctx.ui.toast("TA说你们是「" + pend.relTo + "」", { durationMs: 4000 });
        } else if (pend.relTo && pend.relTo !== st.relation && bool("autoRelation", false)) {
          st.relationHistory.push({ at: Date.now(), from: st.relation, to: pend.relTo, reason: pend.relReason });
          st.relation = pend.relTo; st.pendingRelation = null;
          save(cid, st);
          ctx.ui.toast("关系变了：" + pend.relTo, { durationMs: 4000 });
        } else if (pend.relTo && pend.relTo !== st.relation) {
          st.pendingRelation = { to: pend.relTo, reason: pend.relReason, at: Date.now() };
          save(cid, st);
          ctx.ui.toast("关系可能变了：" + pend.relTo + "（去好感面板确认）", { durationMs: 4000 });
        }
      }
      { const st = load(cid); pend.score = st.score; pend.tier = st.tier; pend.relation = st.relation; pend.at = Date.now(); }
      ctx.system.storage.set("pending:" + p.sessionId, pend);
      p.text = p.text.replace(RE_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
      return p;
    });
    ctx.hooks.transform("message.beforePersist", (p) => {
      const m = p.message;
      if (!m || m.role !== "assistant" || !m.sessionId) return p;
      const key = "pending:" + m.sessionId;
      const pend = ctx.system.storage.get(key);
      if (!pend) return p;
      ctx.system.storage.remove(key);
      ctx.system.storage.set("m:" + m.id, pend);
      return p;
    });

    // ── 气泡下：默认只有一个小折叠头，点开才看 ──
    ctx.ui.injectCSS(`
      .afl-side{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;color:var(--c-icon,#8e8e93);font-size:15px;line-height:1;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;opacity:.85}
      .afl-side:active{opacity:.5}
      @keyframes aflUp{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
      .afl-th{--rose:#d94f7c;--rose-2:#f2a3bd;position:absolute;left:0;right:0;bottom:0;max-height:78%;display:flex;flex-direction:column;border-radius:22px 22px 0 0;background:var(--c-panel,#fff);color:var(--c-text-title,var(--c-text,#111));box-shadow:0 -6px 30px rgba(0,0,0,.14);animation:aflUp .3s cubic-bezier(.16,1,.3,1);padding:8px 0 calc(14px + env(safe-area-inset-bottom,0px));font-size:calc(14px*var(--app-text-scale,1));line-height:1.6}
      .afl-th *{box-sizing:border-box}
      .afl-th .hdl{align-self:center;width:38px;height:4px;margin:2px 0 10px;border-radius:999px;background:color-mix(in srgb,currentColor 22%,transparent)}
      .afl-th .hd{display:flex;align-items:center;gap:8px;padding:0 14px 8px}
      .afl-th .hd b{flex:1;text-align:center;font-size:calc(16px*var(--app-text-scale,1));font-weight:600}
      .afl-th .hd .x,.afl-th .hd .sp{width:34px;height:34px;flex:0 0 auto}
      .afl-th .hd .x{border:0;border-radius:50%;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font-size:20px;line-height:34px;cursor:pointer}
      .afl-th .bd{flex:1;min-height:0;overflow-y:auto;padding:4px 18px 6px}
      .afl-th .stat{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:16px;background:linear-gradient(135deg,rgba(217,79,124,.10),rgba(150,90,220,.08))}
      .afl-th .sc{display:flex;align-items:baseline;gap:2px;color:var(--rose)}
      .afl-th .sc b{font-size:30px;font-weight:800;letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1}
      .afl-th .sc small{font-size:11px;opacity:.7}
      .afl-th .pills{display:flex;flex-wrap:wrap;gap:6px;flex:1}
      .afl-th .pill{padding:2px 10px;border-radius:999px;font-size:12px;background:color-mix(in srgb,currentColor 7%,transparent)}
      .afl-th .pill.rose{background:rgba(217,79,124,.14);color:var(--rose);font-weight:600}
      .afl-th .bar{position:absolute;left:14px;right:14px;bottom:0;height:3px;border-radius:999px;background:rgba(217,79,124,.12);overflow:hidden}
      .afl-th .bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--rose-2),var(--rose))}
      .afl-th .stat{position:relative;overflow:hidden}
      .afl-th .lab{margin:16px 0 6px;font-size:11px;letter-spacing:1px;opacity:.5}
      .afl-th .q{padding:12px 14px;border-radius:14px;border-left:3px solid var(--rose);background:rgba(217,79,124,.06);white-space:pre-wrap;line-height:1.75}
      .afl-th .ft{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:12px;font-size:12px}
      .afl-th .tag{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;background:color-mix(in srgb,currentColor 7%,transparent)}
      .afl-th .tag.up{background:rgba(217,79,124,.12);color:var(--rose)}
      .afl-th .tag.down{background:rgba(92,107,192,.12);color:#5c6bc0}
      .afl-th .tag.rel{background:rgba(150,90,220,.10);color:#8a5cd6}
      .afl-th .time{margin-left:auto;opacity:.45;font-size:11px}

      .afl-sheet{--rose:#d94f7c;--rose-2:#f2a3bd;--rose-soft:rgba(217,79,124,.10);--ink:#2a2226;--mute:rgba(42,34,38,.55);--line:rgba(42,34,38,.09);--paper:#fffaf7;--card:#fff;
        width:min(100%,400px);max-height:100%;display:flex;flex-direction:column;border-radius:28px;overflow:hidden;background:var(--paper);color:var(--ink);font-size:13px;line-height:1.5;
        box-shadow:0 24px 60px rgba(60,20,40,.28);-webkit-font-smoothing:antialiased}
      .afl-sheet *{box-sizing:border-box}
      .afl-hero{position:relative;flex:0 0 auto;padding:22px 20px 16px;overflow:hidden;background:radial-gradient(120% 90% at 10% 0%,#ffe4ec 0%,rgba(255,228,236,0) 60%),radial-gradient(90% 80% at 100% 10%,#efe1ff 0%,rgba(239,225,255,0) 55%),linear-gradient(180deg,#fff6f9 0%,#fffaf7 100%)}
      .afl-hero::before{content:"";position:absolute;right:-40px;top:-50px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(217,79,124,.16),rgba(217,79,124,0) 70%)}
      .afl-close{position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;border:0;background:rgba(42,34,38,.06);color:var(--ink);font-size:18px;line-height:30px;text-align:center;cursor:pointer}
      .afl-top{display:flex;align-items:center;gap:16px;position:relative}
      .afl-ring{position:relative;width:96px;height:96px;flex:0 0 auto}
      .afl-ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
      .afl-ring .ava{position:absolute;inset:10px;border-radius:50%;overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;color:var(--rose);box-shadow:inset 0 0 0 1px rgba(42,34,38,.06)}
      .afl-ring .ava img{width:100%;height:100%;object-fit:cover}
      .afl-who{min-width:0;flex:1}
      .afl-name{margin:0;font-size:20px;font-weight:700;letter-spacing:.3px;font-family:"Songti SC","Noto Serif SC",Georgia,serif}
      .afl-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
      .afl-pill{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:11.5px;font-weight:600;background:rgba(255,255,255,.75);border:1px solid rgba(217,79,124,.18);color:var(--rose)}
      .afl-pill.plain{color:var(--ink);border-color:var(--line)}
      .afl-pill i{width:6px;height:6px;border-radius:50%;background:var(--rose)}
      .afl-big{margin-top:8px;display:flex;align-items:baseline;gap:6px}
      .afl-big b{font-size:34px;font-weight:800;line-height:1;color:var(--rose);letter-spacing:-1.5px;font-variant-numeric:tabular-nums}
      .afl-big small{font-size:11px;color:var(--mute)}
      .afl-big em{font-style:normal;font-size:11px;color:var(--mute);margin-left:auto}
      .afl-journey{position:relative;margin:18px 0 0;padding:0 2px}
      .afl-journey .rail{position:absolute;left:8px;right:8px;top:7px;height:2px;background:var(--line)}
      .afl-journey .rail>i{position:absolute;left:0;top:0;height:100%;background:linear-gradient(90deg,var(--rose-2),var(--rose))}
      .afl-journey ul{list-style:none;margin:0;padding:0;display:flex;justify-content:space-between;position:relative}
      .afl-journey li{display:flex;flex-direction:column;align-items:center;gap:5px;font-size:10.5px;color:var(--mute);width:16px;white-space:nowrap}
      .afl-journey li b{width:16px;height:16px;border-radius:50%;background:var(--paper);border:2px solid var(--line);display:block}
      .afl-journey li.past b{border-color:var(--rose-2);background:var(--rose-2)}
      .afl-journey li.now b{border-color:var(--rose);background:var(--rose);box-shadow:0 0 0 4px rgba(217,79,124,.15)}
      .afl-journey li.now{color:var(--rose);font-weight:700}
      .afl-tabs{flex:0 0 auto;display:flex;gap:4px;margin:14px 16px 0;padding:3px;border-radius:14px;background:rgba(42,34,38,.05)}
      .afl-tabs button{flex:1;padding:8px 0;border-radius:11px;border:0;background:transparent;color:var(--mute);font-size:12.5px;font-weight:600;cursor:pointer}
      .afl-tabs button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 4px rgba(0,0,0,.08)}
      .afl-scroll{overflow:auto;padding:12px 16px 20px;flex:1 1 auto;min-height:0}
      .afl-card{border:1px solid var(--line);border-radius:18px;padding:13px 15px;margin:0 0 10px;background:var(--card);box-shadow:0 1px 2px rgba(42,34,38,.03)}
      .afl-card.soft{background:linear-gradient(135deg,#fff0f5,#fbe9ff);border-color:transparent}
      .afl-card h4{margin:0 0 9px;font-size:11px;font-weight:700;letter-spacing:.8px;color:var(--mute);display:flex;align-items:center;gap:6px}
      .afl-card h4::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--rose)}
      .afl-presence{display:flex;gap:12px;align-items:flex-start}
      .afl-presence .ic{width:38px;height:38px;border-radius:12px;flex:0 0 auto;background:var(--rose-soft);display:flex;align-items:center;justify-content:center;color:var(--rose)}
      .afl-presence .main{font-weight:600;font-size:14px}
      .afl-presence .meta{font-size:12px;color:var(--mute);margin-top:2px;line-height:1.6}
      .afl-presence .age{font-size:11px;color:var(--mute);margin-top:4px;opacity:.8}
      .afl-quote{font-size:14px;line-height:1.7;font-family:"Songti SC","Noto Serif SC",Georgia,serif}
      .afl-quote::before{content:"“";color:var(--rose);font-size:20px;line-height:0;margin-right:2px}
      .afl-note{font-size:11.5px;color:var(--mute);margin-top:8px;display:flex;align-items:center;gap:6px}
      .afl-note .dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--rose-2)}
      .afl-chips{display:flex;flex-wrap:wrap;gap:7px}
      .afl-chip{padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--paper);color:var(--ink);font-size:12px;cursor:pointer}
      .afl-chip.on{background:var(--rose);border-color:var(--rose);color:#fff;font-weight:600;box-shadow:0 4px 12px rgba(217,79,124,.25)}
      .afl-chip.ghost{border-style:dashed;color:var(--mute);background:transparent}
      .afl-inline{display:flex;gap:8px;align-items:center;margin-top:10px}
      .afl-input{flex:1;min-width:0;padding:9px 12px;border:1px solid var(--line);border-radius:12px;font-size:13px;background:var(--paper);color:var(--ink)}
      .afl-input.num{flex:0 0 74px;text-align:center;font-weight:700}
      .afl-btn{padding:8px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
      .afl-btn.pri{background:var(--rose);border-color:var(--rose);color:#fff;box-shadow:0 4px 12px rgba(217,79,124,.25)}
      .afl-btn.danger{color:#c62828;background:transparent}
      .afl-btn:active{transform:scale(.97)}
      .afl-step{display:inline-flex;align-items:center;border-radius:12px;background:var(--rose-soft);padding:2px}
      .afl-step button{width:36px;height:32px;border:0;border-radius:10px;background:transparent;color:var(--rose);font-size:18px;font-weight:700;cursor:pointer}
      .afl-step button:active{background:rgba(255,255,255,.7)}
      .afl-step span{min-width:44px;text-align:center;font-weight:800;color:var(--rose);font-variant-numeric:tabular-nums}
      .afl-pending{display:flex;flex-direction:column;gap:8px}
      .afl-pending .t{font-weight:700;font-size:14px}
      .afl-pending .t b{color:var(--rose)}
      .afl-pending .r{font-size:12.5px;color:var(--mute);font-family:"Songti SC","Noto Serif SC",Georgia,serif}
      .afl-pending .acts{display:flex;gap:8px;margin-top:2px}
      .afl-line{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid var(--line)}
      .afl-line:first-of-type{border-top:0;padding-top:0}
      .afl-line .l{font-size:13px;font-weight:600}
      .afl-line .h{font-size:11px;color:var(--mute);margin-top:1px;font-weight:400}
      .afl-sw{position:relative;width:44px;height:26px;flex:0 0 auto}
      .afl-sw input{opacity:0;width:0;height:0;position:absolute}
      .afl-sw i{position:absolute;inset:0;border-radius:13px;background:rgba(42,34,38,.16);transition:background .15s}
      .afl-sw i::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s}
      .afl-sw input:checked+i{background:var(--rose)}
      .afl-sw input:checked+i::after{transform:translateX(18px)}
      .afl-tl{list-style:none;margin:0;padding:0 0 0 14px;position:relative}
      .afl-tl::before{content:"";position:absolute;left:3px;top:6px;bottom:6px;width:2px;background:var(--line);border-radius:1px}
      .afl-tl li{position:relative;display:flex;align-items:center;gap:10px;padding:6px 0}
      .afl-tl li::before{content:"";position:absolute;left:-14px;top:50%;width:8px;height:8px;margin-top:-4px;border-radius:50%;background:var(--rose-2);box-shadow:0 0 0 3px var(--card)}
      .afl-tl li.down::before{background:#8e9bd8}
      .afl-tl li.zero::before{background:rgba(42,34,38,.2)}
      .afl-tl .d{flex:0 0 auto;min-width:42px;text-align:center;padding:3px 7px;border-radius:9px;font-size:12px;font-weight:800;background:var(--rose-soft);color:var(--rose);font-variant-numeric:tabular-nums}
      .afl-tl li.down .d{background:rgba(92,107,192,.12);color:#5c6bc0}
      .afl-tl li.zero .d{background:rgba(42,34,38,.06);color:var(--mute)}
      .afl-tl .w{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .afl-tl .t{flex:0 0 auto;font-size:11px;color:var(--mute);font-variant-numeric:tabular-nums}
      .afl-empty{color:var(--mute);font-size:12px;text-align:center;padding:8px 0}
      .afl-path{font-size:12px;color:var(--mute);margin-top:10px}
      .afl-path b{color:var(--ink);font-weight:600}
      .afl-field{margin:0 0 12px}
      .afl-field:last-child{margin-bottom:0}
      .afl-field label{display:block;font-size:12.5px;font-weight:700;margin:0 0 3px}
      .afl-field .h{font-size:11px;color:var(--mute);margin:0 0 6px}
      .afl-ta{width:100%;min-height:68px;padding:9px 11px;border:1px solid var(--line);border-radius:12px;font-size:12px;line-height:1.55;font-family:inherit;background:var(--paper);color:var(--ink);resize:vertical}
      .afl-ta:focus{outline:none;border-color:var(--rose-2);box-shadow:0 0 0 3px rgba(217,79,124,.12)}
      .afl-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
      .afl-grid .cell{border:1px solid var(--line);border-radius:14px;padding:9px 12px;background:var(--paper)}
      .afl-grid .cell label{display:block;font-size:11px;color:var(--mute);margin-bottom:2px}
      .afl-grid .cell input{width:100%;border:0;padding:0;font-size:18px;font-weight:800;background:transparent;color:var(--rose);font-variant-numeric:tabular-nums}
      .afl-grid .cell input:focus{outline:none}
      .afl-foot{display:flex;gap:8px;justify-content:flex-end;padding-top:4px}
      @media (prefers-color-scheme: dark){
        .afl-sheet{--ink:#f3edf0;--mute:rgba(243,237,240,.55);--line:rgba(255,255,255,.1);--paper:#1e191c;--card:#262023;--rose-soft:rgba(217,79,124,.18)}
        .afl-hero{background:radial-gradient(120% 90% at 10% 0%,rgba(217,79,124,.28) 0%,rgba(217,79,124,0) 60%),radial-gradient(90% 80% at 100% 10%,rgba(150,90,220,.25) 0%,rgba(150,90,220,0) 55%),var(--paper)}
        .afl-pill{background:rgba(255,255,255,.08)}
        .afl-ring .ava{background:#2a2327}
        .afl-card.soft{background:linear-gradient(135deg,rgba(217,79,124,.18),rgba(150,90,220,.16))}
        .afl-close{background:rgba(255,255,255,.1)}
      }
    `);
    function openThoughtSheet(m, pend) {
      ctx.ui.openModal((el, api) => {
        el.style.cssText = "display:contents";
        const showD = bool("showDelta", true);
        const hasScore = Number.isFinite(Number(pend.score));
        const tags = [];
        if (showD && pend.delta) tags.push(`<span class="tag ${pend.delta > 0 ? "up" : "down"}">好感 ${pend.delta > 0 ? "+" : ""}${pend.delta}${pend.reason ? " · " + esc(pend.reason) : ""}</span>`);
        if (pend.relTo) tags.push(`<span class="tag rel">关系→${esc(pend.relTo)}${pend.relReason ? " · " + esc(pend.relReason) : ""}</span>`);
        el.innerHTML = `<div class="afl-th" role="dialog" aria-label="TA的心里话">
          <div class="hdl"></div>
          <div class="hd"><span class="sp"></span><b>TA的心里话</b><button class="x" data-x aria-label="关闭">×</button></div>
          <div class="bd">
            ${hasScore && showD ? `<div class="stat"><div class="sc"><b>${pend.score}</b><small>/ 100</small></div><div class="pills">${pend.tier ? `<span class="pill rose">${esc(pend.tier)}</span>` : ""}${pend.relation ? `<span class="pill">${esc(pend.relation)}</span>` : ""}</div><div class="bar"><i style="width:${Math.max(0, Math.min(100, Number(pend.score)))}%"></i></div></div>` : ""}
            <div class="lab">那一刻的念头</div>
            <div class="q">${esc(pend.thought || "（没写心里话）")}</div>
            <div class="ft">${tags.join("")}${pend.at ? `<span class="time">${fmt(pend.at)}</span>` : ""}</div>
          </div>
        </div>`;
        el.querySelector("[data-x]").addEventListener("click", () => api.close());
        el.querySelector(".afl-th").addEventListener("click", (e) => e.stopPropagation());
      });
    }
    ctx.ui.slot("message.side", (el, props) => {
      const m = props.message;
      if (!m || m.role !== "assistant" || !bool("showThought", true)) return;
      const pend = ctx.system.storage.get("m:" + m.id);
      if (!pend || (!pend.thought && !pend.delta)) return;
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "afl-side"; btn.textContent = "💭"; btn.setAttribute("aria-label", "看TA的心里话");
      btn.addEventListener("pointerdown", (e) => e.stopPropagation()); // 气泡有长按菜单
      btn.addEventListener("click", (e) => { e.stopPropagation(); openThoughtSheet(m, pend); });
      el.appendChild(btn);
    });

    // ── 面板：入口在输入栏「+」面板里 ──
    let currentSessionId = null;
    ctx.hooks.on("session.opened", (p) => { currentSessionId = p.isGroup ? null : p.sessionId; });
    ctx.ui.slot("chat.inputToolbar", (el, props) => {
      if (props.isGroup) return;
      // 和「+」面板里的内置按钮同一套结构，排在它们后面
      const b = document.createElement("div");
      b.className = "chat-plus-menu-item flex flex-col items-center gap-1.5 cursor-pointer";
      b.innerHTML = '<div class="chat-plus-icon-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e5527f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg></div><span class="ts-11">好感</span>';
      b.onclick = () => openPanel(props.sessionId || currentSessionId);
      el.appendChild(b);
    });
    // 挂念写进变量池的此刻快照（presence）；没装挂念就没有这一行
    function presenceHtml(cid) {
      const pr = ctx.data.variables.get("presence", "character", cid);
      if (!pr || typeof pr !== "object" || !pr.doing) return "";
      const ageMin = pr.at ? Math.round((Date.now() - Number(pr.at)) / 60000) : null;
      const bits = [
        (pr.asleep ? "在睡觉" : "正在" + pr.doing) + (pr.step ? "（" + pr.step + "）" : ""),
        pr.place ? "📍 " + pr.place : "",
        pr.mood ? "情绪 " + pr.mood : "",
        Number.isFinite(Number(pr.energy)) ? "精力 " + pr.energy + "%" : "",
        pr.next ? "接下来 " + pr.next : "",
      ].filter(Boolean).map(esc).join(" · ");
      return `<div class="afl-presence">${bits}${ageMin != null && ageMin > 30 ? `<span class="t">（${ageMin >= 120 ? Math.round(ageMin / 60) + " 小时" : ageMin + " 分钟"}前的快照）</span>` : ""}</div>`;
    }
    const fmt = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
    const sw = (key, checked) => `<label class="afl-sw"><input type="checkbox" data-s="${key}" ${checked ? "checked" : ""}><i></i></label>`;

    const ICON = {
      clock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      moon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    };
    function heroHtml(ch, st) {
      const tier = tierOf(st.score);
      const list = st.relationHistory.map((r) => r.from).concat([st.relation]).map((x) => x || "没定").filter((x, i, a) => i === 0 || x !== a[i - 1]);
      const idx = list.length - 1;
      const R = 44, C = 2 * Math.PI * R;
      const ava = ch && ch.avatar ? `<img src="${esc(ch.avatar)}" alt="">` : esc((ch && ch.name || "?").slice(0, 1));
      const capNote = st.todayDate === today() && st.todayDelta ? `今天 +${st.todayDelta} / ${num("dailyCap")}` : "今天还没涨";
      return `<div class="afl-hero">
        <button class="afl-close" data-a="close" aria-label="关闭">×</button>
        <div class="afl-top">
          <div class="afl-ring">
            <svg viewBox="0 0 96 96" width="96" height="96"><circle cx="48" cy="48" r="${R}" fill="none" stroke="rgba(217,79,124,.14)" stroke-width="5"/><circle cx="48" cy="48" r="${R}" fill="none" stroke="url(#aflg)" stroke-width="5" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - st.score / 100)}"/><defs><linearGradient id="aflg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2a3bd"/><stop offset="1" stop-color="#d94f7c"/></linearGradient></defs></svg>
            <div class="ava">${ava}</div>
          </div>
          <div class="afl-who">
            <p class="afl-name">${esc(ch ? ch.name : "TA")}</p>
            <div class="afl-pills"><span class="afl-pill"><i></i>${esc(tier.name)}</span><span class="afl-pill plain">${esc(st.relation || "关系还没定")}</span></div>
            <div class="afl-big"><b>${st.score}</b><small>/ 100</small><em>${capNote}</em></div>
          </div>
        </div>
        <div class="afl-journey">
          <div class="rail"><i style="width:${list.length > 1 ? (idx / (list.length - 1)) * 100 : 0}%"></i></div>
          <ul>${list.map((n, i) => `<li class="${i < idx ? "past" : "now"}"><b></b><span>${esc(n)}</span></li>`).join("")}</ul>
        </div>
      </div>`;
    }
    function statusHtml(cid, st) {
      const tier = tierOf(st.score);
      return `
        ${presenceCard(cid)}
        ${st.pendingRelation ? `<div class="afl-card soft"><div class="afl-pending">
          <div class="t">TA觉得，你们现在是<b>「${esc(st.pendingRelation.to)}」</b>了</div>
          ${st.pendingRelation.reason ? `<div class="r">${esc(st.pendingRelation.reason)}</div>` : ""}
          <div class="acts"><button class="afl-btn pri" data-a="accept">就是这样</button><button class="afl-btn" data-a="dismiss">没有变</button></div>
        </div></div>` : ""}
        <div class="afl-card"><h4>在线状态</h4><div class="afl-chips">${presenceChips(cid)}</div><div class="afl-note"><span class="dot"></span>聊天列表的小点和标题下的小字都跟这个走；「自动」按挂念的作息判</div></div>
        <div class="afl-card"><h4>此刻的分寸</h4><div class="afl-quote">${esc(tier.hint || "这一档还没写分寸提示")}</div><div class="afl-note"><span class="dot"></span>这段会注进提示词，告诉TA该怎么对你</div></div>
        <div class="afl-card"><h4>关系</h4><div class="afl-quote">${esc(st.relation || "还没定：下一轮聊天TA会按人设自己说")}</div>
          <div class="afl-inline"><input class="afl-input" type="text" data-k="relText" placeholder="手动改，12 字内" maxlength="12"><button class="afl-btn pri" data-a="saveRelText">设为</button>${st.relation ? `<button class="afl-btn" data-a="askRel">让TA重新定</button>` : ""}</div>
          <div class="afl-line"><div><div class="l">关系变化时TA自己改</div><div class="h">关掉就先问你，你点「就是这样」才变</div></div>${sw("autoRelation", bool("autoRelation", false))}</div>
          <div class="afl-note"><span class="dot"></span>关系按角色各自存，换角色不会带过去</div>
        </div>
        <div class="afl-card"><h4>手动调整</h4><div class="afl-inline" style="margin-top:0">
          <div class="afl-step"><button data-a="minus">−</button><span>${st.score}</span><button data-a="plus">＋</button></div>
          <input class="afl-input num" type="number" step="0.1" data-k="setScore" value="${st.score}" min="0" max="100"><button class="afl-btn" data-a="setScore">设为</button>
        </div></div>
        <div class="afl-card">
          <div class="afl-line"><div><div class="l">气泡下显示心里话</div><div class="h">折叠成一个 💭，点开才看</div></div>${sw("showThought", bool("showThought", true))}</div>
          <div class="afl-line"><div><div class="l">心里话里显示好感变化</div><div class="h">关掉就只看心里话</div></div>${sw("showDelta", bool("showDelta", true))}</div>
        </div>
        <div class="afl-card"><h4>最近变化</h4><ul class="afl-tl">${st.history.slice().reverse().slice(0, 12).map((h) => `<li class="${h.delta > 0 ? "up" : h.delta < 0 ? "down" : "zero"}"><span class="d">${h.delta > 0 ? "+" : ""}${h.delta}</span><span class="w">${esc(h.reason || "")}</span><span class="t">${fmt(h.at)}</span></li>`).join("") || "<li class='afl-empty'>还没有记录，聊两句就有了</li>"}</ul>
          ${st.relationHistory.length ? `<div class="afl-path">关系走过：${st.relationHistory.map((r) => esc(r.from || "没定") + " → <b>" + esc(r.to || "没定") + "</b>").join("，")}</div>` : ""}
        </div>
        <div class="afl-foot"><button class="afl-btn danger" data-a="reset">重置这个角色</button></div>`;
    }
    const PRESENCE_STATES = [["", "自动"], ["online", "在线"], ["busy", "忙碌"], ["sleep", "睡觉"], ["away", "离开"], ["hidden", "隐身"]];
    function presenceChips(cid) {
      const ov = ctx.data.variables.get("presenceOverride", "character", cid);
      const cur = ov && typeof ov === "object" && ov.state ? String(ov.state) : "";
      return PRESENCE_STATES.map(([v, label]) => `<button class="afl-chip ${v === cur ? "on" : ""}" data-pres="${v}">${label}</button>`).join("");
    }
    function presenceCard(cid) {
      const pr = ctx.data.variables.get("presence", "character", cid);
      if (!pr || typeof pr !== "object" || !pr.doing) return "";
      const ageMin = pr.at ? Math.round((Date.now() - Number(pr.at)) / 60000) : null;
      const meta = [pr.place ? "📍 " + pr.place : "", pr.mood ? "情绪 " + pr.mood : "", Number.isFinite(Number(pr.energy)) ? "精力 " + pr.energy + "%" : "", pr.next ? "接下来 " + pr.next : ""].filter(Boolean).map(esc).join(" · ");
      return `<div class="afl-card"><h4>此刻</h4><div class="afl-presence"><div class="ic">${pr.asleep ? ICON.moon : ICON.clock}</div><div>
        <div class="main">${esc(pr.asleep ? "在睡觉" : "正在" + pr.doing)}${pr.step ? "<span style='font-weight:400;opacity:.7'>（" + esc(pr.step) + "）</span>" : ""}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ""}
        ${ageMin != null && ageMin > 30 ? `<div class="age">${ageMin >= 120 ? Math.round(ageMin / 60) + " 小时" : ageMin + " 分钟"}前挂念同步的快照</div>` : ""}
      </div></div></div>`;
    }
    function settingsHtml() {
      const c = cfg();
      const ta = (k, label, help, rows) => `<div class="afl-field"><label>${label}</label>${help ? `<div class="h">${help}</div>` : ""}<textarea class="afl-ta" data-c="${k}" rows="${rows || 3}">${esc(c[k])}</textarea></div>`;
      const cell = (k, label, min, max) => `<div class="cell"><label>${label}</label><input type="number" step="0.1" data-cn="${k}" value="${num(k)}" min="${min}" max="${max}"></div>`;
      return `
        <div class="afl-card"><h4>数值</h4><div class="afl-grid">
          ${cell("maxUp", "单轮最多涨", 0, 20)}${cell("maxDown", "单轮最多跌", 0, 20)}
          ${cell("dailyCap", "每天最多涨", 0, 50)}
          ${cell("decayAfterDays", "几天不聊开始回落", 0, 60)}${cell("decayPerDay", "回落每天掉", 0, 20)}
          ${cell("startScore", "新角色起始好感", 0, 100)}
        </div></div>
        <div class="afl-card"><h4>好感区间</h4>${ta("tiers", "一行一档", "格式：起始分|名字|这一档的分寸提示（会注入提示词）", 6)}</div>
        <div class="afl-card"><h4>提示词</h4>
          ${ta("pThought", "心里话怎么写", "", 3)}
          ${ta("pDelta", "好感怎么判", "占位：{{maxUp}} {{maxDown}}", 4)}
          ${ta("pRelationInit", "关系还没定时怎么让TA定", "第一轮用；TA写的关系直接采用，不用确认", 2)}
          ${ta("pRelation", "关系转折怎么判", "", 3)}
          ${ta("pStance", "分寸怎么说", "占位：{{tier}} {{tierHint}} {{relation}} {{score}}", 3)}
          ${ta("pStanceInit", "关系还没定时分寸怎么说", "", 2)}
        </div>
        <div class="afl-foot"><button class="afl-btn" data-a="resetCfg">恢复默认</button><button class="afl-btn pri" data-a="saveCfg">保存</button></div>`;
    }
    function openPanel(sessionId) {
      const cid = charOf(sessionId);
      if (!cid) { ctx.ui.toast("这个面板只在单聊里用"); return; }
      const ch = ctx.data.characters.get(cid);
      let tab = "status";
      ctx.ui.openModal((el, api) => {
        // 宿主给的容器只当透明壳，让底页自己做遮罩的直接子项，高度按遮罩算而不是按窗口
        el.style.cssText = "display:contents";
        const paint = () => {
          const st = settleDecay(cid, load(cid));
          el.innerHTML = `<div class="afl-sheet">
            ${heroHtml(ch, st)}
            <div class="afl-tabs"><button data-t="status" class="${tab === "status" ? "on" : ""}">状态</button><button data-t="settings" class="${tab === "settings" ? "on" : ""}">设置</button></div>
            <div class="afl-scroll">${tab === "status" ? statusHtml(cid, st) : settingsHtml()}</div>
          </div>`;
          el.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => { tab = b.getAttribute("data-t"); paint(); }));
          el.querySelectorAll("[data-pres]").forEach((b) => b.addEventListener("click", () => {
            const v = b.getAttribute("data-pres");
            if (v) ctx.data.variables.set("presenceOverride", { state: v, at: Date.now() }, "character", cid);
            else ctx.data.variables.unset("presenceOverride", "character", cid);
            paint();
          }));
          el.querySelectorAll("[data-a]").forEach((btn) => btn.addEventListener("click", () => {
            const a = btn.getAttribute("data-a");
            if (a === "close") return api.close();
            if (a === "saveCfg") {
              const patch = {};
              el.querySelectorAll("[data-c]").forEach((t) => { patch[t.getAttribute("data-c")] = t.value; });
              el.querySelectorAll("[data-cn]").forEach((i) => { patch[i.getAttribute("data-cn")] = Number(i.value) || 0; });
              setCfg(patch); ctx.ui.toast("已保存"); paint(); return;
            }
            if (a === "resetCfg") { if (!confirm("恢复全部默认设置？")) return; ctx.system.storage.remove("cfg"); paint(); return; }
            const s = load(cid);
            if (a === "accept" && s.pendingRelation) { s.relationHistory.push({ at: Date.now(), from: s.relation, to: s.pendingRelation.to, reason: s.pendingRelation.reason }); s.relation = s.pendingRelation.to; s.pendingRelation = null; }
            if (a === "dismiss") s.pendingRelation = null;
            if (a === "askRel") { s.relationHistory.push({ at: Date.now(), from: s.relation, to: "", reason: "让TA重新定" }); s.relation = ""; s.pendingRelation = null; ctx.ui.toast("下一轮聊天TA会自己说"); }
            if (a === "saveRelText") {
              const v = el.querySelector("[data-k=relText]").value.trim();
              if (v && v !== s.relation) { s.relationHistory.push({ at: Date.now(), from: s.relation, to: v, reason: "手动改" }); s.relation = v; }
            }
            if (a === "plus" || a === "minus") { applyDelta(cid, a === "plus" ? 1 : -1, "手动调整", true); paint(); return; }
            if (a === "setScore") { const v = clamp(Number(el.querySelector("[data-k=setScore]").value) || 0, 0, 100); applyDelta(cid, v - s.score, "手动设为 " + v, true); paint(); return; }
            if (a === "reset") { if (!confirm("清空这个角色的好感与关系记录？")) return; ctx.data.variables.unset(VAR, "character", cid); paint(); return; }
            save(cid, s); paint();
          }));
          el.querySelectorAll("[data-s]").forEach((cb) => cb.addEventListener("change", () => ctx.system.settings.set(cb.getAttribute("data-s"), cb.checked)));
        };
        paint();
      });
    }
  },
};
