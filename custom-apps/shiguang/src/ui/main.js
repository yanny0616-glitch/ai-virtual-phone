  /* ================= 列表 ================= */
  function notice(value, failed = false) { const el = $("notice"); el.textContent = value; el.dataset.error = String(failed); }
  function busy(value) {
    S.busy = value;
    $("character").disabled = value || !S.characters.length;
    $("refresh").disabled = value;
    $("organize").disabled = value || !S.characterId || !(S.settings && S.settings.enabled);
    document.querySelectorAll("#cards button").forEach(button => { button.disabled = value; });
  }
  function present(entry) {
    return { ...entry, promptText: ShiguangRecall.promptText(entry), promptTokens: ShiguangRecall.promptTokens(entry), recallMode: ShiguangRecall.recallMode(entry) };
  }
  function cardHtml(entry) {
    const e = present(entry);
    const fields = [["事情的缘由", e.reason], ["那天发生了什么", e.story], ...(e.details || []).map(f => [f.label, f.value]), ["值得记住的", e.significance], ["后来发生了什么", e.followup]];
    const over = e.promptTokens > S.settings.tokenBudget;
    return `<article class="card" data-id="${esc(e.id)}"><div class="card-meta"><time>${esc(fmtTime(e.lastEventAt))}</time><span class="badge">${esc(MODES[e.recallMode])}</span></div><h3>${esc(e.title)}</h3><p class="summary">${esc(e.summary)}</p><div class="tags">${(e.categories || []).map(c => `<span class="tag">${esc(c)}</span>`).join("")}</div><div class="prompt-block"><div class="prompt-head"><span>选中后发给 AI 的内容</span><small>约 ${e.promptTokens} Token</small></div><p class="prompt-text">${esc(e.promptText)}</p>${e.recallMode === "off" ? '<p class="budget-note">这条已设为不发送。</p>' : over ? '<p class="budget-note">这条超过当前预算，会被整条跳过。可编辑摘要或调整预算。</p>' : ""}</div><details><summary>展开故事与具体信息</summary><dl class="facts">${fields.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}<dt>当前进展</dt><dd>${esc(STATUSES[e.status] || e.status)}${e.dueAt ? " · " + esc(e.dueAt) : ""}</dd><dt>回忆关键词</dt><dd>${esc((e.keywords || []).join("、") || "未设置")}</dd></dl></details><div class="actions"><button class="primary" data-action="edit">编辑与摘要</button><button class="quiet" data-action="sources">回看原消息</button><button class="danger" data-action="delete" aria-label="删除${esc(e.title)}">删除</button></div></article>`;
  }
  function render() {
    if (S.background) return;
    const query = $("search").value.trim().toLocaleLowerCase();
    const category = $("category").value, mode = $("mode-filter").value;
    const all = activeEntries(S.characterId).sort((a, b) => String(b.lastEventAt).localeCompare(String(a.lastEventAt)));
    const entries = all.filter(e => {
      const p = present(e);
      return (!category || (e.categories || []).includes(category)) && (!mode || mode === p.recallMode)
        && (!query || [e.title, e.summary, p.promptText, e.reason, e.story, e.followup, ...(e.keywords || []), ...(e.details || []).map(f => f.label + f.value)].join(" ").toLocaleLowerCase().includes(query));
    });
    $("count").textContent = `${entries.length} 条记忆${query || category || mode ? " · 已筛选" : ""}`;
    $("more").hidden = entries.length <= S.limit;
    $("cards").innerHTML = entries.slice(0, S.limit).map(cardHtml).join("")
      || `<p class="empty">${all.length ? "没有找到这段记忆，试试其他关键词或筛选。" : "这里还没有拾光。聊到设定轮数会自动整理，也可以点「整理新消息」。"}</p>`;
    renderProgress();
    busy(S.busy);
  }
  async function load() {
    if (!S.characterId) { $("cards").innerHTML = '<p class="empty">先在小手机创建一个角色，再来收藏共同经历。</p>'; return; }
    const revision = ++S.revision, cid = S.characterId;
    busy(true); notice(""); $("cards").innerHTML = '<p class="empty">正在翻开记忆本…</p>';
    try {
      await Promise.all([loadEntries(cid), loadProgress(cid)]);
      const imported = await migrateCharacter(cid);
      if (revision !== S.revision) return;
      S.limit = 20; render();
      if (imported) notice(`已接续 ${imported} 条旧拾光记录。`);
      if (!S.settings.enabled) notice("拾光已关闭：记录仍保留，暂停整理和发送。可在「回忆规则」开启。");
      syncContext(cid).catch(() => {});
    } catch (err) { notice(errText(err), true); $("cards").innerHTML = '<p class="empty">记忆未能读取，点击刷新重试。</p>'; }
    finally { if (revision === S.revision) busy(false); }
  }
  function bindList() {
    $("cards").onclick = event => {
      const button = event.target.closest("button[data-action]"); if (!button || S.busy) return;
      const entry = (S.entries[S.characterId] || []).find(e => e.id === button.closest("[data-id]").dataset.id); if (!entry) return;
      if (button.dataset.action === "edit") showEditor(entry);
      if (button.dataset.action === "sources") void showSources(entry);
      if (button.dataset.action === "delete") { S.deleting = entry; $("delete-error").textContent = ""; $("delete-dialog").showModal(); }
    };
    $("character").onchange = () => { S.characterId = $("character").value; void load(); };
    $("refresh").onclick = () => void (S.characters.length ? load() : start());
    for (const id of ["search", "category", "mode-filter"]) $(id).addEventListener(id === "search" ? "input" : "change", () => { S.limit = 20; render(); });
    $("more").onclick = () => { S.limit += 20; render(); };
    document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => {
      S.tab = button.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach(b => b.setAttribute("aria-current", b === button ? "page" : "false"));
      $("memories").hidden = S.tab !== "memories"; $("rules").hidden = S.tab !== "rules";
    });
    $("organize").onclick = async () => {
      if (S.busy) return;
      busy(true); $("organize").textContent = "正在整理…"; notice("正在调用模型，完成前请保持页面打开。");
      try {
        const result = await organize(S.characterId);
        if (!result.success) throw new Error(result.error || "整理失败，请重试");
        render(); await syncContext(S.characterId).catch(() => {});
        notice(`整理完成，保存 ${result.saved} 条。${result.hasMore ? "还有未整理的消息，可再点一次继续。" : ""}`);
      } catch (err) { notice(errText(err), true); render(); }
      finally { busy(false); $("organize").textContent = "整理新消息"; }
    };
  }
