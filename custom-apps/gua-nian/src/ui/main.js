  /* ================= 渲染 ================= */
  function render() {
    renderCloudSync();
    renderSettingsEffects();
    const cx = cur();
    $("#hdr-date").textContent = todayStr().slice(5).replace("-", " / ") + " · 周" + "日一二三四五六"[new Date().getDay()];
    // 挂念几位时，顶上一排头像切换看谁
    const sw = $("#who-switch");
    sw.hidden = S.order.length < 2;
    if (!sw.hidden) {
      sw.innerHTML = allCx().map((x) => '<div class="chip' + (x.character.id === S.cur ? " on" : "") + '" data-id="' + esc(x.character.id) + '">'
        + '<div class="ava">' + (x.character.avatar ? '<img src="' + esc(x.character.avatar) + '" alt="">' : esc((x.character.name || "?").slice(0, 1))) + "</div>"
        + esc(x.character.name) + (x.busy ? " …" : "") + "</div>").join("");
      sw.querySelectorAll(".chip").forEach((el) => { el.onclick = () => { if (S.cur !== el.dataset.id) { S.cur = el.dataset.id; render(); } }; });
    }
    // 角色条
    const who = $("#who");
    if (cx.character) {
      who.hidden = false;
      const ava = $("#who-ava");
      ava.innerHTML = cx.character.avatar
        ? '<img src="' + esc(cx.character.avatar) + '" alt="">'
        : esc((cx.character.name || "?").slice(0, 1));
      $("#who-name").textContent = cx.character.name;
      const doing = currentDoing(cx);
      const nb = nightBridge(cx);
      $("#who-now").innerHTML = cx.day ? nowLineHtml(cx.day, doing) : '<span class="live"></span>' + (nb ? esc(nb.doing) : "今天还没开始");
    } else { who.hidden = true; }
    // 「今天」页有生活面时，角色和此刻状态合成一张卡，页顶不再单独放一条
    if (cx.character && S.tab === "today" && cx.day) who.hidden = true;

    const v = $("#view");
    v.classList.toggle("no-anim", !!S._still); // 定时刷新不重播动画
    $("#tabs").hidden = !cx.character;
    if (!cx.character) {
      v.innerHTML = '<div class="card empty"><div class="art">🕊️</div><p>还没有可挂念的人。<br>先去创建一个角色，再回来打开这里。</p></div>';
      return;
    }
    if (S.tab === "archive") { renderArchive(); return; }
    if (S.tab === "back") { renderBack(); return; }
    if (S.tab === "heart") { renderHeart(); return; }
    if (!cx.day) {
      v.innerHTML =
        '<div class="card empty"><div class="art">🌅</div>' +
        '<p>TA的今天还是一张白纸。<br>生成TA今天的状态与日程，<br>再看看TA会在哪些时刻想起你。'
        + (nightBridge(cx) ? '<br><span style="color:var(--tx3)">' + esc("眼下按昨天的作息：" + nightBridge(cx).doing + (nightBridge(cx).next ? "，" + nightBridge(cx).next : "")) + "</span>" : "")
        + (S.settings && S.settings.autoGen ? '<br><span style="color:var(--tx3)">每天 ' + esc(S.settings.autoGenAt || SET_DEF.autoGenAt) + ' 会自动生成（挂念得开着；错过了下次打开时补）</span>' : "") + "</p>" +
        '<button class="big-btn" id="btn-gen"' + (cx.busy ? " disabled" : "") + ">" +
        (cx.busy ? '<span class="spin"></span>正在展开TA的一天…' : "开始TA的今天") + "</button></div>";
      bindCommon(); return;
    }

    const ctx = { day: cx.day, plan: cx.plan, settings: S.settings, character: cx.character, now: Date.now() };
    v.innerHTML = PANELS.filter((p) => p.when(ctx)).map((p) => p.html(ctx)).join("");
    requestAnimationFrame(() => { document.querySelectorAll(".fill").forEach((el) => { el.style.width = el.dataset.w + "%"; }); });
    bindPanels(cx, v);
  }

  /* ================= 总览面板：卡片注册表 =================
     加一块展示 = 往 PANELS 里加一条 {id, when, html}，render 本身不用改。
     html(ctx) 只许返回字符串，绑事件统一在 render 末尾做（innerHTML 会冲掉旧节点）。 */
  const PANELS = [
    { id: "state", when: (c) => !!c.day, html: panelState },
    { id: "timeline", when: (c) => !!c.day, html: panelTimeline },
  ];
  // 心动页：主动消息的全部——TA想说什么、几点、惦记着什么、按什么分寸
  const HEART_PANELS = [
    { id: "pulse", when: (c) => !!c.day, html: panelPulse },
    { id: "wakes", when: (c) => !!c.day, html: panelWakes },
    { id: "threads", when: (c) => !!c.day && !!S.settings.threadsOn, html: panelThreads },
    { id: "rules", when: () => true, html: panelRules },
  ];
  function renderHeart() {
    const cx = cur(), v = $("#view");
    if (!cx.day) {
      v.innerHTML = '<div class="card empty"><div class="art">♡</div><p>TA的今天还没开始。<br>先去「今天」页生成TA的一天，<br>这里才会有TA想起你的时刻。</p></div>';
      bindCommon(); return;
    }
    const ctx = { day: cx.day, plan: cx.plan, settings: S.settings, character: cx.character, now: Date.now() };
    v.innerHTML = HEART_PANELS.filter((p) => p.when(ctx)).map((p) => p.html(ctx)).join("");
    bindPanels(cx, v);
  }
  // 后台页：诊断和用量两段，段切换只换子容器
  function renderBack() {
    const v = $("#view");
    v.innerHTML = '<div class="stabs" style="margin-top:2px">'
      + '<button class="stab' + (S.sub === "diag" ? " on" : "") + '" data-sub="diag">诊断</button>'
      + '<button class="stab' + (S.sub === "usage" ? " on" : "") + '" data-sub="usage">用量</button>'
      + '</div><div id="subview"></div>';
    v.querySelectorAll(".stab").forEach((b) => { b.onclick = () => { if (S.sub !== b.dataset.sub) { S.sub = b.dataset.sub; renderBack(); } }; });
    if (S.sub === "usage") renderUsage(); else renderDiag();
  }
  function bindPanels(cx, v) {
    v.querySelectorAll(".tl-item.sched").forEach((el) => {
      el.onclick = () => { const i = +el.dataset.si; if (i >= 0) openSchedDetail(i); };
    });
    v.querySelectorAll(".tl-item.wake").forEach((el) => {
      el.onclick = () => {
        const w = cx.plan && (cx.plan.items || []).find((x) => x.time === el.dataset.t);
        if (w) openDetail(w, cx.plan, null);
      };
    });
    const go = $("#go-heart");
    if (go) go.onclick = () => switchTab("heart");
    v.querySelectorAll(".th-row").forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest("button")) return;
        S._thOpen = S._thOpen === row.dataset.tid ? "" : row.dataset.tid;
        render();
      };
    });
    v.querySelectorAll(".th-row button").forEach((el) => {
      el.onclick = async () => {
        const id = el.closest(".th-row").dataset.tid, act = el.dataset.act, list = (cx.threads || []).slice();
        const t = list.find((x) => x.id === id); if (!t) return;
        if (act === "drop" && !confirm("删掉「" + t.text + "」？删了就找不回来了。")) return;
        if (act === "done") { t.done = true; t.at = Date.now(); t.by = "user"; toast("已了结，可以在「已了结」里恢复"); }
        else if (act === "undone") {
          const n = Date.now();
          t.done = false; t.at = n; t.since = n; t.by = "user";
          // 约定/日子的存活按 due 判：过了点的放回去会立刻被判死、当场又消失。降成话头再放回。
          if (!threadAlive(t, n, S.settings.threadDays)) { t.kind = "topic"; t.due = 0; t.yearly = false; toast("这件事的时间已经过了，放回去当话头挂着"); }
          else toast("放回去了，TA会重新惦记着");
          S._thDone = false;
        }
        else list.splice(list.indexOf(t), 1);
        if (act !== "undone") await dropThreadSlots(cx, id, act === "done" ? "你把这件事了结了" : "你删掉了这条惦记");
        S._thOpen = "";
        await saveThreads(cx, list); await uploadPlanCloud(cx, false); cx._ctx = null; syncChatContext(cx, true).catch(() => {}); render();
      };
    });
    const thDone = $("#th-done");
    if (thDone) thDone.onclick = () => { S._thDone = !S._thDone; S._thOpen = ""; render(); };
    const thPlus = $("#th-plus");
    if (thPlus) thPlus.onclick = () => { S._thAdd = !S._thAdd; render(); if (S._thAdd) { const i = $("#th-add input"); if (i) i.focus(); } };
    const thAdd = $("#th-add");
    if (thAdd) thAdd.onsubmit = async (e) => {
      e.preventDefault();
      const text = thAdd.text.value.trim().slice(0, 60); if (!text) return;
      const when = thAdd.when.value.trim(), now = Date.now(), due = parseWhen(when, now);
      if (when && !due) { toast("时间没看懂：写 9/10、2026-09-10 或 15:00"); return; }
      const kind = !due ? "topic" : (/\d{1,2}:\d{2}/.test(when) ? "promise" : "date");
      await saveThreads(cx, (cx.threads || []).concat([newThread(kind, text, due, now, "user", "你手动记的")]));
      S._thAdd = false;
      await uploadPlanCloud(cx, false); cx._ctx = null; syncChatContext(cx, true).catch(() => {}); render();
    };
    const gear = $("#btn-panel-set");
    if (gear) gear.onclick = openSheet;
    const fold = v.querySelector("details.fold");
    if (fold) fold.ontoggle = () => { S._rulesOpen = fold.open; };
    const hw = $("#hero-who");
    if (hw) hw.onclick = (e) => { if (!e.target.closest("button")) openSheet(); };
    bindCommon();
  }
  function switchTab(tab) {
    if (S.tab === tab) return;
    S.tab = tab;
    document.querySelectorAll("#tabs .tab").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
    render();
  }

  function fromNow(ms) {
    const d = Math.round((ms - Date.now()) / 60000);
    if (d <= 0) return "就是现在";
    if (d < 60) return d + " 分钟后";
    const h = Math.floor(d / 60), m = d % 60;
    return h + " 小时" + (m ? m + " 分" : "") + "后";
  }
  function tag(text, tone) {
    return '<span class="chip' + (tone ? " " + tone : "") + '">' + text + "</span>";
  }
  function nowLineHtml(day, doing) {
    const cx = cur();
    const loc = doing === "睡觉" ? "" : (currentPlace(cx) || String(day.location || ""));
    const aff = cx.aff ? [cx.aff.tier, cx.aff.relation].filter(Boolean).join(" · ") : "";
    return '<span class="doing"><span class="live"></span>' + esc(doing ? "正在" + doing : day.doing) + "</span>" +
      (loc ? '<span class="loc">📍 ' + esc(loc) + "</span>" : "") +
      (aff ? '<span class="loc">❤ ' + esc(aff) + "</span>" : "");
  }
  function kv(label, value, cls) {
    const col = cls && cls.indexOf("col") >= 0;
    return '<div class="kv' + (col ? " col" : "") + '"><b>' + esc(label) + '</b><span' + (cls ? ' class="' + cls.replace("col", "").trim() + '"' : "") + ">" + value + "</span></div>";
  }
  function sortedItems(c) {
    return ((c.plan && c.plan.items) || []).slice().sort((a, b) => a.fireAt - b.fireAt);
  }

  function panelState(c) {
    const cx = cur();
    const doing = currentDoing(cx);
    const next = sortedItems(c).find((w) => w.act && w.fireAt >= c.now);
    const ch = c.character;
    const ava = ch.avatar ? '<img src="' + esc(ch.avatar) + '" alt="">' : esc((ch.name || "?").slice(0, 1));
    return '<div class="card hero"><div class="hero-hd" id="hero-who"><div class="ava">' + ava + '</div>' +
      '<div class="meta"><div class="name">' + esc(ch.name) + '</div><div class="now">' + nowLineHtml(c.day, doing) + "</div></div>" +
      '<button class="act" id="btn-regen"' + (cx.busy ? " disabled" : "") + ">" + (cx.busy ? "生成中…" : "↻ 重新生成") + "</button></div>" +
      (function () {
        // 大字是此刻的情绪；它盖住底色时，把底色和缘由缩在下面一行，看得出是被什么带偏的
        const m = moodNow(c.day, c.now);
        return '<div class="mood-row"><div class="mood-emoji">' + esc(c.day.moodEmoji || "🌙") + "</div>" +
          '<div class="mood-body"><div class="mood-text">' + esc(m.text || c.day.mood) + "</div>" +
          (m.base ? "" : '<div class="mood-sub">' + (m.from && m.from !== doing ? '<span class="chip">因为' + esc(m.from) + "</span>" : "") + '<span class="chip">底色「' + esc(c.day.mood) + '」</span></div>') +
          "</div></div>";
      })() +
      (function () {
        const e = energyAt(c.day, c.now), b = c.day.energy != null ? +c.day.energy : e;
        return '<div class="energy"><div class="lab"><span>精力</span><span>' + e + "%"
          + (e !== b ? ' <span style="opacity:.45">起床 ' + b + "%</span>" : "") + "</span></div>"
          + '<div class="bar"><div class="fill" data-w="' + e + '"></div></div></div>';
      })() +
      '<div class="kvs link" id="go-heart">' +
      (next
        ? kv("下一次想起你", esc(next.time) + " · " + esc(fromNow(next.fireAt)), "hi") +
          kv("那会儿TA想说", "「" + esc(next.intent) + "」", "col")
        : kv("下一次想起你", "今天没有还没到点的时刻了", "dim")) +
      (function () {
        if (!S.settings.threadsOn) return "";
        const th = liveThreads(cx, c.now).slice().sort((x, y) => (threadDueMs(x, c.now) || 9e15) - (threadDueMs(y, c.now) || 9e15));
        if (!th.length) return "";
        const shown = th.slice(0, 2).map((t) => esc(t.text) + (threadWhen(t, c.now) ? "（" + esc(threadWhen(t, c.now)) + "）" : ""));
        return kv("心里挂着", shown.join(" · ") + (th.length > 2 ? " · 还有 " + (th.length - 2) + " 件" : ""));
      })() +
      '<div class="go">去心动页 ›</div></div></div>';
  }

  function panelPulse(c) {
    const cx = cur();
    const items = sortedItems(c);
    const armed = items.filter((w) => w.act);
    const fired = armed.filter((w) => w.fireAt < c.now);
    const wait = armed.filter((w) => w.fireAt >= c.now);
    const reach = wait.filter((w) => w.delivery === "push");
    const skipped = items.filter((w) => !w.act);
    const imp = items.filter(isImpromptu);
    const adj = items.filter((w) => w.adj);
    const last = fired.length ? fired[fired.length - 1] : null;
    const quota = (c.settings && c.settings.quota) || 0;
    const stat = (n, cap, delay) => '<div class="stat"' + (delay ? ' style="animation-delay:' + delay + 'ms"' : "") +
      '><div class="num">' + n + '</div><div class="cap">' + cap + "</div></div>";
    return '<div class="card"><div class="sec-head"><span class="t">今 日 心 动</span>' +
      '<button class="act" id="btn-replan"' + (cx.busy ? " disabled" : "") + ">" + (cx.busy ? "处理中…" : replanLabel()) + "</button></div>" +
      (c.plan ? "" : '<div class="archive-note" style="padding-bottom:10px">'
        + (liveMode()
          ? "今天的念头由TA随时起，早上不预先排。点右上角「♥ 重置今天」把计划寄到云上，云端才接得上手。"
          : "今天还没编排过。点右上角「♥ 重新编排」，看看TA会在哪些时刻想起你。") + "</div>") +
      (wait[0]
        ? '<div class="quote"><div class="from">' + esc(wait[0].time) + ' · 接下来想找你</div>「' + esc(wait[0].intent) + "」</div>"
        : last
        ? '<div class="quote"><div class="from">' + esc(last.time) + ' · 最近一次想起你</div>「' + esc(last.intent) + "」</div>"
        : '<div class="quote dim">今天还没想起过你</div>') +
      '<div class="stats four" style="margin:12px 0 2px">' +
      stat(fired.length, "已想起") + stat(wait.length, "待 发", 60) +
      stat(skipped.length, "作 罢", 120) + stat(armed.length + "/" + quota, "配 额", 180) + "</div>" +
      '<div class="strip">' +
      tag(wait.length ? (reach.length === wait.length ? "待发的都离线可达" : "离线可达 " + reach.length + " / " + wait.length) : "没有待发", wait.length && reach.length === wait.length ? "ok" : (wait.length ? "warn" : "")) +
      tag(cloudRecheckOn() ? "云端复核 · 每 5 分钟" : (cloudCfg() ? "云端复核关着" : "没配云"), cloudRecheckOn() ? "ok" : "") +
      (+S.settings.impulseMode === 1 && !cloudRecheckOn() ? tag("随用随判要配云，先按早上定完跑", "warn") : "") +
      (() => { const t = usageTotals(); return tag("模型调用 " + t.calls + (t.capCalls ? "/" + t.capCalls : "") + " · " + fmtTok(t.tokens) + (t.capTokens ? "/" + fmtTok(t.capTokens) : "") + " token", usageOver() ? "warn" : ""); })() +
      (c.day && c.day.by === "cloud" ? tag("今天由云端生成", "cool") : (cloudGenOn() ? tag("明天云端生成 " + esc(S.settings.autoGenAt || SET_DEF.autoGenAt), "") : "")) +
      tag(c.plan && c.plan.recheckAt ? "本机复核 " + esc(fmtHM(c.plan.recheckAt)) : "本机还没复核过", "") +
      (adj.length || imp.length ? tag([adj.length ? "复核改了 " + adj.length + " 处" : "", imp.length ? "临时念头 " + imp.length : ""].filter(Boolean).join(" · "), "cool") : "") +
      "</div></div>";
  }

  function panelThreads(c) {
    const cx = cur(), now = c.now;
    const list = liveThreads(cx, now).slice().sort((a, b) => (threadDueMs(a, now) || 9e15) - (threadDueMs(b, now) || 9e15));
    const done = (cx.threads || []).filter((t) => t.done && threadAlive(t, now)).sort((a, b) => (+b.at || 0) - (+a.at || 0));
    const WHO = { user: "你手动记的", app: "本机复核时记的", cloud: "云端复核时记的" };
    // 展开的详情：为什么记它、几时记的、提醒过没有；了结和删掉都收在这里，免得列表上一戳就没
    const detail = (t) => {
      const when = threadWhen(t, now);
      const marks = String(t.nudge || "").trim().split(/\s+/).filter(Boolean).length;
      return '<div class="th-detail">'
        + '<div class="th-why">' + esc(t.why || (t.by === "user" ? "你手动记的" : "（当时没记下由头）")) + "</div>"
        + '<div class="dim">' + THREAD_KIND[t.kind] + (when ? " · " + esc(when) : "")
        + " · " + esc(WHO[t.by] || "记于") + " " + esc(dateBrief(+t.since || +t.at || now))
        + (marks ? " · 提起过 " + marks + " 次" : "") + "</div>"
        + '<div class="th-acts">' + (t.done
          ? '<button class="mini" data-act="undone">恢复</button>'
          : '<button class="mini" data-act="done">了结</button>')
        + '<button class="mini drop-btn" data-act="drop">删掉</button></div></div>';
    };
    const row = (t) => '<div class="th-row' + (S._thOpen === t.id ? " open" : "") + (t.done ? " is-done" : "") + '" data-tid="' + esc(t.id) + '">'
      + '<div class="th-head"><span class="badge ' + (t.kind === "promise" ? "cool" : t.kind === "date" ? "warn" : "") + '">' + THREAD_KIND[t.kind] + "</span>"
      + '<span class="th-text">' + esc(t.text) + (threadWhen(t, now) ? ' <span class="dim">' + esc(threadWhen(t, now)) + "</span>" : "") + "</span>"
      + '<span class="th-arrow">' + (S._thOpen === t.id ? "▾" : "›") + "</span></div>"
      + (S._thOpen === t.id ? detail(t) : "") + "</div>";
    const shown = S._thDone ? done : list;
    return '<div class="card"><div class="sec-head"><span class="t">惦 记</span>' + (shown.length ? '<span class="badge">' + shown.length + " 件</span>" : "")
      + (done.length || S._thDone ? '<button class="act" id="th-done">' + (S._thDone ? "看还挂着的" : "已了结 " + done.length) + "</button>" : "")
      + '<button class="act" id="th-plus" title="手动记一件">' + (S._thAdd ? "收起" : "＋ 记一件") + "</button></div>"
      + (S._thAdd ? '<form class="th-add" id="th-add"><input name="text" placeholder="如「我生日」「周五面试」" maxlength="40"><input name="when" placeholder="9/10 或 15:00"><button type="submit" class="mini">记</button></form>' : "")
      + (shown.length ? shown.map(row).join("")
        : S._thDone ? '<div class="archive-note">这一周还没有了结的。</div>'
        : '<div class="archive-note">聊天里说定的事、没聊完的话头、重要的日子，TA会记在这里跨天惦记着；快到点、到日子了会自己想起来找你。</div>')
      + (S._thDone ? '<div class="archive-note">了结的留一周，之后自动清掉。恢复回去TA会重新惦记。</div>' : "")
      + "</div>";
  }
  function panelWakes(c) {
    const items = sortedItems(c);
    const now = fmtHM(c.now);
    let tl = "", idx = 0, nowInserted = false;
    const nowLine = '<div class="tl-now"><span class="lbl">现在 ' + now + "</span></div>";
    for (const w of items) {
      if (w.time >= now && !nowInserted) { tl += nowLine; nowInserted = true; }
      tl += wakeRow(w, w.time < now, w.source, 'style="animation-delay:' + (idx++ * 40) + 'ms"');
    }
    if (items.length && !nowInserted) tl += nowLine;
    return '<div class="card"><div class="sec-head"><span class="t">时 刻</span></div>' +
      '<div class="tl">' + (tl || '<div class="nt" style="padding:8px 0;color:var(--tx3)">' + (liveMode() ? "还没有念头。TA白天想起来了会自己排。" : "还没编排。点上面「♥ 重新编排」。") + "</div>") + "</div></div>";
  }
  // 随用随判模式下「编排」不再排念头，只把计划重新寄到云上，按钮跟着改名
  function replanLabel() { return liveMode() ? "♥ 重置今天" : "♥ 重新编排"; }
  // 随用随判的念头全在云端起，没配云就只能退回早上定完
  function liveMode() { return +S.settings.impulseMode === 1 && cloudRecheckOn(); }
  function panelTimeline(c) {
    const cx = cur();
    const now = fmtHM(c.now);
    // 只放日程和作息标记；心动时刻在心动页
    const merged = c.day.schedule.map((it) => ({ kind: "sched", time: it.time, it }));
    // 起床和上床两行只是标记，不可点；过零点才睡的排在最末，标「次日」
    const sw = sleepWindow(c.day);
    if (sw && c.day.wake) merged.push({ kind: "mark", time: "00:00", label: c.prev && c.prev.bed ? "昨晚 " + c.prev.bed : "昨晚", icon: "🌙", text: "睡觉", night: true });
    if (sw && c.day.wake) merged.push({ kind: "mark", time: sw.wake, icon: "☀️", text: "起床" });
    if (sw && c.day.bed) merged.push({ kind: "mark", time: sw.overnight ? "24:00" : sw.bed, label: (sw.overnight ? "次日 " : "") + sw.bed, icon: "🌙", text: "睡觉" });
    // 同一时刻起床排在日程前面：先醒才能做事
    const ord = (m) => String(m.time) + (m.kind === "mark" && m.text === "起床" ? "0" : "1");
    merged.sort((a, b) => ord(a).localeCompare(ord(b)));
    let tl = "", idx = 0, nowInserted = false;
    const nowLine = '<div class="tl-now"><span class="lbl">现在 ' + now + "</span></div>";
    let curIdx = -1; // 最后一条已开始的日程 = 正在进行；睡着时亮的是「睡觉」那行
    merged.forEach((m, i) => { if (m.time <= now) curIdx = i; });
    if (asleepAt(c.day, now)) { const early = sw && now < sw.wake; curIdx = merged.findIndex((m) => m.kind === "mark" && m.text === "睡觉" && !!m.night === !!early); }
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      const cur = i === curIdx;
      const past = m.time < now && !cur;
      if (m.time >= now && !nowInserted) { tl += nowLine; nowInserted = true; }
      const delay = 'style="animation-delay:' + (idx++ * 40) + 'ms"';
      if (m.kind === "mark") {
        tl += '<div class="tl-item mark' + (past ? " past" : "") + (cur ? " cur" : "") + '" ' + delay + '><span class="dot"></span>'
          + '<div class="row1"><span class="tm">' + esc(m.label || m.time) + '</span><span class="tt">' + m.icon + " " + m.text + "</span></div></div>";
      } else {
        {
          const steps = Array.isArray(m.it.steps) ? m.it.steps.length : 0;
          tl += '<div class="tl-item sched' + (past ? " past" : "") + (cur ? " cur" : "") + '" data-si="'
            + ((cx.day && cx.day.schedule) || []).indexOf(m.it) + '" ' + delay + '><span class="dot"></span>'
            + '<div class="row1"><span class="tm">' + esc(m.time) + (m.it.end ? '<span class="tm-end">–' + esc(m.it.end) + "</span>" : "") + '</span><span class="tt">' + esc(m.it.title) + "</span></div>"
            + (m.it.note ? '<div class="nt">' + esc(m.it.note) + "</div>" : "")
            + (steps ? '<div class="nt more">…点开看这段时间里的 ' + steps + " 件事</div>"
               : m.it.detail ? '<div class="nt more">…点开看细化的部分</div>' : "") + "</div>";
        }
      }
    }
    if (merged.length && !nowInserted) tl += nowLine; // 一天已全部过完
    return '<div class="card"><div class="sec-head"><span class="t">TA 的 一 天</span></div>' +
      '<div class="tl">' + (tl || '<div class="nt" style="padding:8px 0;color:var(--tx3)">暂无日程</div>') + "</div></div>";
  }

  function panelRules(c) {
    const st = c.settings || {};
    const on = [];
    for (const f of SET_FIELDS()) {
      if (f.type !== "toggles") continue;
      for (const it of f.items || []) if (st[it.key]) on.push(it.label);
    }
    return '<details class="card fold"' + (S._rulesOpen ? " open" : "") + '><summary><span class="t">现 在 的 分 寸</span>' +
      '<span class="sm">' + (st.quota || 0) + " 次/天 · 隔 " + (st.minGapMin > 0 ? st.minGapMin + " 分" : "不限") + " · 免打扰 " + esc(st.quietStart || "—") + "–" + esc(st.quietEnd || "—") + "</span>" +
      '<span class="cv">›</span></summary><div class="kvs">' +
      kv("免打扰时段", esc(st.quietStart || "—") + " — " + esc(st.quietEnd || "—")) +
      kv("每天最多主动", (st.quota || 0) + " 次") +
      kv("两个时刻至少隔", st.minGapMin > 0 ? st.minGapMin + " 分钟" : "不限制", st.minGapMin > 0 ? "" : "dim") +
      kv("主动倾向", esc(segLabel("bias", st.bias || 0))) +
      kv("未回应降速", st.maxUnanswered > 0 ? "连续 " + st.maxUnanswered + " 轮没回就收手" : "关闭", st.maxUnanswered > 0 ? "" : "dim") +
      kv("在页时动态复核", st.recheckMin > 0 ? "每 " + st.recheckMin + " 分钟" : "关闭", st.recheckMin > 0 ? "" : "dim") +
      '</div><div class="rule-tags">' + (on.length ? on.map((t) => '<span class="chip">' + esc(t) + "</span>").join("") : '<span class="chip">开关全关</span>') +
      '</div><div class="panel-act"><button class="tgl" id="btn-panel-set">⚙ 调整</button></div></details>';
  }

  // 复核留下的调整痕迹 → 小标签
  function adjBadge(w) {
    if (w.held && w.fireAt >= Date.now()) return '<span class="badge cool">押后 ' + esc(fmtHM(w.fireAt)) + "</span>";
    if (w.adj === "cooled") return '<span class="badge cool">降温</span>';
    if (w.adj === "extra") return '<span class="badge cool">临时起念</span>';
    if (w.adj === "recheck") return '<span class="badge cool">复核调整</span>';
    if (w.adj === "cloud") return '<span class="badge cool">云端复核</span>';
    return "";
  }

  function wakeRow(w, past, title, delay, sub) {
    let badge = "", intent = "";
    if (w.act) {
      const fired = w.fireAt < Date.now();
      badge = fired ? '<span class="badge done">已想起你</span>'
        : w.delivery === "push" ? '<span class="badge push">离线可达</span>'
        : '<span class="badge local" title="' + esc(w.reason) + '">仅在线</span>';
      intent = '<div class="intent">「' + esc(w.intent) + '」</div>';
      if (!fired && w.delivery === "local" && w.reason) intent += '<div class="nt">未挂上离线推送：' + esc(w.reason) + "</div>";
    } else {
      badge = '<span class="badge off">作罢</span>';
      intent = '<div class="intent">' + esc(w.why || "TA这会儿不想") + "</div>";
    }
    return '<div class="tl-item wake ' + (w.act ? (w.fireAt >= Date.now() ? "armed" : "") : "skipped") + (past ? " past" : "") + (sub ? " sub" : "") + '" data-t="' + esc(w.time) + '" ' + delay + '><span class="dot"></span>' +
      '<div class="row1"><span class="tm">' + esc(w.time) + '</span><span class="tt">' + esc(title || w.source) + "</span>" + badge + adjBadge(w) + "</div>" + intent + "</div>";
  }
