// 好感与关系 · 聊天插件（apiVersion 1）
// 安装：设置 → 聊天插件 → 粘贴本文件全文。
// 与挂念共用变量池：scope "character"，affection（插件写）/ presence（挂念写）。
export default {
  manifest: {
    id: "affection-ledger",
    name: "好感与关系",
    apiVersion: 1,
    version: "1.1.0",
    author: "自制",
    description: "角色回复里自带心里话与好感变化量，插件累加成慢变的好感；关系只在转折点经你确认才变。区间、关系阶段、提示词、数值都在面板里改。",
    permissions: ["chat.read", "chat.write", "ui", "storage"],
    settings: [
      { key: "showThought", label: "气泡下显示心里话（折叠）", type: "boolean", default: true },
      { key: "showDelta", label: "心里话里显示好感变化", type: "boolean", default: true },
    ],
  },
  setup(ctx) {
    const VAR = "affection";
    const DEFAULTS = {
      tiers: "0|陌生|还不熟，客气、有保留，不主动交心，不会撒娇也不会依赖\n15|熟人|聊得来的普通朋友，自然但有分寸，不说太私密的事\n35|在意|会惦记TA、会多问一句，愿意说心里话，但还留着一点面子\n60|亲近|很信任，会撒娇、会耍赖、会把坏情绪也给TA看\n80|离不开|TA是最重要的人，情绪被TA牵着走，会吃醋、会等消息",
      stages: "刚认识\n朋友\n暧昧\n恋人\n冷战\n分开了",
      startScore: 10, maxStep: 3, dailyCap: 4, decayAfterDays: 3, decayPerDay: 1,
      pThought: "第一行起是心里话：回复前一瞬真实的念头、潜台词、没说出口的情绪、对这句话的第一反应。一两句，第一人称，不复述正文，不写任何数字。",
      pDelta: "好感 变化|理由 —— 单独一行。这一轮你对TA的感觉变了多少：-{{maxStep}} 到 +{{maxStep}} 的整数。多数轮次是 0 或 ±1；只有特别打动或特别伤人才到更大。理由 12 字内写具体的事（如「记得我讨厌香菜」），不写「聊得开心」这种空话。你累、忙、心情差的时候更难被打动。",
      pRelation: "关系→新关系|理由 —— 单独一行，只在两人关系真的发生转折时（表白被接受、说开了、决定不再联系、和好）才写；平时绝对不写这一行。可选的关系：{{stages}}。",
      pStance: "你现在对TA：{{tier}}（{{tierHint}}）；两人现在的关系：{{relation}}。说话的分寸按这个来，不要越过这个关系该有的界限，也不要冷淡得不像这个关系。",
    };
    const cfg = () => Object.assign({}, DEFAULTS, ctx.system.storage.get("cfg") || {});
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
    const stages = () => String(cfg().stages).split("\n").map((s) => s.trim()).filter(Boolean);
    const fill = (tpl, st) => String(tpl)
      .replace(/\{\{tier\}\}/g, st.tier).replace(/\{\{tierHint\}\}/g, tierOf(st.score).hint || "")
      .replace(/\{\{relation\}\}/g, st.relation).replace(/\{\{score\}\}/g, String(st.score))
      .replace(/\{\{maxStep\}\}/g, String(num("maxStep"))).replace(/\{\{stages\}\}/g, stages().join("、"));

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
        relation: String(base.relation || stages()[0] || "刚认识"),
        updatedAt: Number(base.updatedAt) || 0,
        todayDate: String(base.todayDate || ""), todayDelta: Number(base.todayDelta) || 0,
        history: Array.isArray(base.history) ? base.history : [],
        relationHistory: Array.isArray(base.relationHistory) ? base.relationHistory : [],
        pendingRelation: base.pendingRelation && typeof base.pendingRelation === "object" ? base.pendingRelation : null,
      };
    }
    function save(cid, st) {
      st.score = clamp(Math.round(st.score), 0, 100);
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
    function applyDelta(cid, delta, reason, manual) {
      const st = load(cid);
      const cap = num("dailyCap"), step = num("maxStep");
      if (st.todayDate !== today()) { st.todayDate = today(); st.todayDelta = 0; }
      let d = Math.round(delta);
      if (!manual) {
        d = clamp(d, -step, step);
        if (d > 0) d = Math.max(0, Math.min(d, cap - st.todayDelta));
      }
      if (d !== 0) {
        st.score += d;
        if (!manual) st.todayDelta += Math.max(0, d);
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
        fill(c.pRelation, st),
        "[/内心]",
        fill(c.pStance, st),
      ].filter(Boolean).join("\n");
      return p;
    });

    // ── 截标记：从正文删掉，结算好感，心里话暂存等落库时挂到消息上 ──
    const RE_BLOCK = /\[内心\]([\s\S]*?)\[\/内心\]/;
    const RE_DELTA = /^\s*[\[（(]?好感\s*[:：]?\s*([+-]?\s*\d+)\s*[|｜：:]\s*([^\]\n]*)[\]）)]?\s*$/m;
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
        if (pend.relTo && pend.relTo !== st.relation) {
          st.pendingRelation = { to: pend.relTo, reason: pend.relReason, at: Date.now() };
          save(cid, st);
          ctx.ui.toast("关系可能变了：" + pend.relTo + "（去好感面板确认）", { durationMs: 4000 });
        }
      }
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
      .afl-fold{display:inline-flex;align-items:center;gap:4px;margin-top:3px;font-size:11px;opacity:.55;cursor:pointer;user-select:none}
      .afl-fold:active{opacity:.9}
      .afl-body{margin-top:4px;padding:6px 9px;border-radius:10px;background:rgba(0,0,0,.05);font-size:12px;line-height:1.5;color:inherit;opacity:.85;white-space:pre-wrap}
      .afl-body .d{display:block;margin-top:3px;font-size:11px;opacity:.7}
      .afl-body .d.up{color:#d81b60}.afl-body .d.down{color:#5c6bc0}
      .afl-tool{display:inline-flex;align-items:center;gap:4px;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.05);font-size:12px;cursor:pointer}

      .afl-sheet{--afl-rose:#e5527f;--afl-rose-soft:#fde8ef;--afl-ink:var(--c-text,#1c1a1f);--afl-mute:rgba(28,26,31,.55);--afl-line:rgba(28,26,31,.08);--afl-bg:var(--c-card-bg,#fff);
        width:min(94vw,400px);max-height:84vh;display:flex;flex-direction:column;border-radius:24px;overflow:hidden;background:var(--afl-bg);color:var(--afl-ink);font-size:13px;line-height:1.5;
        -webkit-font-smoothing:antialiased}
      .afl-hero{position:relative;padding:18px 18px 14px;background:linear-gradient(160deg,#fff1f5 0%,#fde8ef 55%,#f6e4ff 100%);color:#1c1a1f}
      .afl-hero .row{display:flex;align-items:center;gap:12px;padding-right:30px}
      .afl-ava{width:52px;height:52px;border-radius:18px;flex:0 0 auto;overflow:hidden;background:#fff;box-shadow:0 4px 14px rgba(229,82,127,.18);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;color:#e5527f}
      .afl-ava img{width:100%;height:100%;object-fit:cover}
      .afl-name{font-size:17px;font-weight:700;letter-spacing:.2px;margin:0}
      .afl-sub{font-size:12px;color:rgba(28,26,31,.6);margin-top:2px}
      .afl-score{margin-left:auto;text-align:right}
      .afl-score b{display:block;font-size:30px;font-weight:800;line-height:1;color:#e5527f;letter-spacing:-1px}
      .afl-score i{font-style:normal;font-size:11px;color:rgba(28,26,31,.5)}
      .afl-track{position:relative;height:10px;border-radius:6px;background:rgba(229,82,127,.14);margin:14px 0 6px;overflow:visible}
      .afl-track>i{position:absolute;left:0;top:0;height:100%;border-radius:6px;background:linear-gradient(90deg,#f9a8c4,#e5527f);box-shadow:0 2px 8px rgba(229,82,127,.35)}
      .afl-track>s{position:absolute;top:-2px;width:2px;height:14px;background:rgba(255,255,255,.9);border-radius:1px;text-decoration:none}
      .afl-ticks{position:relative;height:14px;font-size:10px;color:rgba(28,26,31,.45)}
      .afl-ticks span{position:absolute;transform:translateX(-50%);white-space:nowrap}
      .afl-ticks span:first-child{transform:none}
      .afl-ticks span.on{color:#e5527f;font-weight:600}
      .afl-close{position:absolute;top:12px;right:12px;width:28px;height:28px;border-radius:50%;border:0;background:rgba(255,255,255,.7);color:#1c1a1f;font-size:16px;line-height:28px;text-align:center;cursor:pointer}
      .afl-tabs{display:flex;gap:4px;margin:12px 16px 0;padding:3px;border-radius:12px;background:var(--afl-line)}
      .afl-tabs button{flex:1;padding:7px 0;border-radius:10px;border:0;background:transparent;color:var(--afl-mute);font-size:12.5px;font-weight:600;cursor:pointer}
      .afl-tabs button.on{background:var(--afl-bg);color:var(--afl-ink);box-shadow:0 1px 4px rgba(0,0,0,.08)}
      .afl-scroll{overflow:auto;padding:12px 16px 18px;flex:1 1 auto;min-height:0}
      .afl-card{border:1px solid var(--afl-line);border-radius:16px;padding:12px 14px;margin:0 0 10px;background:var(--afl-bg)}
      .afl-card.soft{background:var(--afl-rose-soft);border-color:transparent;color:#1c1a1f}
      .afl-card h4{margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--afl-mute)}
      .afl-presence{display:flex;gap:10px;align-items:flex-start}
      .afl-presence .ic{font-size:18px;line-height:1.2;flex:0 0 auto}
      .afl-presence .main{font-weight:600}
      .afl-presence .meta{font-size:12px;color:var(--afl-mute);margin-top:2px}
      .afl-presence .age{font-size:11px;color:var(--afl-mute);margin-top:4px}
      .afl-chips{display:flex;flex-wrap:wrap;gap:6px}
      .afl-chip{padding:5px 11px;border-radius:999px;border:1px solid var(--afl-line);background:transparent;color:var(--afl-ink);font-size:12px;cursor:pointer}
      .afl-chip.on{background:#e5527f;border-color:#e5527f;color:#fff;font-weight:600}
      .afl-chip.ghost{border-style:dashed;color:var(--afl-mute)}
      .afl-inline{display:flex;gap:8px;align-items:center;margin-top:8px}
      .afl-input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--afl-line);border-radius:10px;font-size:13px;background:var(--afl-bg);color:var(--afl-ink)}
      .afl-input.num{flex:0 0 68px;text-align:center}
      .afl-btn{padding:7px 12px;border-radius:10px;border:1px solid var(--afl-line);background:var(--afl-bg);color:var(--afl-ink);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
      .afl-btn.pri{background:#e5527f;border-color:#e5527f;color:#fff}
      .afl-btn.danger{color:#c62828}
      .afl-btn:active{transform:scale(.97)}
      .afl-step{display:inline-flex;align-items:center;border:1px solid var(--afl-line);border-radius:10px;overflow:hidden}
      .afl-step button{width:34px;height:32px;border:0;background:transparent;color:var(--afl-ink);font-size:16px;cursor:pointer}
      .afl-step span{min-width:36px;text-align:center;font-weight:700}
      .afl-pending{display:flex;flex-direction:column;gap:8px}
      .afl-pending .t{font-weight:600}
      .afl-pending .r{font-size:12px;color:rgba(28,26,31,.6)}
      .afl-pending .acts{display:flex;gap:8px}
      .afl-line{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--afl-line)}
      .afl-line:first-of-type{border-top:0;padding-top:0}
      .afl-line .l{font-size:13px}
      .afl-line .h{font-size:11px;color:var(--afl-mute);margin-top:1px}
      .afl-sw{position:relative;width:42px;height:24px;flex:0 0 auto}
      .afl-sw input{opacity:0;width:0;height:0;position:absolute}
      .afl-sw i{position:absolute;inset:0;border-radius:12px;background:rgba(28,26,31,.18);transition:background .15s}
      .afl-sw i::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s}
      .afl-sw input:checked+i{background:#e5527f}
      .afl-sw input:checked+i::after{transform:translateX(18px)}
      .afl-hist{list-style:none;margin:0;padding:0}
      .afl-hist li{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--afl-line)}
      .afl-hist li:first-child{border-top:0;padding-top:0}
      .afl-hist .d{flex:0 0 auto;min-width:38px;text-align:center;padding:3px 6px;border-radius:8px;font-size:12px;font-weight:700;background:rgba(229,82,127,.12);color:#e5527f}
      .afl-hist .d.down{background:rgba(92,107,192,.12);color:#5c6bc0}
      .afl-hist .d.zero{background:var(--afl-line);color:var(--afl-mute)}
      .afl-hist .w{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .afl-hist .t{flex:0 0 auto;font-size:11px;color:var(--afl-mute)}
      .afl-empty{color:var(--afl-mute);font-size:12px;text-align:center;padding:6px 0}
      .afl-path{font-size:12px;color:var(--afl-mute);margin-top:8px}
      .afl-path b{color:var(--afl-ink);font-weight:600}
      .afl-field{margin:0 0 10px}
      .afl-field label{display:block;font-size:12px;font-weight:600;margin:0 0 4px}
      .afl-field .h{font-size:11px;color:var(--afl-mute);margin:0 0 5px}
      .afl-ta{width:100%;box-sizing:border-box;min-height:64px;padding:8px 10px;border:1px solid var(--afl-line);border-radius:10px;font-size:12px;line-height:1.5;font-family:inherit;background:var(--afl-bg);color:var(--afl-ink);resize:vertical}
      .afl-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .afl-grid .cell{border:1px solid var(--afl-line);border-radius:12px;padding:8px 10px}
      .afl-grid .cell label{display:block;font-size:11px;color:var(--afl-mute);margin-bottom:3px}
      .afl-grid .cell input{width:100%;box-sizing:border-box;border:0;padding:0;font-size:16px;font-weight:700;background:transparent;color:var(--afl-ink)}
      .afl-foot{display:flex;gap:8px;justify-content:flex-end;padding-top:4px}
      @media (prefers-color-scheme: dark){
        .afl-sheet{--afl-mute:rgba(255,255,255,.55);--afl-line:rgba(255,255,255,.1);--afl-rose-soft:rgba(229,82,127,.16)}
        .afl-card.soft{color:inherit}
        .afl-pending .r{color:var(--afl-mute)}
      }
    `);
    const opened = new Set();
    ctx.ui.slot("message.footer", (el, props) => {
      const m = props.message;
      if (!m || m.role !== "assistant" || !bool("showThought", true)) return;
      const pend = ctx.system.storage.get("m:" + m.id);
      if (!pend || (!pend.thought && !pend.delta)) return;
      const fold = document.createElement("div");
      fold.className = "afl-fold";
      const body = document.createElement("div");
      body.className = "afl-body";
      const render = () => {
        const open = opened.has(m.id);
        fold.textContent = open ? "💭 收起" : "💭";
        body.hidden = !open;
        if (!open) return;
        let html = esc(pend.thought || "（没写心里话）");
        if (bool("showDelta", true) && pend.delta) {
          html += `<span class="d ${pend.delta > 0 ? "up" : "down"}">好感 ${pend.delta > 0 ? "+" : ""}${pend.delta}${pend.reason ? " · " + esc(pend.reason) : ""}</span>`;
        }
        if (pend.relTo) html += `<span class="d">关系转折：${esc(pend.relTo)}${pend.relReason ? " · " + esc(pend.relReason) : ""}</span>`;
        body.innerHTML = html;
      };
      fold.onclick = () => { opened.has(m.id) ? opened.delete(m.id) : opened.add(m.id); render(); };
      render();
      el.append(fold, body);
    });

    // ── 面板：入口在输入栏「+」面板里 ──
    let currentSessionId = null;
    ctx.hooks.on("session.opened", (p) => { currentSessionId = p.isGroup ? null : p.sessionId; });
    ctx.ui.slot("chat.inputToolbar", (el, props) => {
      if (props.isGroup) return;
      const b = document.createElement("button");
      b.type = "button"; b.className = "afl-tool"; b.textContent = "❤ 好感与关系";
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

    function heroHtml(ch, st) {
      const tiers = parseTiers();
      const tier = tierOf(st.score);
      const ticks = tiers.map((t) => `<span class="${t.name === tier.name ? "on" : ""}" style="left:${t.min}%">${esc(t.name)}</span>`).join("");
      const marks = tiers.filter((t) => t.min > 0).map((t) => `<s style="left:${t.min}%"></s>`).join("");
      const ava = ch && ch.avatar ? `<img src="${esc(ch.avatar)}" alt="">` : esc((ch && ch.name || "?").slice(0, 1));
      return `<div class="afl-hero">
        <button class="afl-close" data-a="close" aria-label="关闭">×</button>
        <div class="row">
          <div class="afl-ava">${ava}</div>
          <div><p class="afl-name">${esc(ch ? ch.name : "TA")}</p><div class="afl-sub">${esc(st.relation)} · ${esc(tier.name)}</div></div>
          <div class="afl-score"><b>${st.score}</b><i>好感 / 100</i></div>
        </div>
        <div class="afl-track"><i style="width:${st.score}%"></i>${marks}</div>
        <div class="afl-ticks">${ticks}</div>
      </div>`;
    }
    function statusHtml(cid, st) {
      const tier = tierOf(st.score);
      const stg = stages();
      const chips = (stg.includes(st.relation) ? stg : [st.relation].concat(stg)).map((s) => `<button class="afl-chip ${s === st.relation ? "on" : ""}" data-rel="${esc(s)}">${esc(s)}</button>`).join("")
        + `<button class="afl-chip ghost" data-a="customRel">＋ 手填</button>`;
      const capNote = st.todayDate === today() && st.todayDelta ? `今天已涨 ${st.todayDelta} / ${num("dailyCap")}` : "今天还没涨";
      return `
        ${presenceCard(cid)}
        ${st.pendingRelation ? `<div class="afl-card soft"><div class="afl-pending">
          <div class="t">TA觉得关系变成了「${esc(st.pendingRelation.to)}」</div>
          ${st.pendingRelation.reason ? `<div class="r">${esc(st.pendingRelation.reason)}</div>` : ""}
          <div class="acts"><button class="afl-btn pri" data-a="accept">就是这样</button><button class="afl-btn" data-a="dismiss">没有变</button></div>
        </div></div>` : ""}
        <div class="afl-card"><h4>分寸</h4><div>${esc(tier.hint || "（这一档还没写分寸提示）")}</div><div class="afl-path">${capNote}</div></div>
        <div class="afl-card"><h4>关系</h4><div class="afl-chips">${chips}</div>
          <div class="afl-inline" data-customrel hidden><input class="afl-input" type="text" data-k="relText" placeholder="自定义关系，12 字内" maxlength="12"><button class="afl-btn pri" data-a="saveRelText">确定</button></div>
        </div>
        <div class="afl-card"><h4>手动调整</h4><div class="afl-inline" style="margin-top:0">
          <div class="afl-step"><button data-a="minus">−</button><span>${st.score}</span><button data-a="plus">＋</button></div>
          <input class="afl-input num" type="number" data-k="setScore" value="${st.score}" min="0" max="100"><button class="afl-btn" data-a="setScore">设为</button>
        </div></div>
        <div class="afl-card">
          <div class="afl-line"><div><div class="l">气泡下显示心里话</div><div class="h">折叠成一个 💭，点开才看</div></div>${sw("showThought", bool("showThought", true))}</div>
          <div class="afl-line"><div><div class="l">心里话里显示好感变化</div><div class="h">关掉就只看心里话</div></div>${sw("showDelta", bool("showDelta", true))}</div>
        </div>
        <div class="afl-card"><h4>最近变化</h4><ul class="afl-hist">${st.history.slice().reverse().slice(0, 12).map((h) => `<li><span class="d ${h.delta > 0 ? "" : h.delta < 0 ? "down" : "zero"}">${h.delta > 0 ? "+" : ""}${h.delta}</span><span class="w">${esc(h.reason || "")}</span><span class="t">${fmt(h.at)}</span></li>`).join("") || "<li class='afl-empty'>还没有记录，聊两句就有了</li>"}</ul>
          ${st.relationHistory.length ? `<div class="afl-path">关系走过：${st.relationHistory.map((r) => esc(r.from) + " → <b>" + esc(r.to) + "</b>").join("，")}</div>` : ""}
        </div>
        <div class="afl-foot"><button class="afl-btn danger" data-a="reset">重置这个角色</button></div>`;
    }
    function presenceCard(cid) {
      const pr = ctx.data.variables.get("presence", "character", cid);
      if (!pr || typeof pr !== "object" || !pr.doing) return "";
      const ageMin = pr.at ? Math.round((Date.now() - Number(pr.at)) / 60000) : null;
      const meta = [pr.place ? "📍 " + pr.place : "", pr.mood ? "情绪 " + pr.mood : "", Number.isFinite(Number(pr.energy)) ? "精力 " + pr.energy + "%" : "", pr.next ? "接下来 " + pr.next : ""].filter(Boolean).map(esc).join(" · ");
      return `<div class="afl-card"><h4>此刻</h4><div class="afl-presence"><div class="ic">${pr.asleep ? "😴" : "🕒"}</div><div>
        <div class="main">${esc(pr.asleep ? "在睡觉" : "正在" + pr.doing)}${pr.step ? "<span style='font-weight:400;opacity:.7'>（" + esc(pr.step) + "）</span>" : ""}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ""}
        ${ageMin != null && ageMin > 30 ? `<div class="age">${ageMin >= 120 ? Math.round(ageMin / 60) + " 小时" : ageMin + " 分钟"}前挂念同步的快照</div>` : ""}
      </div></div></div>`;
    }
    function settingsHtml() {
      const c = cfg();
      const ta = (k, label, help, rows) => `<div class="afl-field"><label>${label}</label>${help ? `<div class="h">${help}</div>` : ""}<textarea class="afl-ta" data-c="${k}" rows="${rows || 3}">${esc(c[k])}</textarea></div>`;
      const cell = (k, label, min, max) => `<div class="cell"><label>${label}</label><input type="number" data-cn="${k}" value="${num(k)}" min="${min}" max="${max}"></div>`;
      return `
        <div class="afl-card"><h4>数值</h4><div class="afl-grid">
          ${cell("maxStep", "单轮最多变化 ±", 1, 20)}${cell("dailyCap", "每天最多涨", 0, 50)}
          ${cell("decayAfterDays", "几天不聊开始回落", 0, 60)}${cell("decayPerDay", "回落每天掉", 0, 20)}
          ${cell("startScore", "新角色起始好感", 0, 100)}
        </div></div>
        <div class="afl-card"><h4>好感区间</h4>${ta("tiers", "一行一档", "格式：起始分|名字|这一档的分寸提示（会注入提示词）", 6)}</div>
        <div class="afl-card"><h4>关系阶段</h4>${ta("stages", "一行一个", "状态页里当作可选项，也会告诉模型有哪些", 4)}</div>
        <div class="afl-card"><h4>提示词</h4>
          ${ta("pThought", "心里话怎么写", "", 3)}
          ${ta("pDelta", "好感怎么判", "占位：{{maxStep}}", 4)}
          ${ta("pRelation", "关系转折怎么判", "占位：{{stages}}", 3)}
          ${ta("pStance", "分寸怎么说", "占位：{{tier}} {{tierHint}} {{relation}} {{score}}", 3)}
        </div>
        <div class="afl-foot"><button class="afl-btn" data-a="resetCfg">恢复默认</button><button class="afl-btn pri" data-a="saveCfg">保存</button></div>`;
    }
    function openPanel(sessionId) {
      const cid = charOf(sessionId);
      if (!cid) { ctx.ui.toast("这个面板只在单聊里用"); return; }
      const ch = ctx.data.characters.get(cid);
      let tab = "status";
      ctx.ui.openModal((el, api) => {
        el.style.cssText = "background:transparent;box-shadow:none;border-radius:0;width:auto;max-height:none;overflow:visible";
        const paint = () => {
          const st = settleDecay(cid, load(cid));
          el.innerHTML = `<div class="afl-sheet">
            ${heroHtml(ch, st)}
            <div class="afl-tabs"><button data-t="status" class="${tab === "status" ? "on" : ""}">状态</button><button data-t="settings" class="${tab === "settings" ? "on" : ""}">设置</button></div>
            <div class="afl-scroll">${tab === "status" ? statusHtml(cid, st) : settingsHtml()}</div>
          </div>`;
          el.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => { tab = b.getAttribute("data-t"); paint(); }));
          el.querySelectorAll("[data-rel]").forEach((b) => b.addEventListener("click", () => {
            const v = b.getAttribute("data-rel"), s = load(cid);
            if (v && v !== s.relation) { s.relationHistory.push({ at: Date.now(), from: s.relation, to: v, reason: "手动改" }); s.relation = v; save(cid, s); }
            paint();
          }));
          el.querySelectorAll("[data-a]").forEach((btn) => btn.addEventListener("click", () => {
            const a = btn.getAttribute("data-a");
            if (a === "close") return api.close();
            if (a === "customRel") { const box = el.querySelector("[data-customrel]"); box.hidden = !box.hidden; if (!box.hidden) box.querySelector("input").focus(); return; }
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
