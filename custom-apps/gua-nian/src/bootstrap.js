  /* ================= 启动 ================= */
  async function init() {
    // 攒着的日志得在页面被收起前落盘，否则关掉小手机就丢了
    document.addEventListener("visibilitychange", () => { if (document.hidden) flushLogs(); });
    window.addEventListener("pagehide", () => { flushLogs(); });
    $("#btn-settings").onclick = openSheet;
    $("#sheet-mask").onclick = () => { closeSheet(); closeDetail(); };
    $("#sheet-close").onclick = closeSheet;
    $("#dsheet-close").onclick = closeDetail;
    $("#dsheet-body").addEventListener("click", (e) => {
      const g = e.target && e.target.closest && e.target.closest("#sd-goto");
      if (g) openSchedDetail(+g.dataset.si);
    });
    $("#btn-save-settings").onclick = () => { saveSettings().catch((e) => toast("保存失败：" + (e && e.message || e))); };
    document.querySelectorAll("#tabs .tab").forEach((b) => {
      b.onclick = () => switchTab(b.dataset.tab);
    });

    try {
      const [launch, chars] = await Promise.all([
        AiPhone.app.getLaunchContext().catch(() => null),
        AiPhone.characters.list(),
      ]);
      S.characters = chars || [];
      await loadSettings();
      // 挂念的人：设置里选的几位，加上从谁的聊天里打开的那位
      let ids = (S.settings.characterIds || []).filter((id) => S.characters.some((c) => c.id === id));
      const launchId = launch && launch.characterId && S.characters.some((c) => c.id === launch.characterId) ? launch.characterId : "";
      if (launchId && !ids.includes(launchId)) ids.push(launchId);
      if (!ids.length && S.characters[0]) ids = [S.characters[0].id];
      S.cur = launchId || (ids.includes(S.settings.characterId) ? S.settings.characterId : ids[0] || "");
      if (ids.join() !== (S.settings.characterIds || []).join() || S.settings.characterId !== S.cur) {
        S.settings = await AiPhone.db.update("settings", S.settings.id, { characterIds: ids, characterId: S.cur });
      }
      for (const id of ids) S.byId[id] = ctxOf(S.characters.find((c) => c.id === id));
      S.order = ids;
      try {
        const rows = await AiPhone.db.list("logs", { limit: 5 });
        S.logs = (rows && rows[0]) || null;
      } catch (e) { /* 无日志可读 */ }
      for (const cx of allCx()) { await loadDayAndPlan(cx); await settleFired(cx).catch(() => { /* 已在函数内记日志 */ }); }
      render();
      for (const cx of allCx()) {
        // 先认锁：另一台在管的话，下面的接管、寄原料、复核、取裁决全都不该做
        cx._ownAt = Date.now();
        await readOwner(cx);
        await syncChatContext(cx, true);
        await adoptCloudDay(cx);
        uploadGenKitCloud(cx).catch(() => { /* 已在函数内记日志 */ });
      }
      render();
      syncUsageCloud(true).catch(() => { /* 已在函数内记日志 */ });
      // 先收浏览器关着这段时间云端替TA做的决定，再按最新聊天做本地复核
      // 打开小手机本身就是一次复核时机：按你们最新的聊天，让TA重新想想今天。
      // 两步必须串行：都会重写 plan，并行的话后写的会盖掉前一个的结果。几个人也串着来，模型调用不并发。
      for (const cx of allCx()) cx._rcTry = Date.now();
      setTimeout(async () => {
        for (const cx of allCx()) {
          try {
            const n = await pullCloudDecisions(cx);
            if (n) { render(); toast((S.order.length > 1 ? cx.character.name : "TA") + "在你没开着的时候改了 " + n + " 处心意"); }
          } catch (e) { /* 已在函数内记日志 */ }
          try { await recheck(cx, "打开"); } catch (e) { /* 已在函数内记日志 */ }
        }
      }, 1500);
      // 每分钟刷新「正在做」与过去/未来分界；在页期间按设置的间隔定时复核。每个人轮着来。
      for (const cx of allCx()) maybeAutoGen(cx).catch(() => { /* 已在函数内记日志 */ });
      setInterval(async () => {
        if (S.tab === "today") { S._still = true; render(); S._still = false; }
        for (const cx of allCx()) {
          if (cx.busy) continue;
          if (cx.day && cx.day.date !== todayStr()) { // 跨过零点：昨天的 day/plan 换成今天的（多半是空的）
            await loadDayAndPlan(cx).then(() => { render(); return syncChatContext(cx, true); }).catch(() => { /* 已在函数内记日志 */ });
            continue;
          }
          // 另一台点了「改用这台」的话，这台得自己发现锁没了（10 分钟一次，GET 不花额度）
          if (Date.now() - (cx._ownAt || 0) > 10 * 60000) {
            cx._ownAt = Date.now();
            const was = owns(cx);
            await readOwner(cx).catch(() => { /* 读不到按没锁算 */ });
            if (was !== owns(cx)) render();
          }
          await maybeAutoGen(cx).catch(() => { /* 已在函数内记日志 */ });
          await settleFired(cx).catch(() => { /* 已在函数内记日志 */ });
          await syncChatContext(cx).catch(() => { /* 已在函数内记日志 */ });
          if (S.settings && S.settings.recheckMin > 0 && Date.now() - (cx._rcTry || 0) >= S.settings.recheckMin * 60000) {
            cx._rcTry = Date.now();
            await recheck(cx, "定时").catch(() => { /* 已在函数内记日志 */ });
          }
        }
      }, 60000);
    } catch (e) {
      $("#view").innerHTML = '<div class="card empty"><div class="art">🌫️</div><p>初始化失败：' + esc(e && e.message || e) + "</p></div>";
    }
  }
  init();
