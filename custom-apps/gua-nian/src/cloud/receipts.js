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

  // 手动查询实际成文记录：不需要当前计划仍保留 wakeId，也不确认领取或改写聊天。
  function renderCloudHistory() {
    const box = $("#dg-ext-history"), cx = cur();
    if (!box || !cx.character || !cloudCfg()) return;
    box.hidden = false;
    const source = cloudCfg().url;
    const state = cx._cloudHistory && cx._cloudHistory.source === source ? cx._cloudHistory : null;
    const stamp = (value) => {
      const d = new Date(value);
      return Number.isFinite(d.getTime()) ? d.toLocaleString() : "未知";
    };
    const body = (state && state.error ? '<div class="diag-item">' + esc(state.error) + '</div>' : '')
      + (state ? (state.entries || []).map(entry => {
        const wakeId = String(entry.trigger_key || '').replace(/^timedwake:/, '');
        const linked = ((cx.plan || {}).items || []).some(w => w.wakeId === wakeId);
        return '<details class="diag-item skip-fold"><summary>' + esc(stamp(entry.created_at)) + ' · ' + (linked ? '当前计划内' : '当前计划未关联') + '</summary>'
          + '<div class="d-why">任务：' + esc(entry.job_id || '未知') + '<br>触发来源：' + esc(entry.trigger_key || '未知')
          + '<br>客户端收取：' + esc(entry.consumed_at ? stamp(entry.consumed_at) : '未确认') + '</div>'
          + '<div class="d-why" style="white-space:pre-wrap;overflow-wrap:anywhere">' + esc(entry.raw_text || '') + '</div></details>';
      }).join('') + (!state.error && !state.entries.length ? '<div class="diag-item">云端现存记录中未查到消息。</div>' : '') : '<div class="diag-item">还没查过。</div>')
      + '<div class="archive-note">最近 50 条挂念成文，包含已收取、当前计划未关联的消息。云端已清理的记录无法恢复；收取时间不代表已读。</div>'
      + '<div class="dg-act"><button class="tgl" id="cloud-history-refresh"' + (cx._cloudHistoryLoading ? ' disabled' : '') + '>' + (cx._cloudHistoryLoading ? '查询中…' : '查询发送记录') + '</button></div>';
    const sum = cx._cloudHistoryLoading ? '查询中…' : state ? (state.error ? '查询失败' : (state.entries || []).length + ' 条') : esc(cx.character.name);
    box.innerHTML = dgItem("history", "云端发送记录", body, sum, state && state.error ? "bad" : "", cx._cloudHistoryOpen);
    box.querySelector('.dg-item > .dg-hd').onclick = () => { cx._cloudHistoryOpen = !box.querySelector('.dg-item').open; };
    $("#cloud-history-refresh").onclick = async () => {
      cx._cloudHistoryOpen = true; cx._cloudHistoryLoading = true; renderCloudHistory();
      let entries = state && state.entries || [], error = '';
      try {
        const chat = await AiPhone.chat.readHistory({ characterId: cx.character.id, limit: 1 });
        if (!chat || !chat.sessionId) throw new Error('未找到该角色的聊天会话');
        const r = await cloudFetchBounded('guanian-history', { method: 'GET' }, { sessionId: chat.sessionId });
        if (r.sessionId !== chat.sessionId || !Array.isArray(r.entries)) throw new Error('请更新个人云网关后再查询');
        entries = r.entries;
      } catch (e) { error = String(e && e.message || e) + '；请确认个人云已更新，重试查询。'; }
      finally {
        cx._cloudHistory = { source, entries, error }; cx._cloudHistoryLoading = false;
        if (cur() === cx && S.tab === 'back' && (cloudCfg() || {}).url === source) renderCloudHistory();
      }
    };
  }
