  // 发送凭据只按预约键关联，不通过聊天时间猜测。缓存仅用于展示，不回写计划或账本。
  function receiptFor(w, cx) {
    cx = cx || cur();
    if (cx._receiptSource !== (cloudCfg() || {}).url) return null;
    const cache = cx._receipts;
    return w.wakeId && cache && cache[w.wakeId] || null;
  }
  function refreshReceipts(cx, items, force) {
    const run = async () => {
      if (!cloudCfg()) return;
      const source = cloudCfg().url;
      if (cx._receiptSource !== source) { cx._receipts = {}; cx._receiptSource = source; }
      const cache = cx._receipts = cx._receipts || {};
      const keys = [...new Set(items.filter((w) => w.act && w.wakeId).map((w) => w.wakeId))]
        .filter((key) => force || !cache[key] || Date.now() - cache[key].checkedAt >= 60000);
      for (let i = 0; i < keys.length; i += 20) {
        const batch = keys.slice(i, i + 20), triggers = batch.map((key) => "timedwake:" + key);
        try {
          const r = await cloudFetchBounded("jobs", { method: "GET" }, { kind: "timed_task", triggerKeys: JSON.stringify(triggers) });
          if (!Array.isArray(r.queriedTriggerKeys) || triggers.some((key) => !r.queriedTriggerKeys.includes(key))) {
            throw new Error("个人云版本偏旧，请在设置 → 云服务部署中重新部署离线推送，再刷新回执。");
          }
          for (const key of batch) {
            const job = (r.jobs || []).find((j) => j.triggerKey === "timedwake:" + key);
            cache[key] = { checkedAt: Date.now(), job: job || null, error: job ? "" : "未查到对应预约回执，无法确认是否发送。" };
          }
        } catch (e) {
          for (const key of keys.slice(i)) {
            // 查询失败不会把上次已确认的结果抹掉，但必须提示本次未刷新成功。
            cache[key] = { checkedAt: Date.now(), job: cache[key] && cache[key].job || null, error: String(e && e.message || e).slice(0, 300) };
          }
          break; // 网络或版本异常时停止后续批次，保留手动重试。
        }
      }
    };
    const p = (cx._receiptQ || Promise.resolve()).then(run, run);
    cx._receiptQ = p.catch(() => {});
    return p;
  }
