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
      .afl-panel{font-size:13px;line-height:1.5;width:min(92vw,360px);max-height:80vh;overflow:auto}
      .afl-panel h3{margin:0 0 6px;font-size:15px}
      .afl-tabs{display:flex;gap:6px;margin:0 0 8px}
      .afl-tabs button{flex:1;padding:5px 0;border-radius:8px;border:1px solid rgba(0,0,0,.12);background:#fff;font-size:12px}
      .afl-tabs button.on{background:#d81b60;color:#fff;border-color:#d81b60}
      .afl-bar{height:8px;border-radius:4px;background:rgba(0,0,0,.08);overflow:hidden;margin:6px 0}
      .afl-bar i{display:block;height:100%;background:linear-gradient(90deg,#f8bbd0,#d81b60);border-radius:4px}
      .afl-presence{margin:4px 0 8px;padding:6px 9px;border-radius:10px;background:rgba(0,0,0,.05);font-size:12px;line-height:1.5}
      .afl-presence .t{opacity:.5;margin-left:4px}
      .afl-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}
      .afl-row input[type=text],.afl-row input[type=number],.afl-row select{flex:1;min-width:0;padding:4px 8px;border:1px solid rgba(0,0,0,.15);border-radius:8px;font-size:13px;background:#fff}
      .afl-row input[type=number]{flex:0 0 64px}
      .afl-btn{padding:4px 10px;border-radius:8px;border:1px solid rgba(0,0,0,.15);background:#fff;font-size:12px;cursor:pointer;white-space:nowrap}
      .afl-btn.pri{background:#d81b60;color:#fff;border-color:#d81b60}
      .afl-pending{padding:8px 10px;border-radius:10px;background:#fff3f7;border:1px solid #f8bbd0;margin:8px 0}
      .afl-hist{margin:8px 0 0;padding:0;list-style:none;max-height:150px;overflow:auto;font-size:12px;opacity:.85}
      .afl-hist li{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
      .afl-hist .t{opacity:.5;flex:0 0 auto}
      .afl-sec{margin:10px 0 4px;font-size:12px;font-weight:600;opacity:.7}
      .afl-help{font-size:11px;opacity:.55;margin:0 0 4px}
      .afl-ta{width:100%;box-sizing:border-box;min-height:64px;padding:6px 8px;border:1px solid rgba(0,0,0,.15);border-radius:8px;font-size:12px;line-height:1.45;font-family:inherit;background:#fff}
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
    const fmt = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

    function statusHtml(cid, ch, st) {
      const tier = tierOf(st.score);
      const stg = stages();
      const relOptions = (stg.includes(st.relation) ? stg : [st.relation].concat(stg)).map((s) => `<option value="${esc(s)}" ${s === st.relation ? "selected" : ""}>${esc(s)}</option>`).join("");
      return `
        <h3>${esc(ch ? ch.name : "TA")} · ${esc(tier.name)} <span style="font-weight:400;opacity:.6">${st.score}/100</span></h3>
        <div class="afl-bar"><i style="width:${st.score}%"></i></div>
        ${presenceHtml(cid)}
        <div style="font-size:12px;opacity:.7">${esc(tier.hint)}${st.todayDate === today() && st.todayDelta ? `　今天已涨 ${st.todayDelta}/${num("dailyCap")}` : ""}</div>
        ${st.pendingRelation ? `<div class="afl-pending">关系可能变成「${esc(st.pendingRelation.to)}」${st.pendingRelation.reason ? "：" + esc(st.pendingRelation.reason) : ""}<div class="afl-row" style="margin-bottom:0"><button class="afl-btn pri" data-a="accept">就是这样</button><button class="afl-btn" data-a="dismiss">没有变</button></div></div>` : ""}
        <div class="afl-row"><span>关系</span><select data-k="relSel">${relOptions}<option value="__custom">手填…</option></select><button class="afl-btn" data-a="saveRel">改</button></div>
        <div class="afl-row" data-customrel hidden><span></span><input type="text" data-k="relText" placeholder="自定义关系" maxlength="12"></div>
        <div class="afl-row"><span>手动调整</span><button class="afl-btn" data-a="minus">−1</button><button class="afl-btn" data-a="plus">+1</button><input type="number" data-k="setScore" value="${st.score}" min="0" max="100"><button class="afl-btn" data-a="setScore">设为</button></div>
        <div class="afl-row"><span>气泡下显示心里话</span><input type="checkbox" data-s="showThought" ${bool("showThought", true) ? "checked" : ""}></div>
        <div class="afl-row"><span>心里话里显示好感变化</span><input type="checkbox" data-s="showDelta" ${bool("showDelta", true) ? "checked" : ""}></div>
        <ul class="afl-hist">${st.history.slice().reverse().slice(0, 12).map((h) => `<li><span>${h.delta > 0 ? "+" : ""}${h.delta} ${esc(h.reason || "")}</span><span class="t">${fmt(h.at)}</span></li>`).join("") || "<li style='opacity:.5'>还没有记录</li>"}</ul>
        ${st.relationHistory.length ? `<div style="font-size:12px;opacity:.6;margin-top:6px">关系：${st.relationHistory.map((r) => esc(r.from) + "→" + esc(r.to)).join("，")}</div>` : ""}
        <div class="afl-row" style="margin-top:10px"><button class="afl-btn" data-a="reset">重置这个角色</button><button class="afl-btn" data-a="close">关闭</button></div>`;
    }
    function settingsHtml() {
      const c = cfg();
      const ta = (k, rows) => `<textarea class="afl-ta" data-c="${k}" rows="${rows || 3}">${esc(c[k])}</textarea>`;
      const n = (k, label, min, max) => `<div class="afl-row"><span>${label}</span><input type="number" data-cn="${k}" value="${num(k)}" min="${min}" max="${max}"></div>`;
      return `
        <h3>设置 <span style="font-weight:400;opacity:.6;font-size:12px">对所有角色生效</span></h3>
        <div class="afl-sec">数值</div>
        ${n("maxStep", "单轮最多变化 ±", 1, 20)}
        ${n("dailyCap", "每天最多涨", 0, 50)}
        ${n("decayAfterDays", "几天不聊开始回落", 0, 60)}
        ${n("decayPerDay", "回落每天掉", 0, 20)}
        ${n("startScore", "新角色起始好感", 0, 100)}
        <div class="afl-sec">好感区间</div>
        <div class="afl-help">一行一档：起始分|名字|这一档的分寸提示（注入提示词）</div>
        ${ta("tiers", 6)}
        <div class="afl-sec">关系阶段</div>
        <div class="afl-help">一行一个，供选择和提示模型；也可以在状态页手填</div>
        ${ta("stages", 4)}
        <div class="afl-sec">提示词 · 心里话</div>
        ${ta("pThought", 3)}
        <div class="afl-sec">提示词 · 好感判定</div>
        <div class="afl-help">可用占位：{{maxStep}}</div>
        ${ta("pDelta", 4)}
        <div class="afl-sec">提示词 · 关系转折</div>
        <div class="afl-help">可用占位：{{stages}}</div>
        ${ta("pRelation", 3)}
        <div class="afl-sec">提示词 · 分寸</div>
        <div class="afl-help">可用占位：{{tier}} {{tierHint}} {{relation}} {{score}}</div>
        ${ta("pStance", 3)}
        <div class="afl-row" style="margin-top:10px"><button class="afl-btn pri" data-a="saveCfg">保存</button><button class="afl-btn" data-a="resetCfg">恢复默认</button><button class="afl-btn" data-a="close">关闭</button></div>`;
    }
    function openPanel() {
      const cid = charOf(currentSessionId);
      if (!cid) { ctx.ui.toast("先进一个单聊"); return; }
      const ch = ctx.data.characters.get(cid);
      let tab = "status";
      ctx.ui.openModal((el, api) => {
        const paint = () => {
          const st = settleDecay(cid, load(cid));
          el.innerHTML = `<div class="afl-panel">
            <div class="afl-tabs"><button data-t="status" class="${tab === "status" ? "on" : ""}">状态</button><button data-t="settings" class="${tab === "settings" ? "on" : ""}">设置</button></div>
            ${tab === "status" ? statusHtml(cid, ch, st) : settingsHtml()}
          </div>`;
          el.querySelectorAll("[data-t]").forEach((b) => b.addEventListener("click", () => { tab = b.getAttribute("data-t"); paint(); }));
          const relSel = el.querySelector("[data-k=relSel]");
          if (relSel) relSel.addEventListener("change", () => { el.querySelector("[data-customrel]").hidden = relSel.value !== "__custom"; });
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
            if (a === "saveRel") {
              const sel = el.querySelector("[data-k=relSel]").value;
              const v = (sel === "__custom" ? el.querySelector("[data-k=relText]").value : sel).trim();
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
