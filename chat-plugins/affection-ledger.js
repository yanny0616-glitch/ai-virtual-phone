// 好感与关系 · 聊天插件（apiVersion 1）
// 安装：设置 → 聊天插件 → 粘贴本文件全文。
// 与挂念共用变量池：scope "character"，name "affection"。
export default {
  manifest: {
    id: "affection-ledger",
    name: "好感与关系",
    apiVersion: 1,
    version: "1.0.0",
    author: "自制",
    description: "角色回复里自带心里话与好感变化量，插件累加成慢变的好感；关系只在转折点经你确认才变。",
    permissions: ["chat.read", "chat.write", "ui", "storage"],
    settings: [
      { key: "showThought", label: "气泡下显示心里话（折叠）", type: "boolean", default: true },
      { key: "showDelta", label: "心里话里显示好感变化", type: "boolean", default: true },
      { key: "dailyCap", label: "每天好感最多涨", type: "number", default: 4 },
      { key: "decayAfterDays", label: "几天不聊开始回落", type: "number", default: 3 },
      { key: "decayPerDay", label: "回落每天掉", type: "number", default: 1 },
      { key: "startScore", label: "新角色起始好感", type: "number", default: 10 },
    ],
  },
  setup(ctx) {
    const VAR = "affection";
    const TIERS = [[0, "陌生"], [15, "熟人"], [35, "在意"], [60, "亲近"], [80, "离不开"]];
    const TIER_HINT = {
      "陌生": "还不熟，客气、有保留，不主动交心，不会撒娇也不会依赖",
      "熟人": "聊得来的普通朋友，自然但有分寸，不说太私密的事",
      "在意": "会惦记TA、会多问一句，愿意说心里话，但还留着一点面子",
      "亲近": "很信任，会撒娇、会耍赖、会把坏情绪也给TA看",
      "离不开": "TA是最重要的人，情绪被TA牵着走，会吃醋、会等消息",
    };
    const num = (k, d) => { const v = Number(ctx.system.settings.get(k)); return Number.isFinite(v) ? v : d; };
    const bool = (k, d) => { const v = ctx.system.settings.get(k); return v === undefined ? d : !!v; };
    const today = () => new Date().toISOString().slice(0, 10);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const tierOf = (s) => { let t = TIERS[0][1]; for (const [min, name] of TIERS) if (s >= min) t = name; return t; };
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    function charOf(sessionId) {
      const s = sessionId ? ctx.data.sessions.get(sessionId) : null;
      if (!s || s.isGroup) return null;
      return s.contactId || null; // 本宿主 session.contactId 即 characterId
    }
    function load(cid) {
      const v = ctx.data.variables.get(VAR, "character", cid);
      const base = v && typeof v === "object" ? v : {};
      const score = Number.isFinite(Number(base.score)) ? Number(base.score) : num("startScore", 10);
      return {
        score, tier: tierOf(score),
        relation: String(base.relation || "刚认识"),
        updatedAt: Number(base.updatedAt) || 0,
        todayDate: String(base.todayDate || ""), todayDelta: Number(base.todayDelta) || 0,
        history: Array.isArray(base.history) ? base.history : [],
        relationHistory: Array.isArray(base.relationHistory) ? base.relationHistory : [],
        pendingRelation: base.pendingRelation && typeof base.pendingRelation === "object" ? base.pendingRelation : null,
      };
    }
    function save(cid, st) {
      st.score = clamp(Math.round(st.score), 0, 100);
      st.tier = tierOf(st.score);
      st.history = st.history.slice(-40);
      st.relationHistory = st.relationHistory.slice(-20);
      ctx.data.variables.set(VAR, st, "character", cid);
      return st;
    }
    // 几天没动就慢慢回落；只在读提示词时结算，不用定时器
    function settleDecay(cid, st) {
      const after = num("decayAfterDays", 3), per = num("decayPerDay", 1);
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
    function applyDelta(cid, delta, reason) {
      const st = load(cid);
      const cap = num("dailyCap", 4);
      if (st.todayDate !== today()) { st.todayDate = today(); st.todayDelta = 0; }
      let d = clamp(Math.round(delta), -3, 3);
      if (d > 0) d = Math.max(0, Math.min(d, cap - st.todayDelta));
      if (d !== 0) {
        st.score += d;
        st.todayDelta += Math.max(0, d);
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
      p.hint = (p.hint ? p.hint + "\n\n" : "") + [
        "## 心里话与好感",
        "回复正文写完后另起一行，附一个 [内心] 块（正文里不要出现这些内容，也不要解释），格式：",
        "[内心]",
        "第一行起是心里话：回复前一瞬真实的念头、潜台词、没说出口的情绪、对这句话的第一反应。一两句，第一人称，不复述正文，不写任何数字。",
        "好感 变化|理由 —— 单独一行。这一轮你对TA的感觉变了多少：-3 到 +3 的整数。多数轮次是 0 或 ±1；只有特别打动或特别伤人才到 ±2、±3。理由 12 字内写具体的事（如「记得我讨厌香菜」），不写「聊得开心」这种空话。你累、忙、心情差的时候更难被打动。",
        "关系→新关系|理由 —— 单独一行，只在两人关系真的发生转折时（表白被接受、说开了、决定不再联系、和好）才写；平时绝对不写这一行。",
        "[/内心]",
        `你现在对TA：${st.tier}（${TIER_HINT[st.tier]}）；两人现在的关系：${st.relation}。说话的分寸按这个来，不要越过这个关系该有的界限，也不要冷淡得不像这个关系。`,
      ].join("\n");
      return p;
    });

    // ── 截标记：从正文删掉，结算好感，心里话暂存等落库时挂到消息上 ──
    const RE_BLOCK = /\[内心\]([\s\S]*?)\[\/内心\]/;
    const RE_DELTA = /^\s*[\[（(]?好感\s*[:：]?\s*([+-]?\s*\d)\s*[|｜：:]\s*([^\]\n]*)[\]）)]?\s*$/m;
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
      if (md) pend.delta = applyDelta(cid, Number(md[1].replace(/\s/g, "")), md[2]), pend.reason = md[2].trim().slice(0, 40);
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
      .afl-panel{font-size:13px;line-height:1.5;min-width:260px;max-width:340px}
      .afl-panel h3{margin:0 0 8px;font-size:15px}
      .afl-bar{height:8px;border-radius:4px;background:rgba(0,0,0,.08);overflow:hidden;margin:6px 0}
      .afl-bar i{display:block;height:100%;background:linear-gradient(90deg,#f8bbd0,#d81b60);border-radius:4px}
      .afl-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}
      .afl-row input[type=text],.afl-row input[type=number]{flex:1;min-width:0;padding:4px 8px;border:1px solid rgba(0,0,0,.15);border-radius:8px;font-size:13px}
      .afl-row input[type=number]{flex:0 0 64px}
      .afl-btn{padding:4px 10px;border-radius:8px;border:1px solid rgba(0,0,0,.15);background:#fff;font-size:12px;cursor:pointer}
      .afl-btn.pri{background:#d81b60;color:#fff;border-color:#d81b60}
      .afl-presence{margin:4px 0 8px;padding:6px 9px;border-radius:10px;background:rgba(0,0,0,.05);font-size:12px;line-height:1.5}
      .afl-presence .t{opacity:.5;margin-left:4px}
      .afl-pending{padding:8px 10px;border-radius:10px;background:#fff3f7;border:1px solid #f8bbd0;margin:8px 0}
      .afl-hist{margin:8px 0 0;padding:0;list-style:none;max-height:150px;overflow:auto;font-size:12px;opacity:.85}
      .afl-hist li{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
      .afl-hist .t{opacity:.5;flex:0 0 auto}
      .afl-tool{display:inline-flex;align-items:center;gap:4px;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.05);font-size:12px;cursor:pointer}
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
      b.onclick = () => openPanel();
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
    function openPanel() {
      const cid = charOf(currentSessionId);
      if (!cid) { ctx.ui.toast("先进一个单聊"); return; }
      const ch = ctx.data.characters.get(cid);
      ctx.ui.openModal((el, api) => {
        const paint = () => {
          const st = settleDecay(cid, load(cid));
          const fmt = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
          el.innerHTML = `<div class="afl-panel">
            <h3>${esc(ch ? ch.name : "TA")} · ${esc(st.tier)} <span style="font-weight:400;opacity:.6">${st.score}/100</span></h3>
            <div class="afl-bar"><i style="width:${st.score}%"></i></div>
            ${presenceHtml(cid)}
            <div style="font-size:12px;opacity:.7">${esc(TIER_HINT[st.tier] || "")}${st.todayDate === today() && st.todayDelta ? `　今天已涨 ${st.todayDelta}/${num("dailyCap", 4)}` : ""}</div>
            ${st.pendingRelation ? `<div class="afl-pending">关系可能变成「${esc(st.pendingRelation.to)}」${st.pendingRelation.reason ? "：" + esc(st.pendingRelation.reason) : ""}<div class="afl-row" style="margin-bottom:0"><button class="afl-btn pri" data-a="accept">就是这样</button><button class="afl-btn" data-a="dismiss">没有变</button></div></div>` : ""}
            <div class="afl-row"><span>关系</span><input type="text" data-k="relation" value="${esc(st.relation)}" maxlength="12"><button class="afl-btn" data-a="saveRel">改</button></div>
            <div class="afl-row"><span>气泡下显示心里话</span><input type="checkbox" data-s="showThought" ${bool("showThought", true) ? "checked" : ""}></div>
            <div class="afl-row"><span>心里话里显示好感变化</span><input type="checkbox" data-s="showDelta" ${bool("showDelta", true) ? "checked" : ""}></div>
            <div class="afl-row"><span>每天最多涨</span><input type="number" data-n="dailyCap" value="${num("dailyCap", 4)}" min="0" max="20"></div>
            <div class="afl-row"><span>几天不聊开始回落 / 每天掉</span><input type="number" data-n="decayAfterDays" value="${num("decayAfterDays", 3)}" min="0" max="60"><input type="number" data-n="decayPerDay" value="${num("decayPerDay", 1)}" min="0" max="20"></div>
            <ul class="afl-hist">${st.history.slice().reverse().slice(0, 12).map((h) => `<li><span>${h.delta > 0 ? "+" : ""}${h.delta} ${esc(h.reason || "")}</span><span class="t">${fmt(h.at)}</span></li>`).join("") || "<li style='opacity:.5'>还没有记录</li>"}</ul>
            ${st.relationHistory.length ? `<div style="font-size:12px;opacity:.6;margin-top:6px">关系：${st.relationHistory.map((r) => esc(r.from) + "→" + esc(r.to)).join("，")}</div>` : ""}
            <div class="afl-row" style="margin-top:10px"><button class="afl-btn" data-a="reset">重置这个角色</button><button class="afl-btn" data-a="close">关闭</button></div>
          </div>`;
          el.querySelectorAll("[data-a]").forEach((btn) => btn.addEventListener("click", () => {
            const a = btn.getAttribute("data-a"), s = load(cid);
            if (a === "close") return api.close();
            if (a === "accept" && s.pendingRelation) { s.relationHistory.push({ at: Date.now(), from: s.relation, to: s.pendingRelation.to, reason: s.pendingRelation.reason }); s.relation = s.pendingRelation.to; s.pendingRelation = null; }
            if (a === "dismiss") s.pendingRelation = null;
            if (a === "saveRel") { const v = el.querySelector("[data-k=relation]").value.trim(); if (v && v !== s.relation) { s.relationHistory.push({ at: Date.now(), from: s.relation, to: v, reason: "手动改" }); s.relation = v; } }
            if (a === "reset") { if (!confirm("清空这个角色的好感与关系记录？")) return; ctx.data.variables.unset(VAR, "character", cid); paint(); return; }
            save(cid, s); paint();
          }));
          el.querySelectorAll("[data-s]").forEach((cb) => cb.addEventListener("change", () => ctx.system.settings.set(cb.getAttribute("data-s"), cb.checked)));
          el.querySelectorAll("[data-n]").forEach((inp) => inp.addEventListener("change", () => ctx.system.settings.set(inp.getAttribute("data-n"), Number(inp.value) || 0)));
        };
        paint();
      });
    }
  },
};
