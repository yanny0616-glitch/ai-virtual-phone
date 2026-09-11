  // 哪些角色的云端计划 / 停用生成还没落定；诊断页结论卡也靠它判「云端同步」要不要算一处
  function cloudSyncIssues() {
    if (!cloudCfg()) return { rows: [], genRows: [], unfinished: false };
    const rows = allCx().map((cx) => ({ cx, state: planSyncState(cx) })).filter((x) => x.state);
    const genRows = allCx().map(cx => ({ cx, state: generationStopState(cx) })).filter(x => x.state && x.state.status !== "synced");
    return { rows, genRows, unfinished: rows.some(x => x.state.status !== "synced") || genRows.length > 0 };
  }
  function renderCloudSync() {
    const box = $("#dg-ext-sync");
    if (!box) return;
    const wasOpen = !!box.querySelector("details[open]");
    const { rows, genRows, unfinished } = cloudSyncIssues();
    box.hidden = !rows.length && !genRows.length;
    let html = rows.map(({ cx, state }) => {
      const busy = cx._syncRetrying || state.status === "syncing" && (!!cx._uploadQ || cx._controlActive);
      const ok = state.status === "synced";
      const title = ok ? (state.operation === "control" ? "云端控制已确认" : "计划已同步云端") : busy ? "正在同步计划…" : "云端同步未完成";
      const message = state.status === "syncing" && !busy ? "上次同步未确认完成，请重试。" : state.message;
      return '<div class="diag-item"><div><b>' + esc(cx.character.name) +
        '</b> <span class="badge ' + (ok ? "ok" : "warn") + '">' + title + '</span></div>' +
        '<div class="d-why">' + esc(message) + (ok ? ' · ' + esc(fmtHM(state.at)) : ' 本地数据已保留。') + '</div>' +
        (state.status !== "readonly" ? '<button class="tgl" data-sync-retry="' + esc(cx.character.id) + '"' +
          (busy || cx.busy || cx._planLock ? ' disabled' : '') + '>' + (ok ? '重试云端任务' : '重试同步') + '</button>' : '') + '</div>';
    }).join("");
    html += genRows.map(({ cx, state }) => '<div class="diag-item"><div class="d-why">' + esc(cx.character.name) + ' · ' + esc(state.message) + '</div><button class="tgl" data-gen-retry="' + esc(cx.character.id) + '"' + (cx._genStopping ? ' disabled' : '') + '>重试停用自动生成</button></div>').join("");
    const sum = new Set(rows.concat(genRows).map(x => x.cx.character.id)).size + ' 个角色 · ' + (unfinished ? '有未完成项' : '已同步');
    box.innerHTML = dgItem("sync", "云端同步", html, sum, unfinished ? "warn" : "ok", wasOpen || unfinished);
    dgBindToggle(box);
    if (S._diagSummarize) S._diagSummarize();
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
