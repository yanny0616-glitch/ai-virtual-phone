  // 编排 / 复核 / 合并云端裁决都会整份重写 plan，三者共用 _planLock：
  // 并发跑的话，后写的那个手里是 await 之前取的旧 items，会把先写的成果整份盖回去
  // ——被盖掉的新预约还挂在服务端，到点就成了任何计划里都查不到的发送。
  async function pullCloudDecisions(cx) {
    if (cx.busy || cx._planLock || !owns(cx)) return 0; // 裁决取走就没了，只有管事那台能取
    cx._planLock = true;
    try { return await pullCloudDecisionsBody(cx); } finally { cx._planLock = false; }
  }

  async function pullCloudDecisionsBody(cx, requireRead) {
    if (!cloudRecheckOn() || !cx.character || !cx.plan || !Array.isArray(cx.plan.items)) return 0;
    const date = todayStr();
    let data;
    try {
      data = await (requireRead ? cloudFetchBounded : cloudFetch)("recheck-plan", { method: "GET" }, { characterId: cx.character.id, planDate: date });
    } catch (e) { if (requireRead) throw e; return 0; }
    const p = data && data.plan;
    if (!p || p.plan_date !== date) return 0;
    if ((+p.judged_chat_at || 0) > (+cx.plan.judgedChatAt || 0) || (+p.judged_at || 0) > (+cx.plan.judgedAt || 0)) {
      cx.plan = await upsert("plans", x => x.date === date && x.characterId === cx.character.id, {
        judgedChatAt: Math.max(+p.judged_chat_at || 0, +cx.plan.judgedChatAt || 0),
        judgedAt: Math.max(+p.judged_at || 0, +cx.plan.judgedAt || 0),
      });
    }
    const decs = Array.isArray(p.decisions) ? p.decisions : [];
    // 门禁记录不带 time，下面的合并循环会跳过它；这里单独捞出来写进诊断。
    // 只在本次会话里去重（云端每次拉取后会清空 decisions，靠 at 比时间戳不可靠）。
    const g = decs.find((d) => d && d.kind === "gate");
    if (g && g.at > cx._gateNoted) { cx._gateNoted = g.at; await log(cx, "云端复核：这轮没判——" + (g.note || "")); }
    for (const d of decs) { if (d && (d.kind === "self" || d.kind === "post" || d.kind === "settle") && d.at > cx._selfNoted) { cx._selfNoted = d.at; await log(cx, "云端复核：" + (d.note || "自发起念")); } }
    // 自发起念用掉的次数由云端记在 context 里，下次上传计划要原样带回去，否则每次打开都清零
    const selfUsed = +((p.context || {}).selfUsed) || 0;
    if (selfUsed > (cx.plan.selfUsed || 0)) {
      cx.plan = await upsert("plans", (x) => x.date === date && x.characterId === cx.character.id, { selfUsed: selfUsed });
    }
    // 想念 / 余韵的骰子云端掷过一次就不再掷，键带回来存住：余韵按天跟着计划走，想念跨天跟着角色走
    const echoKey = +((p.context || {}).echoKey) || 0;
    if (echoKey > (cx.plan.echoKey || 0)) cx.plan = await upsert("plans", (x) => x.date === date && x.characterId === cx.character.id, { echoKey: echoKey });
    const missKey = +((p.context || {}).missKey) || 0;
    if (missKey > ((S.settings.missState || {})[cx.character.id] || 0)) {
      await patchSettings((x) => ({ missState: Object.assign({}, x.missState || {}, { [cx.character.id]: missKey }) }));
    }
    // 回音账：云端按 wakeId 记过一次就不再记，本机按种类取大并存住；记过账的 wakeId 跟计划走
    const fbSeen = Array.isArray((p.context || {}).fbSeen) ? p.context.fbSeen : [];
    const mergedSeen = [...new Set([...(cx.plan.fbSeen || []), ...fbSeen])].slice(-60);
    if (JSON.stringify(mergedSeen) !== JSON.stringify(cx.plan.fbSeen || [])) cx.plan = await upsert("plans", (x) => x.date === date && x.characterId === cx.character.id, { fbSeen: mergedSeen });
    const fbCloud = (p.context || {}).fb;
    if (fbCloud && typeof fbCloud === "object") {
      const mine = (S.settings.fbState || {})[cx.character.id] || {};
      let grew = false;
      const next = Object.assign({}, mine);
      for (const k of Object.keys(fbCloud)) {
        const c = fbCloud[k], m = mine[k] || [0, 0];
        if (!Array.isArray(c) || !((+c[0] || 0) > (+m[0] || 0))) continue;
        next[k] = [+c[0] || 0, +c[1] || 0]; grew = true;
      }
      if (grew) await patchSettings((x) => ({ fbState: Object.assign({}, x.fbState || {}, { [cx.character.id]: next }) }));
    }
    await consumeOutbox(cx, p.context || {});
    // 云端在账本上了结、新记、标过「已提醒」的，按 id 并回来，at 大的赢
    const ct = Array.isArray((p.context || {}).threads) ? p.context.threads : [];
    if (ct.length && S.settings.threadsOn) {
      const list = (cx.threads || []).slice(); let ch = 0;
      for (const c of ct) {
        if (!c || !c.id || !c.text) continue;
        const mine = list.find((x) => x.id === c.id);
        if (!mine) { list.push({ id: String(c.id), kind: THREAD_KIND[c.kind] ? c.kind : "topic", text: String(c.text).slice(0, 60), due: +c.due || 0, yearly: !!c.yearly, since: +c.since || +c.at || Date.now(), at: +c.at || Date.now(), by: "cloud", done: !!c.done, nudge: String(c.nudge || ""), why: String(c.why || "").slice(0, 40) }); ch++; }
        else if ((+c.at || 0) > (+mine.at || 0)) {
          if (!mine.done && c.done) await dropThreadSlots(cx, mine.id, "这件事你说了结了");
          mine.done = !!c.done; mine.at = +c.at; mine.nudge = String(c.nudge || mine.nudge || ""); ch++;
        }
      }
      if (ch) { await saveThreads(cx, list); await log(cx, "惦记账本：并入云端改动 " + ch + " 处"); }
    }
    if (!decs.length) return 0;
    const byTime = {};
    (Array.isArray(p.items) ? p.items : []).forEach((it) => { if (it && it.time) byTime[it.time] = it; });
    const items = cx.plan.items.slice();
    // 两道去重：本地在云端之后又复核过的以本地为准；已经并过的裁决不再并第二遍
    // （回执 DELETE 有可能失败，光靠云端清空不够）
    const since = Math.max(cx.plan.recheckAt || 0, cx.plan.cloudAckAt || 0, cx.plan.plannedAt || 0);
    let n = 0, maxAt = 0;
    for (const d of decs) {
      if (!d || d.by !== "cloud" || !d.time) continue;
      const ci = byTime[d.kind === "defer" ? d.to : d.time];
      if (!(d.at > since)) {
        // 以本地为准丢弃这条裁决——但云端点亮时预约是真挂上了的。只丢记录不撤预约，
        // 那条 job 就成了本地和云端计划里都查不到的孤儿，到点照发。
        if ((d.kind === "lit" || d.kind === "extra" || d.kind === "defer") && ci && ci.wakeId
            && !items.some((x) => x.wakeId === ci.wakeId)) {
          try { await AiPhone.push.cancelWake(ci.wakeId); } catch (e) { /* 已触发的取消失败可忽略 */ }
          await log(cx, "云端复核：丢弃过期裁决并撤回预约 " + d.time);
        }
        continue;
      }
      let w = items.find((x) => x.time === d.time);
      if (!w) {
        if (d.kind !== "extra" || !ci) continue;
        w = {
          time: ci.time, fireAt: ci.fireAt, source: ci.source || "临时起念", act: false, kind: ci.kind || "extra",
          why: "", intent: "", delivery: "", reason: "", wakeId: "",
          sem: ci.sem || "", topic: ci.topic || "", from: ci.from || "", hist: [],
          score: calcScore(ci.fireAt, items.filter((x) => x.act).length, 0, 0),
        };
        items.push(w);
      }
      let markAdj = true;
      if (d.kind === "hold") {
        // 云端把这条押后了：到点时刻往后挪，面板上继续按「待发」算
        markAdj = false;
        if (+d.until > 0) w.fireAt = +d.until;
        w.held = true;
      } else if (d.kind === "defer") {
        // 云端改约：旧预约已撤、新预约挂在 d.to 那条上；本地不跟着挪，旧 wakeId 就指着一条撤了的，新那条成孤儿
        const ni = ci;
        if (!ni) continue;
        if (w.wakeId && ni.wakeId && w.wakeId !== ni.wakeId) { try { await AiPhone.push.cancelWake(w.wakeId); } catch (e) { /* 已撤的取消失败可忽略 */ } }
        w.origFireAt = +ni.origFireAt || +w.origFireAt || w.fireAt;
        w.time = ni.time; w.fireAt = ni.fireAt; w.held = true;
        w.wakeId = ni.wakeId || ""; w.delivery = ni.wakeId ? "push" : ""; w.reason = ni.reason || "";
        if (ni.until) w.until = ni.until;
        w.why = ni.why || w.why; w.intent = ni.intent || w.intent;
      } else if (d.kind === "presend") {
        // 到点复核只是这一条的执行判据，不算「云端改过计划」，不打调整角标
        markAdj = false;
        w.presend = Object.assign({ at: d.at, blocked: !!d.blocked, note: d.note || "" }, d.scores || {});
        if (d.blocked) { w.delivery = ""; w.reason = d.note || "到点复核没通过"; }
      } else if (d.kind === "recheck") {
        // 云端撤了这条：本地那份预约也得跟着撤，否则浏览器一开又从本地路径发出去了
        if (w.wakeId) { try { await AiPhone.push.cancelWake(w.wakeId); } catch (e) { /* 已触发的取消失败可忽略 */ } }
        w.act = false; w.wakeId = ""; w.delivery = "";
        w.why = String(d.note || "").replace(/^取消——/, "") || w.why;
      } else if (d.kind === "lit" || d.kind === "extra") {
        w.act = true;
        w.delivery = "push"; w.reason = "";
        if (ci) {
          // 本地这条要是自己点亮过，旧预约得先撤：下面一行覆盖掉 wakeId 就再也找不到它了
          if (w.wakeId && ci.wakeId && w.wakeId !== ci.wakeId) {
            try { await AiPhone.push.cancelWake(w.wakeId); } catch (e) { /* 已触发的取消失败可忽略 */ }
          }
          w.wakeId = ci.wakeId || ""; w.fireAt = ci.fireAt || w.fireAt;
          w.intent = ci.intent || w.intent; w.why = ci.why || w.why;
          w.sem = ci.sem || w.sem; w.topic = ci.topic || w.topic;
        }
      } else continue;
      if (markAdj) w.adj = "cloud";
      (w.hist = w.hist || []).push({ at: d.at, kind: d.kind, note: d.note || "", by: "cloud" });
      if (d.at > maxAt) maxAt = d.at;
      n++;
      await log(cx, "云端复核：" + d.time + " " + (d.note || d.kind));
    }
    // 先存本地，再回执：反过来的话本地写失败或中途关页，云端那份已经没了。
    // 回执只清到这批最晚的 at 为止，GET 之后新到的裁决留给下次
    const lastAt = decs.reduce((m, d) => Math.max(m, +(d && d.at) || 0), 0);
    if (n) {
      items.sort((a, b) => a.fireAt - b.fireAt);
      cx.plan = await upsert("plans", (x) => x.date === date && x.characterId === cx.character.id,
        { date: date, characterId: cx.character.id, items: items, chatUsed: cx.plan.chatUsed || 0,
          plannedAt: cx.plan.plannedAt || Date.now(), recheckAt: cx.plan.recheckAt || 0, cloudAckAt: maxAt });
      cx.archive = null;
    }
    try { await (requireRead ? cloudFetchBounded : cloudFetch)("recheck-plan", { method: "DELETE", body: JSON.stringify({ characterId: cx.character.id, planDate: date, decisionsOnly: true, before: lastAt }) }); }
    catch (e) { /* 清不掉也没关系：上面按 at > since 去重 */ }
    return n;
  }
