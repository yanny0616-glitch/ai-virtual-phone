  /* ================= 云连接（个人云后端） ================= */
  function cloudCfg() {
    const u = (S.settings && S.settings.cloudUrl || "").trim().replace(/\/+$/, "");
    const k = (S.settings && S.settings.cloudKey || "").trim();
    return /^https:\/\//.test(u) && k ? { url: u, key: k } : null;
  }
  async function cloudFetch(action, init, params) {
    const c = cloudCfg();
    if (!c) throw new Error("未配置云连接");
    const q = new URLSearchParams(Object.assign({ action: action }, params || {}));
    const headers = { "x-ai-phone-service-key": c.key };
    if (init && init.body) headers["Content-Type"] = "application/json";
    const r = await fetch(c.url + "/functions/v1/ai-phone-push?" + q.toString(),
      Object.assign({ cache: "no-store" }, init || {}, { headers: headers }));
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.ok !== true) {
      const err = new Error((data && data.error) || ("云函数返回 HTTP " + r.status));
      err.data = data; // 409 taken 之类带结构的拒绝，调用方要看
      throw err;
    }
    return data;
  }
  // 回执查询和计划同步是短请求，避免断网时按钮一直停在处理中。
  async function cloudFetchBounded(action, init, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await cloudFetch(action, Object.assign({}, init, { signal: controller.signal }), params);
    } catch (e) {
      if (controller.signal.aborted) throw new Error("云端请求超时（15 秒），请检查网络后重试");
      throw e;
    } finally { clearTimeout(timer); }
  }
  /* ---- 设备锁：电脑和手机同时开着挂念时，一天里只有一台负责编排、预约和云端 ----
     两台各自编排，服务端就挂出两套 push_jobs（预约 id 带本机随机后缀，登记簿也各存各的），
     谁也撤不掉谁的，到点发两遍、扣两份额度；云端裁决还只能被先打开的那台取走一次。
     锁记在当天云端计划行的 context.owner 里，粒度就是那一行（角色 + 日期），零点自然释放。
     没接云端就不上锁：预约只在本机挂着，不存在两台互相看不见的问题。 */
  function myDev() { return (S.settings && S.settings.deviceId) || ""; }
  function myDevName() { return (S.settings && S.settings.deviceName) || "本机"; }
  function owns(cx) {
    if (!cloudCfg()) return true;
    const o = cx && cx.owner;
    return !o || !o.id || o.id === myDev();
  }
  function ownerLabel(cx) { return (cx && cx.owner && cx.owner.name) || "另一台设备"; }
  // 从云端计划行读锁。GET 不调模型，编排/生成前都刷一次。
  async function readOwner(cx) {
    if (!cloudCfg() || !cx.character) return null;
    try {
      const r = await cloudFetch("recheck-plan", { method: "GET" }, { characterId: cx.character.id, planDate: todayStr() });
      const c = (r && r.plan && r.plan.context) || {};
      cx.owner = c.owner ? { id: String(c.owner), name: String(c.ownerName || ""), seq: +c.ownerSeq || 0 } : null;
    } catch (e) { /* 读不到就按没锁算，别把离线的这台也锁死 */ }
    return cx.owner;
  }
  function lockCloud(cx, force) {
    return cloudFetch("recheck-plan", { method: "POST", body: JSON.stringify({
      characterId: cx.character.id, planDate: todayStr(), ownerOnly: true, force: !!force,
      owner: myDev(), ownerName: myDevName(),
    }) });
  }
  // 拿锁：没人占就写上自己；已经是别人的返回 false，调用方必须停手。
  // 当天还没有计划行时网关只回不写（空行会被 cron 派出去白跑一轮），
  // 真正的锁跟着第一次 uploadPlanCloud / uploadGenKitCloud 的 context.owner 落地。
  async function claimOwner(cx) {
    if (!cloudCfg()) return true;
    await readOwner(cx);
    if (!owns(cx)) return false;
    if (!cx.owner || cx.owner.id !== myDev()) {
      // 网关按「没人占 / 还是我」条件写锁，两台同时来只有一台写得进；写不进的以网关回的持有者为准
      let r = null;
      try { r = await lockCloud(cx); } catch (e) { /* 网络不通就按没锁算，别把离线的这台也锁死 */ }
      if (r && r.stored === false && r.taken && r.owner) {
        cx.owner = { id: String(r.owner), name: String(r.ownerName || ""), seq: +r.ownerSeq || 0 };
        return false;
      }
      cx.owner = { id: myDev(), name: myDevName(), seq: (r && +r.ownerSeq) || 0 };
    }
    return true;
  }
  // 上传被网关按设备锁拒了（409 taken）：记下新持有者，本机停手
  async function onTaken(cx, e, what) {
    const d = e && e.data;
    if (!d || !d.taken) return false;
    cx.owner = { id: String(d.owner || ""), name: String(d.ownerName || ""), seq: +d.ownerSeq || 0 };
    S._diagCache = {};
    await log(cx, what + "：今天已由「" + ownerLabel(cx) + "」接管，本机这份没上传");
    render();
    return true;
  }
  // 只读的那台要接手：先撤掉原来那台挂在服务端的预约（含 48 小时哨兵），再把锁抢过来。
  // 撤预约只认 id 前缀、不查本机登记簿，所以手机能撤掉电脑挂的那些。
  async function takeOver(cx) {
    if (cx.busy || cx._planLock) return;
    const from = ownerLabel(cx);
    cx.busy = true; render();
    try {
      let sw = "";
      try {
        const r = await cloudFetch("recheck-plan", { method: "GET" }, { characterId: cx.character.id, planDate: todayStr() });
        sw = String((r && r.plan && r.plan.context && r.plan.context.sentinelWakeId) || "");
      } catch (e) { /* 读不到哨兵就算了：那条 48 小时后只会问候一句 */ }
      await cancelTodayWakes(cx);
      if (sw) { try { await AiPhone.push.cancelWake(sw); } catch (e) { /* 已触发的取消失败可忽略 */ } }
      const lk = await lockCloud(cx, true);
      cx.owner = { id: myDev(), name: myDevName(), seq: (lk && +lk.ownerSeq) || 0 };
      S._diagCache = {};
      await log(cx, "接管：今天改由「" + myDevName() + "」负责，已撤掉「" + from + "」挂的预约");
      cx.busy = false;
      toast("今天改由这台负责");
      if (!await adoptCloudDay(cx) && cx.day) await orchestrate(cx);
      render();
    } catch (e) {
      cx.busy = false; render();
      await log(cx, "接管失败：" + (e && e.message || e));
      toast("接管失败：" + (e && e.message || e));
    }
  }
