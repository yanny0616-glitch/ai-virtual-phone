  /* ================= VPS 后端直连 =================
     开了「交给 VPS 后端」：TA的一天、念头、账本、判断记录都在后端，挂念只是它的窗口。
     每分钟读一次 /app/state 填进 cx.day / cx.plan / cx.threads，界面照旧渲染；手动操作直接发给后端。
     注入聊天、回复闸门、在线状态、朋友圈和写回系统日程由小手机宿主每分钟从后端取，挂念关着也照常。
     鉴权用设置里本来就存着的个人云 Secret key，后端拿它去个人云核对，不多存一把钥匙。 */
  function serverCfg(settings) {
    const st = settings || S.settings || {};
    const c = /^https:\/\//.test(String(st.cloudUrl || "")) && String(st.cloudKey || "").trim() ? { key: String(st.cloudKey).trim() } : null;
    const url = String(st.serverUrl || SERVER_URL_DEF).trim().replace(/\/+$/, "");
    // 本机回环地址放行 http，给自测起的后端用
    return c && (/^https:\/\//.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) ? { url: url, key: c.key } : null;
  }
  async function serverFetch(path, init, timeoutMs, settings) {
    const c = serverCfg(settings);
    if (!c) throw new Error("先在设置「云端」里填好个人云地址和 Secret key");
    const ms = timeoutMs || 25000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const headers = { Authorization: "Bearer " + c.key };
    if (init && init.body) headers["Content-Type"] = "application/json";
    try {
      const r = await fetch(c.url + path, Object.assign({ cache: "no-store" }, init || {}, { headers: headers, signal: controller.signal }));
      const data = await r.json().catch(() => null);
      if (r.status === 401) throw new Error("后端不认这把密钥：设置里的个人云要和后端用的是同一个项目");
      if (!r.ok || !data || data.ok !== true) throw new Error((data && data.error) || ("后端返回 HTTP " + r.status));
      return data;
    } catch (e) {
      if (controller.signal.aborted) throw new Error("后端 " + Math.round(ms / 1000) + " 秒没回话");
      throw e;
    } finally { clearTimeout(timer); }
  }
  const serverPath = (cx, tail) => "/app/characters/" + encodeURIComponent(cx.character.id) + (tail || "");

  // 寄给后端的设置：键名和取值与原来寄个人云的 cloudContext 一致，后端迁入时就是按这份存的
  function serverSettings() {
    const st = S.settings;
    return Object.assign(userSleepContext(), {
      tzOffsetMin: -new Date().getTimezoneOffset(),
      recheckEnabled: 1,
      quota: st.quota, quietStart: st.quietStart, quietEnd: st.quietEnd,
      minGapMin: st.minGapMin, maxUnanswered: st.maxUnanswered,
      chatCandidates: st.chatCandidates ? "允许临时起念" : "不允许临时起念",
      bias: biasText(),
      gateDailyCap: st.gateDailyCap, gateGapMin: st.gateGapMin, gateHorizonMin: st.gateHorizonMin,
      gateFreshMin: st.gateFreshMin, gateMinMsgs: st.gateMinMsgs,
      onlineRounds: st.onlineRounds, offlineRounds: st.offlineRounds,
      selfImpulseCap: st.selfImpulseCap, selfSilenceMin: st.selfSilenceMin,
      missDays: st.missDays, echoOn: st.echoOn ? 1 : 0,
      presendMax: st.presendMax, presendTalkingMin: st.presendTalkingMin, presendGapMin: st.presendGapMin,
      busyHold: st.busyHold ? 1 : 0, busyBufferMin: st.busyBufferMin, busyMaxHoldMin: st.busyMaxHoldMin,
      sleepMode: st.sleepMode, sleepWakeProb: st.sleepWakeProb,
      threadsOn: st.threadsOn ? 1 : 0, threadDays: st.threadDays, chatEditsDay: st.chatEditsDay !== false,
      momentsOn: momentsReady() ? 1 : 0, momentsWeekly: st.momentsWeekly, momentsGapH: st.momentsGapH,
      genEnabled: st.autoGen ? 1 : 0, autoGenAt: st.autoGenAt || SET_DEF.autoGenAt,
      forkLevel: GuaNianForks.forkLevel(st.forkLevel), forkBurst: st.forkBurst ? 1 : 0, moodGate: st.moodGate ? 1 : 0,
      dayPrompt: st.dayPrompt || DEFAULT_DAY_PROMPT,
    });
  }

  // 一次读回所有挂念的人
  async function serverPull() {
    const ids = S.order.slice();
    if (!ids.length) return;
    try {
      const r = await serverFetch("/app/state?ids=" + encodeURIComponent(ids.join(",")));
      S._server = { mode: r.mode, running: r.running, lastTickAt: r.lastTickAt, at: Date.now(), error: "" };
      for (const st of r.characters || []) {
        const cx = S.byId[st.characterId];
        if (!cx) continue;
        cx.server = st;
        const ok = st.exists && !st.error;
        cx.day = ok ? st.day : null;
        cx.prev = ok ? st.prev : null;
        cx.plan = ok ? st.plan : null;
        cx.threads = ok && Array.isArray(st.threads) ? st.threads : [];
      }
    } catch (e) {
      S._server = Object.assign({}, S._server, { at: Date.now(), error: String(e && e.message || e) });
      throw e;
    }
  }
  function sameValue(a, b) { return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
  // 后端没有这个人就建上；名字、会话、设置有变化才写
  async function serverEnsure(cx) {
    const st = cx.server || {};
    if (!st.legacyStopped && !cx._legacyStopped) await serverHandoff(cx);
    const settings = serverSettings();
    let sessionId = "";
    try { sessionId = await cloudSessionId(cx); } catch (e) { if (!st.exists) throw e; }
    const body = { name: cx.character.name, settings: settings, enabled: true };
    if (sessionId) body.sessionId = sessionId;
    const changed = !st.exists || !st.enabled || st.name !== body.name || (sessionId && st.sessionId !== sessionId)
      || Object.keys(settings).some((k) => !sameValue((st.settings || {})[k], settings[k]));
    if (!changed) return false;
    await serverFetch(serverPath(cx), { method: "POST", body: JSON.stringify(body) });
    await log(cx, st.exists ? "设置已同步到后端" : "后端开始挂念TA");
    return true;
  }
  async function serverHandoff(cx, settings) {
    if (cx.busy || cx._planLock) throw new Error("本机还在处理计划，请结束后再交接");
    const r = await serverFetch(serverPath(cx, "/handoff"), { method: "POST", body: JSON.stringify({ owner: myDev() }) }, 25000, settings);
    if (r.queued || r.stopped !== true) throw new Error("旧云端停用尚未确认，请稍后再保存；VPS 尚未接管");
    cx._legacyStopped = true;
    // 后端暂时停用，下一次 ensure 必须重新确认启用。
    if (cx.server) { cx.server.enabled = false; cx.server.legacyStopped = true; }
  }
  async function serverForget(cx) {
    const r = await serverFetch(serverPath(cx), { method: "POST", body: JSON.stringify({ enabled: false }) });
    if (r.queued) throw new Error("后端停用已排队，等这一轮结束后再保存；本机尚未接管");
    if (!r.character || r.character.enabled !== false) throw new Error("后端尚未确认停用，本机尚未接管");
  }
  // 手动操作：按钮转圈，做完读回最新状态
  async function serverOp(cx, fn) {
    if (cx.busy) return;
    cx.busy = true; render();
    try { await fn(); }
    catch (e) { toast(String(e && e.message || e)); }
    finally {
      await serverPull().catch(() => { /* 下一分钟再读 */ });
      cx.busy = false; cx.archive = null; render();
    }
  }
  const queuedNote = (r, done) => r && r.queued ? "排上了：后端正在判断，这一轮完了就改" : done;
  function serverRegenerate(cx) {
    if (cx.day && !confirm("让后端重新生成TA今天的一天？会调一次模型；已经排好的念头不动。")) return;
    return serverOp(cx, async () => {
      const r = await serverFetch(serverPath(cx, "/regenerate"), { method: "POST" }, 180000);
      toast(queuedNote(r, r.note || "已生成"));
      await log(cx, "后端生成今天：" + (r.queued ? "排队中" : r.note || "已生成"));
    });
  }
  function serverTick(cx) {
    return serverOp(cx, async () => {
      const r = await serverFetch(serverPath(cx, "/tick"), { method: "POST" }, 180000);
      const tr = r.trace || {};
      toast(tr.error ? "后端这一轮出错：" + tr.error : "后端判了一轮：" + ((tr.steps || []).slice(-1)[0] || "没什么要做的"));
    });
  }
  function serverThread(cx, body, done) {
    return serverOp(cx, async () => {
      const r = await serverFetch(serverPath(cx, "/threads"), { method: "POST", body: JSON.stringify(body) });
      toast(queuedNote(r, (done || r.note || "改好了") + (r.dropped ? "，撤掉了 " + r.dropped + " 个念头" : "")));
    });
  }
  async function serverSaveSchedule(cx, sched, note) {
    if (!cx.day) throw new Error("今天还没有生活面");
    const body = { date: cx.day.date, schedule: sched, forks: cx.day.forks || [], conds: cx.day.conds || [], note: note };
    const r = await serverFetch(serverPath(cx, "/day"), { method: "PUT", body: JSON.stringify(body) });
    cx.day = r.day || Object.assign({}, cx.day, { schedule: sched });
    // 宿主每分钟也会写回，这里先写一次让日程表立刻跟上
    try { await syncCalendar(cx, await readTodayCalendar(cx)); } catch (e) { await log(cx, "日程改动写回系统日程失败：" + (e && e.message || e)); }
    await log(cx, note);
    render();
    toast(queuedNote(r, note));
  }

  async function serverStart() {
    try { await serverPull(); }
    catch (e) { toast("连不上后端：" + (e && e.message || e)); }
    render();
    for (const cx of allCx()) {
      await refreshAffection(cx);
      try { if (await serverEnsure(cx)) await serverPull(); }
      catch (e) { await log(cx, "后端建档 / 同步设置失败：" + (e && e.message || e)); toast("后端同步失败：" + (e && e.message || e)); }
      await freezeServerTemplates(cx).catch(() => { /* 已在函数内记日志 */ });
    }
    render();
    syncUsageCloud(true).catch(() => { /* 已在函数内记日志 */ });
    const refresh = async () => {
      if (document.hidden) return;
      try { await serverPull(); } catch (e) { /* 记在 S._server.error，诊断页能看到 */ }
      if (S.tab === "today" || S.tab === "heart") { S._still = true; render(); S._still = false; }
    };
    setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }

  /* ---- 诊断页（后端模式） ---- */
  const SERVER_KIND = {
    judge: "判断", gate: "门禁", gen: "生成", send: "发送", presend: "发送前复核", hold: "押后", defer: "押后", lit: "点亮",
    extra: "临时起念", dedupe: "去重", recheck: "作罢", freshness: "等待", ledger: "账本", settle: "了结", promise: "约定",
    post: "朋友圈", mood: "情绪", schedule: "改日程", setup: "开始挂念", error: "出错",
  };
  function renderServerDiag() {
    const cx = cur(), st = cx.server || {}, sv = S._server || {};
    const v = $("#subview") || $("#view");
    S._diagOpen = S._diagOpen || {};
    const open = (id, dflt) => id in S._diagOpen ? S._diagOpen[id] : dflt;
    const when = (ms) => {
      if (!ms) return "—";
      const d = new Date(ms);
      return (dateStrOf(d) === todayStr() ? "" : (d.getMonth() + 1) + "/" + d.getDate() + " ") + fmtHM(ms);
    };
    const items = [];
    // 连接
    {
      const bad = !!sv.error;
      const body = '<div class="diag-item"><b>地址</b> ' + esc((serverCfg() || {}).url || "未配置") + "</div>"
        + (bad ? '<div class="diag-item"><b>最近一次读取失败</b> ' + esc(sv.error) + "</div>" : "")
        + '<div class="diag-item"><b>模式</b> ' + (sv.mode === "live" ? "真发" : sv.mode === "shadow" ? "影子（只记录不发）" : "未知") + "</div>"
        + '<div class="diag-item"><b>上一轮判断</b> ' + esc(when(sv.lastTickAt)) + (sv.running ? " · 正在跑" : "") + "</div>"
        + '<div class="archive-note">后端每分钟判一轮。挂念开着时每分钟读一次；注入聊天、在线状态、朋友圈和写回日程由小手机宿主每分钟从后端取。</div>';
      const tone = bad || !sv.mode ? "bad" : sv.mode !== "live" ? "warn" : "ok";
      items.push(dgItem("srv-conn", "后端连接", body, bad ? "连不上" : (sv.mode === "live" ? "真发" : "影子") + " · 上一轮 " + when(sv.lastTickAt), tone, open("srv-conn", tone !== "ok")));
    }
    // 这个角色
    {
      const snaps = st.snapshots || [];
      const need = ["chat", "daily", "judge"];
      const missing = need.filter((p) => !snaps.some((s) => s.purpose === p));
      const body = !st.exists
        ? '<div class="diag-item">后端还没有TA。打开一次和TA的聊天再回来，挂念会自动建档。</div>'
        : '<div class="diag-item"><b>挂念</b> ' + (st.enabled ? "开着" : "关着") + " · 时区 UTC" + (st.tz >= 0 ? "+" : "") + (st.tz / 60) + "</div>"
          + '<div class="diag-item"><b>待发定时器</b> ' + (st.pendingTimers || 0) + " 个</div>"
          + (st.lastError ? '<div class="diag-item"><b>上一轮出错</b> ' + esc(st.lastError) + "</div>" : "")
          + (st.plan && st.plan.genError ? '<div class="diag-item"><b>生成失败</b> ' + esc(st.plan.genError) + "</div>" : "")
          + '<div class="diag-item"><b>提示词模板</b> ' + (need.map((p) => {
              const s = snaps.find((x) => x.purpose === p);
              return ({ chat: "聊天", daily: "生成一天", judge: "判断" })[p] + " " + (s ? when(s.capturedAt) : "缺");
            }).join(" · ")) + "</div>"
          + '<div class="archive-note">模板是TA每次回复、小手机切到后台时自动寄的；缺了点下面「重寄模板」。</div>';
      const tone = !st.exists || st.lastError || missing.length ? "warn" : "ok";
      items.push(dgItem("srv-char", "TA在后端", body + '<div class="dg-act"><button class="tgl" id="btn-srv-freeze">重寄模板</button><button class="tgl" id="btn-srv-tick"' + (cx.busy ? " disabled" : "") + ">立刻判一次</button></div>",
        !st.exists ? "未建档" : missing.length ? "缺模板 " + missing.length : st.lastError ? "上一轮出错" : "正常", tone, open("srv-char", tone !== "ok")));
    }
    // 注入聊天
    items.push(dgItem("srv-ctx", "注入聊天的状态", st.chatContext
      ? '<div class="diag-item" style="white-space:pre-wrap">' + esc(st.chatContext) + '</div><div class="archive-note">' + (S.settings.injectChat ? "小手机每分钟取一次写进TA的聊天提示词。" : "「注入聊天」关着，不会写进提示词。") + "</div>"
      : '<div class="diag-item">今天还没有状态可注入。</div>', st.chatContext ? (S.settings.injectChat ? "注入中" : "没开") : "没有", "", open("srv-ctx", false)));
    // 判断记录
    {
      const decs = (st.decisions || []);
      const body = decs.length
        ? decs.map((d) => '<div class="diag-item"><b>' + esc(when(d.at)) + "</b> " + esc(SERVER_KIND[d.kind] || d.kind) + " · " + esc(d.note) + (d.mode === "shadow" ? ' <span class="badge cool">影子</span>' : "") + "</div>").join("")
          + '<div class="archive-note">最近 120 条，按时间倒序。点「心动」页任一时刻能看那一条的完整轨迹。</div>'
        : '<div class="diag-item">还没有记录。</div>';
      items.push(dgItem("srv-dec", "后端判断记录", body, decs.length ? "最近 " + when(decs[0].at) : "还没有", "", open("srv-dec", true)));
    }
    // 本机日志
    {
      const logItems = (S.logs && S.logs.items || []).slice().reverse();
      items.push(dgItem("srv-logs", "本机运行日志", logItems.length
        ? logItems.map((l) => '<div class="diag-item"><b>' + esc(when(l.at)) + "</b> " + esc(l.text) + "</div>").join("")
        : '<div class="diag-item">还没有日志。</div>', logItems.length ? logItems.length + " 条" : "还没有", "", open("srv-logs", false)));
    }
    items.push(dgItem("preview", "此刻预览", cx.day
      ? previewZone() + '<div class="archive-note">按TA此刻的状态生成一句话，不发送、不进聊天、不占额度，花一次本机模型调用。</div>'
      : '<div class="diag-item">TA的今天还没生成，没有状态可看。</div>', cx.day ? "" : "没状态", "", open("preview", false)));
    v.innerHTML = '<div class="card dg"><div class="sec-head"><span class="t">后 端</span><button class="act" id="btn-diag-refresh">刷新</button></div>' + items.join("") + "</div>";
    dgBindToggle(v);
    $("#btn-diag-refresh").onclick = async () => {
      try { await serverPull(); } catch (e) { toast("读取失败：" + (e && e.message || e)); }
      if (S.tab === "back" && S.sub === "diag") renderServerDiag();
    };
    const fz = $("#btn-srv-freeze");
    if (fz) fz.onclick = async () => { fz.disabled = true; fz.textContent = "寄送中…"; await freezeServerTemplates(cx).catch(() => {}); toast("模板已重寄，详情看本机日志"); renderServerDiag(); };
    const tk = $("#btn-srv-tick");
    if (tk) tk.onclick = () => serverTick(cx).then(() => { if (S.tab === "back" && S.sub === "diag") renderServerDiag(); });
    const pv = $("#btn-preview");
    if (pv) pv.onclick = () => preview(cur());
  }
