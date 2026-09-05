  function renderCloudSync() {
    const box = $("#cloud-sync");
    if (!box) return;
    const rows = cloudCfg() ? allCx().map((cx) => ({ cx, state: planSyncState(cx) })).filter((x) => x.state) : [];
    const genRows = cloudCfg() ? allCx().map(cx => ({ cx, state: generationStopState(cx) })).filter(x => x.state && x.state.status !== "synced") : [];
    box.hidden = !rows.length && !genRows.length;
    box.innerHTML = rows.map(({ cx, state }) => {
      const busy = cx._syncRetrying || state.status === "syncing" && (!!cx._uploadQ || cx._controlActive);
      const ok = state.status === "synced";
      const title = ok ? (state.operation === "control" ? "云端控制已确认" : "计划已同步云端") : busy ? "正在同步计划…" : "云端同步未完成";
      const message = state.status === "syncing" && !busy ? "上次同步未确认完成，请重试。" : state.message;
      return '<div class="card"><div class="sec-head"><span class="t">' + esc(cx.character.name) +
        '</span><span class="badge ' + (ok ? "ok" : "warn") + '">' + title + '</span></div>' +
        '<div class="d-why">' + esc(message) + (ok ? ' · ' + esc(fmtHM(state.at)) : ' 本地数据已保留。') + '</div>' +
        (!ok && state.status !== "readonly" ? '<button class="tgl" data-sync-retry="' + esc(cx.character.id) + '"' +
          (busy || cx.busy || cx._planLock ? ' disabled' : '') + '>重试同步</button>' : '') + '</div>';
    }).join("");
    box.innerHTML += genRows.map(({ cx, state }) => '<div class="card"><div class="d-why">' + esc(cx.character.name) + ' · ' + esc(state.message) + '</div><button class="tgl" data-gen-retry="' + esc(cx.character.id) + '"' + (cx._genStopping ? ' disabled' : '') + '>重试停用自动生成</button></div>').join("");
    box.querySelectorAll("[data-gen-retry]").forEach(button => {
      button.onclick = () => stopCloudGeneration(S.byId[button.dataset.genRetry]).catch(() => toast("停用未确认，请重试"));
    });
    box.querySelectorAll("[data-sync-retry]").forEach((button) => {
      button.onclick = () => {
        const cx = S.byId[button.dataset.syncRetry];
        if (cx) retryPlanSync(cx).catch(() => toast("同步未完成，请重试"));
      };
    });
  }
