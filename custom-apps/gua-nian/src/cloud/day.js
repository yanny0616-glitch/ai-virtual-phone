  /* ---- 云端生成TA的一天：浏览器关着时由 push-recheck 到点生成 + 编排，App 打开时接管 ---- */
  function cloudGenOn() {
    return !!(cloudCfg() && S.settings && S.settings.autoGen && S.settings.cloudGen);
  }
  // 云端没有角色卡、记忆和预设：把和本地 ai.generate 同源的两份请求冻在服务端当模板，
  // 云函数只换掉最后一条用户消息里的占位符。模板 7 天作废，所以每次打开都续一次（6 小时内不重复）。
  async function freezeGenTemplates(cx, force) {
    const t = (S.settings.genTpls || {})[cx.character.id];
    if (!force && t && t.daily && t.impulse && Date.now() - (t.at || 0) < 6 * 3600000) return t;
    const out = { daily: "", impulse: "", at: Date.now() };
    for (const k of ["daily", "impulse"]) {
      try {
        const r = await AiPhone.push.freeze({ characterId: cx.character.id, appTags: ["companion", k], key: k });
        if (r && r.armed) out[k] = r.id;
        else await log(cx, "云端生成：" + k + " 模板没冻上（" + ((r && r.reason) || "服务端未确认") + "），云端今天生成不了");
      } catch (e) { await log(cx, "云端生成：冻结 " + k + " 模板失败——" + (e && e.message || e)); }
    }
    await patchSettings((s) => ({ genTpls: Object.assign({}, s.genTpls, { [cx.character.id]: out }) }));
    if (out.daily && out.impulse) await log(cx, "云端生成：两份模板已冻到云端（7 天内有效，6 小时后再续）");
    return out;
  }
  async function readCalendarOn(cx, date) {
    try {
      const r = await AiPhone.calendar.read({ ownerType: "character", ownerId: cx.character.id, date: date });
      const items = (r && r.plan && r.plan.items) || [];
      return items.filter((it) => it.date === date)
        .map((it) => { const l = lockOfTitle(it.title); return Object.assign({}, it, { title: l.title, lock: l.lock }); })
        .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    } catch (e) { return []; }
  }
  // 把「生成明天」需要的一切算好寄上去：指令文本由本地同一个 buildDayInstruction 生成，
  // 云端不再自己拼提示词，所以生成内容和本地一字不差。今天还没生成且没到点的话，今天也寄一份。
  async function uploadGenKitCloud(cx, force) {
    if (!cloudGenOn() || !cx.character || !S.settings || !owns(cx)) return;
    if (!force && Date.now() - (cx._kitAt || 0) < 20 * 60000) return;
    if (S.settings.userSleepOn) await requireRecheckFeatures(["user-sleep-feedback-v1"]);
    cx._kitAt = Date.now();
    const tpl = await freezeGenTemplates(cx, false);
    if (!tpl.daily || !tpl.impulse) return;
    const at = S.settings.autoGenAt || SET_DEF.autoGenAt;
    const tm = new Date(); tm.setDate(tm.getDate() + 1);
    const dates = [dateStrOf(tm)];
    if (!cx.day && fmtHM(Date.now()) < at) dates.unshift(todayStr());
    for (const date of dates) {
      try {
        const existing = await readCalendarOn(cx, date);
        const cal = calendarReality(dateOf(date));
        const past = await recentDaysBrief(cx, 7, date);
        const ctx = cloudContext(cx);
        ctx.day = null; // 还没生成的那天不该拿今天的生活面去自发起念
        ctx.genKit = {
          date: date, instruction: buildDayInstruction(cal, at, past, existing, S.settings.threadsOn ? threadLines(cx, dateOf(date).getTime() + 8 * 3600000) : []),
          existing: existing.map((it) => ({ id: it.id, startTime: it.startTime, endTime: it.endTime || "", title: it.title, location: it.location || "", lock: it.lock || "" })),
          autoGenAt: at, tz: -new Date().getTimezoneOffset(),
          tplDaily: tpl.daily, tplImpulse: tpl.impulse,
          anchorMorning: !!S.settings.anchorMorning, anchorSleep: !!S.settings.anchorSleep, moodGate: !!S.settings.moodGate,
          kitAt: Date.now(),
        };
        const r = await cloudFetchBounded("recheck-plan", {
          method: "POST",
          body: JSON.stringify({ characterId: cx.character.id, planDate: date, sessionId: "", resetDecisions: true, context: ctx, items: [] }),
        });
        if (ctx.userSleepOn && !acceptsUserSleep(r, ctx)) {
          cx._kitAt = 0;
          await log(cx, "云端生成：" + date + " 未确认保存睡眠设置，请更新网关和 push-recheck 后重试");
        } else if (r && Array.isArray(r.dropped) && r.dropped.length) {
          await log(cx, "云端生成：" + date + " 的 " + r.dropped.join("、") + " 太大没存下，那天云端生成不了");
        } else {
          await log(cx, "云端生成：" + date + " 的原料已寄到云端，到 " + at + " 由云端生成");
        }
      } catch (e) {
        if (await onTaken(cx, e, "云端生成")) return;
        await log(cx, "云端生成：" + date + " 的原料上传失败——" + (e && e.message || e));
      }
    }
  }
  // 云端生成好了今天：把它当成自己生成的接过来——落库、写回系统日程、接管预约，再走正常的复核流程。
  async function adoptCloudDay(cx) {
    if (!cloudGenOn() || !cx.character || cx.day || cx.busy || cx._planLock) return false;
    if (!owns(cx)) return false; // 接管云端生成会接手那批预约，只有管事那台能做
    let data;
    try { data = await cloudFetch("recheck-plan", { method: "GET" }, { characterId: cx.character.id, planDate: todayStr() }); }
    catch (e) { return false; }
    const p = data && data.plan;
    const ctx = p && p.plan_date === todayStr() && p.context;
    if (!ctx || ctx.generatedBy !== "cloud" || !ctx.dayFull || !Array.isArray(ctx.dayFull.schedule)) return false;
    cx.busy = true; cx._planLock = true; render();
    try {
      const genAt = +ctx.genAt || Date.now();
      cx.day = await upsert("days", (x) => x.date === todayStr() && x.characterId === cx.character.id,
        Object.assign({ date: todayStr(), characterId: cx.character.id, by: "cloud" }, ctx.dayFull));
      const existing = await readTodayCalendar(cx);
      const wrote = await syncCalendar(cx, existing);
      const items = (Array.isArray(p.items) ? p.items : []).map((w) => ({
        time: w.time, fireAt: +w.fireAt || 0, source: w.source || "", act: !!w.act,
        why: w.why || "", intent: w.intent || "", wakeId: w.wakeId || "",
        delivery: w.act && w.wakeId ? "push" : "", reason: w.act && !w.wakeId ? (w.reason || "云端没有可借的聊天模板") : "",
        sem: w.sem || "", topic: w.topic || "", score: w.score || calcScore(+w.fireAt || 0, 0, 0, 0), kind: w.kind || "plan",
        hist: Array.isArray(w.hist) && w.hist.length ? w.hist : [{ at: genAt, kind: w.act ? "plan" : "skip", note: w.act ? (w.intent || "") : (w.why || "TA这会儿不想"), by: "cloud" }],
      })).sort((a, b) => a.fireAt - b.fireAt);
      cx.plan = await upsert("plans", (x) => x.date === todayStr() && x.characterId === cx.character.id,
        { date: todayStr(), characterId: cx.character.id, items: items, chatUsed: +ctx.genChatUsed || 0,
          plannedAt: genAt, recheckAt: 0, selfUsed: +ctx.selfUsed || 0, cloudAckAt: genAt, by: "cloud" });
      cx.archive = null;
      for (const line of (Array.isArray(ctx.genLog) ? ctx.genLog : []).slice(0, 30)) await log(cx, "云端生成：" + line);
      await log(cx, "接管云端生成的今天：" + cx.day.schedule.length + " 条日程，写回系统日程 " + wrote + " 条，" + items.filter((w) => w.act).length + " 个想起你的时刻");
      cx.busy = false; cx._planLock = false;
      await syncChatContext(cx, true);
      uploadGenKitCloud(cx, true).catch(() => { /* 已在函数内记日志 */ });
      toast("TA今天的一天已在云端生成");
      render();
      return true;
    } catch (e) {
      cx.busy = false; cx._planLock = false;
      await log(cx, "接管云端生成失败：" + (e && e.message || e));
      render();
      return false;
    }
  }
