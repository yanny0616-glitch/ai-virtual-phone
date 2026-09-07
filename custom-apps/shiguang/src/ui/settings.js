  /* ================= 回忆规则与整理设置 ================= */
  function renderSettings() {
    const form = $("settings");
    for (const [key, value] of Object.entries(S.settings || {})) {
      const el = form.elements.namedItem(key);
      if (!el || typeof el.type !== "string") continue;
      if (el.type === "checkbox") el.checked = !!value; else el.value = value;
    }
  }
  function renderProgress() {
    const p = S.progress[S.characterId];
    const who = character(S.characterId);
    $("progress").innerHTML = who ? `${esc(who.name)}：${p && p.watermarkAt ? "已整理到 " + esc(fmtTime(p.watermarkAt)) : "还没开始"}${p && p.lastRunAt ? "，上次整理 " + esc(fmtTime(p.lastRunAt)) : ""}${p && p.lastError ? `<br><span class="sg-warn">上次失败：${esc(p.lastError)}</span>` : ""}` : "";
    $("restart").disabled = !who;
  }
  function bindSettings() {
    $("settings").onsubmit = async event => {
      event.preventDefault();
      const form = $("settings"), button = form.querySelector(".sg-submit"); if (button.disabled) return;
      button.disabled = true; $("settings-notice").textContent = "";
      try {
        const roundInterval = Number(form.elements.roundInterval.value), tokenBudget = Number(form.elements.tokenBudget.value);
        if (!Number.isInteger(roundInterval) || roundInterval < 5 || roundInterval > 80) throw new Error("整理间隔须在 5–80 之间");
        if (!Number.isInteger(tokenBudget) || tokenBudget < 200 || tokenBudget > 4000) throw new Error("回忆预算须在 200–4000 之间");
        await patchSettings({ enabled: form.elements.enabled.checked, autoEnabled: form.elements.autoEnabled.checked, roundInterval, tokenBudget });
        contextCache.clear();
        render(); $("settings-notice").textContent = "已保存，所有角色使用这组拾光设置。";
        if (S.characterId) syncContext(S.characterId).catch(() => {});
      } catch (err) { $("settings-notice").textContent = errText(err); }
      finally { button.disabled = false; }
    };
    $("restart").onclick = async () => {
      if (!S.characterId || S.busy) return;
      const who = character(S.characterId);
      if (!window.confirm(`把「${who.name}」的整理进度清零？之后点「整理新消息」会从最早的聊天开始，一批一批整理，已有记录按标题合并。`)) return;
      try { await saveProgress(S.characterId, { watermarkAt: "", watermarkId: "", lastError: "", retryAfter: "" }); renderProgress(); $("settings-notice").textContent = "已清零，回到记忆本点「整理新消息」开始。"; }
      catch (err) { $("settings-notice").textContent = errText(err); }
    };
  }
