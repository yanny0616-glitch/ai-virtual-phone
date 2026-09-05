  /* ================= 核心：编排心动时刻 ================= */
  // 念头不再挂在日程节点上：日程只作为背景喂给模型，让TA自己说今天想在哪些时刻找用户。
  // 这里给的是「今天剩下的时间长什么样」——不按固定网格采样（那会漏掉夹在两点之间的短日程），
  // 而是按日程自己的边界走：每条还没过完的日程一行，中间的空档各补一行，都带那一刻的精力和
  // busy 标记。模型自己挑时刻时才有依据，不至于把念头排到TA正开会那会儿。
  function dayOutlook(cx) {
    const rows = [], now = Date.now(), sw = sleepWindow(cx.day);
    const endMs = (sw && timeToMs(sw.overnight ? "23:50" : sw.bed)) || timeToMs("23:00") || now;
    const push = (ms, doing, busy, end) => {
      const hm = fmtHM(ms);
      if (ms < now || ms > endMs || inQuiet(hm) || asleepAt(cx.day, hm)) return;
      rows.push({ time: hm, end: end || "", energy: energyAt(cx.day, ms), doing: doing, busy: !!busy });
    };
    let cursor = now;
    for (const it of (cx.day.schedule || [])) {
      const a = timeToMs(it.time); if (!a) continue;
      const b = it.end ? timeToMs(it.end) : null;
      if ((b || a) < now) continue;
      if (a - cursor > 20 * 60000) push(Math.round((Math.max(cursor, now) + a) / 2), "空着", false);
      push(Math.max(a, now), String(it.title || ""), isBusyItem(it), it.end || "");
      cursor = Math.max(cursor, b || a);
    }
    if (endMs - cursor > 20 * 60000) push(Math.round((Math.max(cursor, now) + endMs) / 2), "睡前自己待着", false);
    return rows.slice(0, 16);
  }

  // 主动倾向 → 给模型的一句话（0=自然，不加话）
  function biasText() {
    return ({
      "-2": "TA的主动倾向被设为「很克制」：只有非常强烈的理由才起念，宁缺毋滥。",
      "-1": "TA的主动倾向偏克制，起念要有充分理由。",
      "1": "TA最近比较想黏着用户，遇到合适的时刻更愿意主动。",
      "2": "TA现在非常想念用户，明显更愿意主动，额度内尽量多陪。",
    })[String(S.settings.bias || 0)] || "";
  }
  /* 数值层：全部规则计算、可解释，不让模型编数 */
  // 时段贴合：以 13 点和 21 点两个聊天高峰做高斯衰减
  function fitScore(fireAt) {
    const d = new Date(fireAt);
    return GuaNianScoring.fitScore(d.getHours() + d.getMinutes() / 60);
  }
  // 判断那一刻的约束压力快照（armedBefore=此前已起念数，streak=连续未回轮数，lastArmedAt=上一个起念时间）
  function calcScore(fireAt, armedBefore, streak, lastArmedAt) {
    const d = new Date(fireAt);
    return GuaNianScoring.calculateScore({
      localHour: d.getHours() + d.getMinutes() / 60,
      fireAt, armedBefore, streak, lastArmedAt,
      quota: S.settings.quota, maxUnanswered: S.settings.maxUnanswered, minGapMin: S.settings.minGapMin,
    });
  }

  // 你最后一条之后TA发了几「轮」没被回（消息需按时间升序）。
  // TA一次回复常拆成多条气泡：相邻 3 分钟内归为一轮，不逐条计数；
  // 且一轮要晾满 30 分钟才算「没回」——TA刚回复完、你还没来得及回的不算。
  function unansweredStreak(msgs) {
    return GuaNianScoring.countUnansweredRounds(msgs, Date.now());
  }

  // 临时起念不是日程排出来的，是复核时顺着聊天临时起的，重排不该把它推倒。
  // 新旧计划里都靠 source 的「临时」前缀认（本地和云端起念都写这个前缀）。
  function isImpromptu(w) { return !!w && /^临时/.test(String(w.source || "")); }

  function keptImpromptu(cx) {
    const floor = Date.now() + 3 * 60000;
    return (cx.plan && Array.isArray(cx.plan.items) ? cx.plan.items : [])
      .filter((w) => isImpromptu(w) && w.fireAt > floor);
  }

  async function cancelTodayWakes(cx, keepIds) {
    const done = Object.assign({}, keepIds || {});
    try {
      const wakes = await AiPhone.push.listWakes();
      const d0 = timeToMs("00:00"), d1 = d0 + 86400000;
      for (const w of wakes || []) {
        if (w.characterId === cx.character.id && w.fireAt >= d0 && w.fireAt < d1) {
          if (done[w.id]) continue;
          done[w.id] = 1;
          try { await AiPhone.push.cancelWake(w.id); } catch (e) { /* 已触发的取消失败可忽略 */ }
        }
      }
    } catch (e) { /* listWakes 失败不阻塞重排 */ }
    // 云端复核点亮的预约只写了服务端 push_jobs，宿主本地登记簿里没有，listWakes 遍历不到；
    // 计划项里回填的 wakeId 是唯一能找到它们的线索，不撤就会在重排后照发。
    for (const w of (cx.plan && Array.isArray(cx.plan.items) ? cx.plan.items : [])) {
      if (!w || !w.wakeId || done[w.wakeId]) continue;
      done[w.wakeId] = 1;
      try { await AiPhone.push.cancelWake(w.wakeId); } catch (e) { /* 已触发的取消失败可忽略 */ }
    }
    // 离线推送关着的时候撤销不会发到云端，之前挂上去的会留成孤儿照发；
    // 云端记录里没有角色 id，只能按会话 id 认，所以得先读过一次聊天记录
    if (!cloudCfg() || !cx._session) return;
    try {
      const jr = await cloudFetch("jobs", { method: "GET" }, { kind: "timed_task", limit: "20" });
      let n = 0;
      for (const j of (jr && jr.jobs) || []) {
        const id = /^timedwake:(timed_wake_capp_.+)$/.exec(String(j.triggerKey || ""));
        if (!id || j.status !== "pending" || j.sessionId !== cx._session || done[id[1]]) continue;
        done[id[1]] = 1; n++;
        try { await AiPhone.push.cancelWake(id[1]); } catch (e) { /* 宿主本地没登记也没关系，云端那条会被删 */ }
      }
      if (n) await log(cx, "撤掉云端残留的 " + n + " 条旧预约");
    } catch (e) { /* 云端查不到就算了 */ }
  }

  // 哨兵预约：云端复核和自发起念都要借一条已挂预约里冻着的模型凭据当模板，
  // TA早上一个时刻都没点亮的日子云端就整天没法动。所以每次编排都挂一条 48 小时后的
  // 预约专门当模板：云端到点认出它直接作废；cron 只派 36 小时内更新过的计划，所以
  // 48 小时够覆盖。真到点了只可能是两天没打开挂念，intent 里写的就是这个由头。
  function sentinelOf(cx) { return cx.character ? (S.settings.sentinels || {})[cx.character.id] || null : null; }
  // 不再挂念的人：今天的预约、48 小时哨兵、云端计划行全撤，否则两天后TA还会按哨兵的由头来找你
  async function unfreezeGenTemplates(cx) {
    if (!AiPhone.push || !AiPhone.push.unfreeze) return;
    for (const k of ["daily", "impulse", "judge"]) { try { await AiPhone.push.unfreeze({ characterId: cx.character.id, key: k }); } catch (e) { /* 旧宿主没这个接口 */ } }
    await patchSettings((s) => { const g = Object.assign({}, s.genTpls); delete g[cx.character.id]; const judges = { ...s.judgeTemplates }; delete judges[cx.character.id]; return { genTpls: g, judgeTemplates: judges }; });
  }
  async function forgetCharacter(cx) {
    await unfreezeGenTemplates(cx);
    await cancelTodayWakes(cx);
    const old = sentinelOf(cx);
    if (old && old.wakeId) { try { await AiPhone.push.cancelWake(old.wakeId); } catch (e) { /* 已触发的取消失败可忽略 */ } }
    if (cloudCfg()) { try { await cloudFetch("recheck-plan", { method: "DELETE", body: JSON.stringify({ characterId: cx.character.id }) }); } catch (e) { /* 云端没配好就算了 */ } }
    await patchSettings((s) => {
      const sentinels = Object.assign({}, s.sentinels), genTpls = Object.assign({}, s.genTpls);
      delete sentinels[cx.character.id]; delete genTpls[cx.character.id];
      return { sentinels: sentinels, genTpls: genTpls };
    });
  }
  async function armSentinel(cx) {
    const old = sentinelOf(cx);
    if (old && old.wakeId) { try { await AiPhone.push.cancelWake(old.wakeId); } catch (e) { /* 已触发的取消失败可忽略 */ } }
    let next = null;
    try {
      const res = await AiPhone.push.wake({
        characterId: cx.character.id, fireAt: Date.now() + 48 * 3600000, source: "tool",
        intent: "已经两天没在挂念里排过日程了，忽然想起用户，随口问候一句就好",
      });
      next = { wakeId: res.id, armed: !!res.armed };
      if (!res.armed) await log(cx, "哨兵预约只在本地挂上（" + (res.reason || "服务端未挂载") + "），云端复核这两天没有模板可借");
    } catch (e) { await log(cx, "哨兵预约失败（云端复核这两天没有模板可借）：" + (e && e.message || e)); }
    await patchSettings((s) => ({ sentinels: Object.assign({}, s.sentinels, { [cx.character.id]: next }) }));
  }

  async function orchestrate(cx) {
    if (cx._planLock && !cx.busy && cx.day) { await log(cx, "编排跳过：复核或合并云端裁决正在进行，稍后再点「重新编排」"); return; }
    if (cx.busy || cx._planLock || !cx.day) return;
    if (!await claimOwner(cx)) { toast("今天由「" + ownerLabel(cx) + "」负责，要改用这台就去诊断页「今天谁在管」"); render(); return; }
    cx.busy = true; cx._planLock = true; render();
    try {
      const kept = keptImpromptu(cx);
      const keptTimes = {}, keptIds = {};
      kept.forEach((k) => { keptTimes[k.time] = 1; if (k.wakeId) keptIds[k.wakeId] = 1; });
      // 随用随判：早上不排念头，也就不调模型。只把哨兵和空计划寄上去，白天云端随时起。
      if (+S.settings.impulseMode === 1 && !cloudRecheckOn()) await log(cx, "随用随判要开着云端复核才有人起念，这次按「早上定完」排");
      if (liveMode()) {
        await cancelTodayWakes(cx, keptIds);
        await armSentinel(cx);
        const liveItems = kept.slice().sort((a, b) => a.fireAt - b.fireAt);
        cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id,
          { date: todayStr(), characterId: cx.character.id, items: liveItems, chatUsed: 0, plannedAt: Date.now(), recheckAt: 0, selfUsed: 0, postedIds: [], outbox: [] });
        cx.archive = null;
        await uploadPlanCloud(cx, true);
        uploadGenKitCloud(cx, true).catch(() => { /* 已在函数内记日志 */ });
        await log(cx, "随用随判：早上不排念头（没调模型）"
          + (liveItems.length ? "，保留了 " + liveItems.length + " 个临时起念" : "") + "；白天由云端每次醒来现想");
        toast("今天交给TA随时起念");
        cx.busy = false; cx._planLock = false; render(); return;
      }
      const chat = await readRecentChat(cx, 60);
      chat.sort((a, b) => a.t - b.t);
      const streak0 = unansweredStreak(chat);
      const lines = chatExcerpt(chat, S.settings.judgeLines);
      if (lines.length) await log(cx, "已读入最近 " + lines.length + " 句聊天作为判断上下文" + (streak0 ? "（当前连续 " + streak0 + " 轮未回）" : ""));
      const outlook = dayOutlook(cx);
      if (!outlook.length) {
        cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id,
          { date: todayStr(), characterId: cx.character.id, items: (cx.plan && cx.plan.items) || [] });
        toast("今天剩下的时间没有合适的时刻了");
        await log(cx, "编排：今天剩下的时间全在免打扰或睡眠里");
        cx.busy = false; cx._planLock = false; render(); return;
      }
      const parsed = await generateJson(cx, {
        characterId: cx.character.id,
        appTags: ["companion", "impulse"],
        instruction: buildImpulseInstruction(cx.day, outlook, fmtHM(Date.now()), lines, S.settings, biasText(), S.settings.threadsOn ? threadLines(cx) : []),
      });
      const raw = Array.isArray(parsed.impulses) ? parsed.impulses : [];
      await log(cx, "TA提了 " + raw.length + " 个念头：" + (raw.map((x) => normHM(x && x.time) + "·" + String((x && x.about) || "")).join("，") || "（一个都没有）"));
      await cancelTodayWakes(cx, keptIds);
      await armSentinel(cx);

      // 留下来的临时起念一样占今天的额度和最小间隔，否则重排会在它旁边再排一条。
      const items = kept.slice();
      const armedAt = kept.filter((k) => k.act).map((k) => k.fireAt);
      let armedCount = armedAt.length;
      const prevArmed = (t) => armedAt.filter((x) => x < t).sort((a, b) => b - a)[0] || 0;
      // 模型自己挑的时刻说了不算：免打扰、睡眠窗、时刻去重、最小间隔、额度，这五道照样硬拦
      const nowMs0 = Date.now(), gapMs = (S.settings.minGapMin || 0) * 60000;
      const taken = Object.assign({}, keptTimes);
      for (const x of raw.slice(0, S.settings.quota + 3)) {
        const hm = normHM(x && x.time), ms = hm ? timeToMs(hm) : null;
        if (!ms || ms < nowMs0 + 3 * 60000) { await log(cx, "念头丢弃：时刻不合法或已过点（" + String((x && x.time) || "") + "）"); continue; }
        if (inQuiet(hm) || asleepAt(cx.day, hm)) { await log(cx, "念头丢弃：" + hm + " 落在免打扰或睡着的时段"); continue; }
        if (taken[hm]) { await log(cx, "念头丢弃：" + hm + " 已经有一个了"); continue; }
        taken[hm] = 1;
        // until 是这个念头的保质期，改约只能在它之前挪；模型没给或给反了就按 90 分钟，最长不超过 6 小时
        const uhm = normHM(x.until), ums = uhm ? timeToMs(uhm) : null;
        const about = String((x && x.about) || "想起用户").slice(0, 12);
        const item = {
          time: hm, fireAt: ms, until: ums && ums > ms ? Math.min(ums, ms + 6 * 3600000) : ms + 90 * 60000,
          source: about, act: true,
          why: String(x.why || ""), intent: String(x.intent || ""), delivery: "", reason: "", wakeId: "",
          sem: String(x.sem || ""), topic: String(x.topic || ""),
          score: calcScore(ms, armedCount, streak0, prevArmed(ms)),
        };
        if (armedCount >= S.settings.quota) { item.act = false; item.why = "超出今日额度"; }
        else if (gapMs && armedAt.some((t) => Math.abs(ms - t) < gapMs)) { item.act = false; item.why = "离上一个起念太近"; }
        if (item.act) {
          try {
            const res = await AiPhone.push.wake({
              characterId: cx.character.id, fireAt: ms,
              intent: item.intent || about, source: "tool",
              cooldownRounds: S.settings.maxUnanswered,
            });
            item.wakeId = res.id; item.delivery = res.armed ? "push" : "local"; item.reason = res.reason || "";
            armedCount++; armedAt.push(ms);
            await log(cx, hm + " 起念 ✓ " + (res.armed ? "已预约离线推送" : "仅本地（" + (res.reason || "未知") + "）") + "：" + item.intent);
          } catch (e) {
            item.act = false; item.why = "预约失败：" + (e && e.message || e);
            await log(cx, hm + " 预约失败：" + (e && e.message || e));
          }
        } else {
          await log(cx, hm + " 未起念：" + item.why);
        }
        item.hist = [{ at: Date.now(), kind: item.act ? "plan" : "skip", note: item.act ? item.intent : (item.why || "TA这会儿不想") }];
        items.push(item);
      }
      items.sort((a, b) => a.fireAt - b.fireAt);
      cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id,
        { date: todayStr(), characterId: cx.character.id, items, chatUsed: lines.length, plannedAt: Date.now(), recheckAt: 0, selfUsed: 0, postedIds: [], outbox: [] });
      cx.archive = null; // 记录页缓存失效
      await uploadPlanCloud(cx, true);
      // 哨兵刚换了一条，明天的原料里记的还是旧 id，不重寄云端明天就没模板可借
      uploadGenKitCloud(cx, true).catch(() => { /* 已在函数内记日志 */ });
      if (kept.length) await log(cx, "重排保留了 " + kept.length + " 个临时起念（重排只重排日程时刻）");
      toast(armedCount ? "TA今天有 " + armedCount + " 个想起你的时刻" : "TA今天想安静地过");
    } catch (e) {
      toast("编排失败：" + (e && e.message || e));
      await log(cx, "编排失败：" + (e && e.message || e));
    }
    cx.busy = false; cx._planLock = false; render();
  }
