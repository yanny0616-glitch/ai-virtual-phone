  /* ---- 云端动态复核：把计划寄存到云上，浏览器关着时由 push-recheck 重判 ---- */
  function cloudRecheckOn() {
    return !!(cloudCfg() && S.settings && S.settings.cloudRecheck);
  }
  // 到点生成时云端要知道TA「此刻」怎么样，而预约里冻着的是编排那会儿的状态。
  // 日程 cost 和 conds 的衰减都是确定性的，把原料寄上去让 push-generate 自己按到点时刻算，
  // 不多调一次模型。tz 一并带上：云端只有绝对毫秒，日程里的 HH:MM 得靠它换算。
  function dayForCloud(cx) {
    if (!cx.day) return null;
    return {
      tz: -new Date().getTimezoneOffset(),
      mood: String(cx.day.mood || ""),
      energy: cx.day.energy != null ? +cx.day.energy : 60,
      location: String(cx.day.location || ""),
      doing: String(cx.day.doing || ""),
      wake: String(cx.day.wake || ""), bed: String(cx.day.bed || ""),
      schedule: (cx.day.schedule || []).map((it) => ({
        time: it.time, end: it.end || "", title: it.title, place: it.place || "", cost: +it.cost || 0, mood: it.mood || "", busy: !!it.busy,
        steps: Array.isArray(it.steps) ? it.steps.map((x) => ({ time: x.time, what: x.what })) : undefined,
      })),
      conds: (cx.day.conds || []).filter((c) => condWeight(c, Date.now()) > 0.08).map((c) => ({
        startAt: c.startAt, halfLifeMin: c.halfLifeMin, intensity: c.intensity,
        energyDelta: c.energyDelta, mood: c.mood, cause: c.cause,
      })),
    };
  }
  function userSleepContext() {
    let timeZone = "";
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* 旧环境用保存时的 UTC 偏移兜底 */ }
    return {
      userSleepOn: S.settings.userSleepOn ? 1 : 0,
      userSleepStart: S.settings.userSleepStart || SET_DEF.userSleepStart,
      userSleepEnd: S.settings.userSleepEnd || SET_DEF.userSleepEnd,
      userSleepTimeZone: timeZone,
      userSleepTz: -new Date().getTimezoneOffset(),
    };
  }
  // 寄给云端的判断上下文：今天的计划和明天的生成原料共用一份
  function cloudContext(cx) {
    // wakePrefix：云端点亮时要自己造预约 id，宿主只认 timed_wake_capp_<appId>_ 开头的，
    // 这里从任意一个已有 wakeId（或哨兵）上把前缀切下来给它，免得云函数写死本 APP 的 id。
    const any = (cx.plan && Array.isArray(cx.plan.items) ? cx.plan.items : []).find((w) => w.wakeId);
    const anyId = any ? any.wakeId : (sentinelOf(cx) && sentinelOf(cx).wakeId) || "";
    const wakePrefix = anyId ? String(anyId).replace(/\d+_[a-z0-9]+$/i, "") : "";
    return {
            ...userSleepContext(),
            recheckEnabled: S.settings.cloudRecheck ? 1 : 0,
            mood: String((cx.day && cx.day.mood) || ""),
            energy: String(cx.day ? energyAt(cx.day, Date.now()) : ""),
            quota: S.settings.quota,
            quietStart: S.settings.quietStart,
            quietEnd: S.settings.quietEnd,
            minGapMin: S.settings.minGapMin,
            maxUnanswered: S.settings.maxUnanswered,
            chatCandidates: S.settings.chatCandidates ? "允许临时起念" : "不允许临时起念",
            bias: biasText(),
            wakePrefix: wakePrefix,
            sentinelWakeId: (sentinelOf(cx) && sentinelOf(cx).wakeId) || "",
            gateDailyCap: S.settings.gateDailyCap,
            gateGapMin: S.settings.gateGapMin,
            gateHorizonMin: S.settings.gateHorizonMin,
            gateFreshMin: S.settings.gateFreshMin,
            gateMinMsgs: S.settings.gateMinMsgs,
            judgeLines: S.settings.judgeLines,
            selfImpulseCap: S.settings.selfImpulseCap,
            impulseMode: S.settings.impulseMode,
            selfSilenceMin: S.settings.selfSilenceMin,
            selfUsed: (cx.plan && cx.plan.selfUsed) || 0,
            missDays: S.settings.missDays,
            missKey: (S.settings.missState || {})[cx.character.id] || 0,
            echoOn: S.settings.echoOn ? 1 : 0,
            echoKey: (cx.plan && cx.plan.echoKey) || 0,
            fb: (S.settings.fbState || {})[cx.character.id] || {},
            fbSeen: (cx.plan && Array.isArray(cx.plan.fbSeen)) ? cx.plan.fbSeen : [],
            presendMax: S.settings.presendMax,
            presendTalkingMin: S.settings.presendTalkingMin,
            presendGapMin: S.settings.presendGapMin,
            busyHold: S.settings.busyHold ? 1 : 0,
            busyBufferMin: S.settings.busyBufferMin,
            busyMaxHoldMin: S.settings.busyMaxHoldMin,
            sleepMode: S.settings.sleepMode,
            sleepWakeProb: S.settings.sleepWakeProb,
            affection: cx.aff || null,
            threadDays: S.settings.threadDays,
            momentsOn: momentsReady() ? 1 : 0,
            momentsWeekly: S.settings.momentsWeekly,
            momentsGapH: S.settings.momentsGapH,
            momentsLast: moState(cx).lastAt,
            momentsWeekStart: moState(cx).weekStart,
            momentsWeekN: moState(cx).weekN,
            outbox: (cx.plan && Array.isArray(cx.plan.outbox)) ? cx.plan.outbox : [],
            threads: S.settings.threadsOn ? liveThreads(cx).slice(0, 20).map((t) => ({ id: t.id, kind: t.kind, text: t.text, due: +t.due || 0, yearly: !!t.yearly, since: +t.since || 0, at: +t.at || 0, done: false, nudge: t.nudge || "", why: t.why || "" })) : [],
            owner: myDev(), ownerName: myDevName(),
            ownerSeq: (cx.owner && cx.owner.id === myDev() && +cx.owner.seq) || 0,
            day: dayForCloud(cx),
    };
  }
  function planSyncState(cx) {
    const state = cx._planSync || ((S.settings || {}).planSync || {})[cx.character && cx.character.id];
    return state && (state.operation === "control" || cx.plan && state.date === cx.plan.date) && state.date === todayStr()
      && state.cloudUrl === (cloudCfg() || {}).url ? state : null;
  }
  async function setPlanSync(cx, state) {
    cx._planSync = state;
    renderCloudSync();
    try {
      await patchSettings((s) => ({ planSync: Object.assign({}, s.planSync, { [cx.character.id]: state }) }));
    } catch (e) { /* 状态落盘失败不覆盖真实上传结果，本次会话仍显示状态 */ }
  }
  // 串行上传，防止较早请求的失败/成功覆盖较新的同步结果。
  function uploadPlanCloud(cx, resetDecisions) {
    const run = () => uploadPlanCloudBody(cx, resetDecisions);
    const p = (cx._uploadQ || Promise.resolve()).then(run, run);
    cx._uploadQ = p.catch(() => {});
    return p;
  }
  async function uploadPlanCloudBody(cx, resetDecisions) {
    if (!cloudRecheckOn()) return { status: "disabled" };
    if (!cx.character || !cx.plan || cx.plan.date !== todayStr() || !Array.isArray(cx.plan.items)) return { status: "no-plan" };
    const previous = planSyncState(cx);
    const reset = resetDecisions === true || !!(previous && previous.resetDecisions);
    const base = { date: cx.plan.date, cloudUrl: cloudCfg().url, resetDecisions: reset };
    const finish = async (status, message, needsReset) => {
      const state = Object.assign({}, base, { status, message, at: Date.now(), resetDecisions: !!needsReset });
      await setPlanSync(cx, state);
      return state;
    };
    if (!owns(cx)) return finish("readonly", "今天由「" + ownerLabel(cx) + "」负责，本机改动未上传。", reset);
    await finish("syncing", "正在同步今天的计划…", reset);
    S._diagCache = {}; // 计划变了，诊断页那几张云端卡的缓存作废
    try {
      if (S.settings.userSleepOn) await requireRecheckFeatures(["user-sleep-feedback-v1"]);
      const expectedSleep = userSleepContext();
      const r = await cloudFetchBounded("recheck-plan", {
        method: "POST",
        body: JSON.stringify({
          characterId: cx.character.id,
          planDate: todayStr(),
          sessionId: "",
          resetDecisions: reset,
          context: cloudContext(cx),
          items: cx.plan.items.map((w) => ({
            time: w.time, fireAt: w.fireAt, source: w.source, act: !!w.act,
            intent: w.intent || "", why: w.why || "", sem: w.sem || "", topic: w.topic || "",
            wakeId: w.wakeId || "", until: +w.until || 0, origFireAt: +w.origFireAt || 0, from: w.from || "",
            kind: w.kind || "",
          })),
        }),
      });
      if (S.settings.userSleepOn && !acceptsUserSleep(r, expectedSleep)) {
        return finish("partial", "云端未确认保存睡眠设置，请更新网关和 push-recheck 后重试。", false);
      }
      if (r && Array.isArray(r.dropped) && r.dropped.length) {
        const message = "计划已上传，但部分内容过大未同步，云端功能可能不完整。";
        await log(cx, message + "（" + r.dropped.join("、") + "）");
        return finish("partial", message, false);
      }
      return finish("synced", "今天的计划已同步云端", false);
    } catch (e) {
      if (await onTaken(cx, e, "云端复核")) return finish("readonly", "今天由「" + ownerLabel(cx) + "」负责，本机改动未上传。", reset);
      const message = "计划同步失败：" + String(e && e.message || e).slice(0, 200);
      await log(cx, "云端复核：" + message + "（本地数据已保留）");
      return finish("failed", message, reset);
    }
  }

  async function requireRecheckFeatures(features) {
    let result;
    try { result = await cloudFetchBounded("recheck-capabilities", { method: "GET" }); }
    catch (e) { throw new Error("无法核对云端能力，请检查连接并重新部署网关和 push-recheck 后重试"); }
    if (!Array.isArray(result?.capabilities) || features.some(feature => !result.capabilities.includes(feature))) {
      throw new Error("云端版本尚不支持此设置，请重新部署网关和 push-recheck 后重试");
    }
  }
  function acceptsUserSleep(result, expected) {
    const got = result && result.acceptedUserSleep;
    return got && got.enabled === expected.userSleepOn && got.start === expected.userSleepStart && got.end === expected.userSleepEnd
      && got.timeZone === expected.userSleepTimeZone && got.tz === expected.userSleepTz;
  }
  async function controlCloudRecheck(cx, enabled) {
    const state = { operation: "control", enabled, date: todayStr(), cloudUrl: (cloudCfg() || {}).url || "", at: Date.now() };
    const finish = async (status, message) => { const next = { ...state, status, message }; await setPlanSync(cx, next); return next; };
    cx._controlActive = true;
    await finish("syncing", enabled ? "正在开启云端复核…" : "正在关闭云端复核…");
    try {
      const result = await cloudFetchBounded("recheck-control", { method: "POST", body: JSON.stringify({ characterId: cx.character.id, planDate: todayStr(), enabled, owner: myDev() }) });
      if (result.recheckEnabled !== enabled || !(result.capabilities || []).includes("recheck-control-v1")) throw new Error("云端未确认控制结果，请更新网关和 push-recheck");
      return finish("synced", enabled ? "云端已确认开启复核" : "云端已确认关闭复核；已有预约仍按原计划执行");
    } catch (e) { return finish("failed", (enabled ? "云端尚未确认开启：" : "云端尚未确认关闭，可能仍在运行：") + String(e && e.message || e).slice(0, 200)); }
    finally { cx._controlActive = false; renderCloudSync(); }
  }
  async function syncSavedPlan(cx, changeControl) {
    if (cx.busy || cx._planLock || cx._syncRetrying || cx._controlActive) {
      const state = { date: todayStr(), cloudUrl: (cloudCfg() || {}).url || "", operation: changeControl || !S.settings.cloudRecheck ? "control" : "plan", enabled: !!S.settings.cloudRecheck,
        status: "failed", at: Date.now(), message: "本地已保存；计划正在处理中，云端尚未同步，请稍后重试" };
      await setPlanSync(cx, state); return state;
    }
    if (!S.settings.cloudRecheck) return controlCloudRecheck(cx, false);
    if (!owns(cx)) return { status: "readonly" };
    cx._planLock = true;
    try {
      await pullCloudDecisionsBody(cx, true);
      const result = await uploadPlanCloud(cx, false);
      if (changeControl && ["synced", "no-plan"].includes(result.status)) return controlCloudRecheck(cx, true);
      if (changeControl) {
        const pending = { ...result, operation: "control", enabled: true };
        await setPlanSync(cx, pending); return pending;
      }
      return result;
    } catch (e) {
      const state = { date: todayStr(), cloudUrl: (cloudCfg() || {}).url || "", operation: changeControl ? "control" : "plan", enabled: true,
        resetDecisions: !!planSyncState(cx)?.resetDecisions,
        at: Date.now(), status: "failed", message: "同步前读取云端失败，未上传本地计划：" + String(e && e.message || e).slice(0, 200) };
      await setPlanSync(cx, state); return state;
    } finally { cx._planLock = false; }
  }
  async function retryPlanSync(cx) {
    if (cx.busy || cx._planLock || cx._syncRetrying || cx._controlActive) { toast("正在处理计划，请处理完成后重试"); return; }
    if (!S.settings.cloudRecheck || planSyncState(cx)?.operation === "control") {
      const result = await syncSavedPlan(cx, true); render(); toast(result.status === "synced" ? result.message : "云端尚未确认，请查看页面提示"); return;
    }
    if (!cloudRecheckOn() || !cx.plan || cx.plan.date !== todayStr()) { toast("请先开启云端复核并生成今天的计划"); return; }
    if (!owns(cx)) { toast("今天由「" + ownerLabel(cx) + "」负责，请在负责的设备上同步"); return; }
    cx._syncRetrying = true;
    cx._planLock = true;
    renderCloudSync();
    try {
      // 必须先成功读取并合并云端的新裁决，避免重试把云端新增预约覆盖掉。
      await pullCloudDecisionsBody(cx, true);
      const result = await uploadPlanCloud(cx, false);
      toast(result.status === "synced" ? "今天的计划已同步云端" : "云端同步未完成，请查看页面提示");
    } catch (e) {
      const previous = planSyncState(cx);
      await setPlanSync(cx, {
        date: cx.plan.date, cloudUrl: (cloudCfg() || {}).url || "", at: Date.now(), status: "failed",
        resetDecisions: !!(previous && previous.resetDecisions),
        message: "同步前读取云端失败，本地数据已保留：" + String(e && e.message || e).slice(0, 200),
      });
      toast("云端同步未完成，本地数据已保留");
    } finally {
      cx._planLock = false; cx._syncRetrying = false;
      render();
    }
  }
