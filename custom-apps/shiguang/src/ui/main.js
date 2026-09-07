  /* ================= 列表 ================= */
  const filter = { categories: new Set(), mode: "" };
  const openCards = new Set();   // 重渲染后保持展开状态
  function notice(value, failed = false) { const el = $("notice"); el.textContent = value; el.dataset.error = String(failed); }
  function busy(value) {
    S.busy = value;
    $("character").disabled = value || !S.characters.length;
    $("refresh").disabled = value;
    $("organize").disabled = value || !S.characterId || !(S.settings && S.settings.enabled);
    document.querySelectorAll("#cards button, #cards input, #cards select, #cards textarea").forEach(el => { el.disabled = value; });
  }
  function present(entry) {
    return { ...entry, promptText: ShiguangRecall.promptText(entry), promptTokens: ShiguangRecall.promptTokens(entry), recallMode: ShiguangRecall.recallMode(entry) };
  }
  function cardHtml(entry) {
    const e = present(entry);
    const status = STATUSES[e.status] || e.status;
    const facts = (e.details || []).length ? `<section class="sg-block"><h3>记下的细节</h3><dl class="sg-facts">${e.details.map(f => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join("")}</dl></section>` : "";
    const next = e.status !== "remembered" || e.followup ? `<section class="sg-next"><div class="sg-status">${esc(status)}${e.dueAt ? " · " + esc(e.dueAt) : ""}</div>${e.followup ? `<p>${esc(e.followup)}</p>` : ""}</section>` : "";
    const warn = e.recallMode === "off" ? "这条已设为不发送。" : e.promptTokens > S.settings.tokenBudget ? "超过当前预算，会被整条跳过；改短摘要或调高预算。" : "";
    return `<article class="sg-record" data-id="${esc(e.id)}"><details class="sg-note" ${openCards.has(e.id) ? "open" : ""}>
<summary class="sg-summary"><div class="sg-meta"><span>${esc(fmtTime(e.lastEventAt))}</span>${e.userEdited ? "<span>已补充</span>" : ""}</div><h2 class="sg-title"><span>${esc(e.title)}</span><span class="sg-chev" aria-hidden="true"></span></h2><p class="sg-lead">${esc(e.summary)}</p><div class="sg-foot-row"><div class="sg-labels">${(e.categories || []).map(c => `<span class="sg-tag">${esc(c)}</span>`).join("")}<span class="sg-tag sg-mode">${esc(MODES[e.recallMode])}</span></div><span class="sg-fold"><span class="sg-open-label">展开</span><span class="sg-close-label">收起</span></span></div></summary>
<div class="sg-detail">
<section class="sg-prompt"><h3>发给 AI 的内容<small>约 ${e.promptTokens} Token</small></h3><p>${esc(e.promptText)}</p>${warn ? `<p class="sg-warn">${esc(warn)}</p>` : ""}</section>
${e.reason ? `<section class="sg-block"><h3>事情的缘由</h3><p>${esc(e.reason)}</p></section>` : ""}
${e.story ? `<section class="sg-block"><h3>那天发生了什么</h3><p>${esc(e.story)}</p></section>` : ""}
${facts}
${e.significance ? `<section class="sg-block"><h3>这件事里，值得记住的</h3><p>${esc(e.significance)}</p></section>` : ""}
${next}
<div class="sg-actions"><button type="button" class="sg-action" data-action="sources" aria-expanded="false">回看原消息</button><button type="button" class="sg-action" data-action="edit" aria-expanded="false">编辑与摘要</button></div>
<div class="sg-slot"></div>
<p class="sg-save-hint" data-card-notice></p>
</div></details></article>`;
  }
  function visibleEntries() {
    const query = $("search").value.trim().toLocaleLowerCase();
    const all = activeEntries(S.characterId).sort((a, b) => String(b.lastEventAt).localeCompare(String(a.lastEventAt)));
    return { all, entries: all.filter(e => {
      const p = present(e);
      return (!filter.categories.size || (e.categories || []).some(c => filter.categories.has(c))) && (!filter.mode || filter.mode === p.recallMode)
        && (!query || [e.title, e.summary, p.promptText, e.reason, e.story, e.followup, ...(e.keywords || []), ...(e.details || []).map(f => f.label + f.value)].join(" ").toLocaleLowerCase().includes(query));
    }) };
  }
  function render() {
    if (S.background) return;
    const { all, entries } = visibleEntries();
    const filtered = filter.categories.size > 0 || !!filter.mode || !!$("search").value.trim();
    $("count").textContent = `${entries.length} 条记忆${filtered ? " · 已筛选" : ""}`;
    $("filter-btn").querySelector(".sg-dot").hidden = !(filter.categories.size > 0 || !!filter.mode);
    $("more").hidden = entries.length <= S.limit;
    $("cards").innerHTML = entries.slice(0, S.limit).map(cardHtml).join("")
      || `<p class="sg-empty">${all.length ? "没有找到这段记忆，试试其他筛选。" : "还没有拾光。聊到设定轮数会自动整理，也可以点「整理新消息」。"}</p>`;
    renderProgress();
    busy(S.busy);
  }
  function cardOf(id) { return document.querySelector(`.sg-record[data-id="${CSS.escape(id)}"]`); }
  function cardNotice(id, text, failed = false) { const el = cardOf(id) && cardOf(id).querySelector("[data-card-notice]"); if (el) { el.textContent = text; el.dataset.error = String(failed); } }
  async function load() {
    if (!S.characterId) { $("cards").innerHTML = '<p class="sg-empty">先在小手机创建一个角色，再来收藏共同经历。</p>'; return; }
    const revision = ++S.revision, cid = S.characterId;
    busy(true); notice(""); openCards.clear(); $("cards").innerHTML = '<p class="sg-empty">正在翻找记忆…</p>';
    try {
      await Promise.all([loadEntries(cid), loadProgress(cid)]);
      const imported = await migrateCharacter(cid);
      if (revision !== S.revision) return;
      S.limit = 20; render();
      if (imported) notice(`已接续 ${imported} 条旧拾光记录。`);
      if (!S.settings.enabled) notice("拾光已关闭：记录仍保留，暂停整理和发送。可在「回忆规则」开启。");
      syncContext(cid).catch(() => {});
    } catch (err) { notice(errText(err), true); $("cards").innerHTML = '<p class="sg-empty">记忆未能读取，点击刷新重试。</p>'; }
    finally { if (revision === S.revision) busy(false); }
  }
  function showTab(tab) {
    S.tab = tab;
    $("memories").hidden = tab !== "memories"; $("rules").hidden = tab !== "rules";
    document.querySelector(".sg-tools").hidden = tab !== "memories"; $("filters").hidden = tab !== "memories" || $("filter-btn").getAttribute("aria-expanded") !== "true";
    $("rules-btn").textContent = tab === "rules" ? "记忆本" : "回忆规则"; $("rules-btn").dataset.tab = tab === "rules" ? "memories" : "rules";
    window.scrollTo(0, 0);
  }
  function bindList() {
    $("category-chips").innerHTML = CATEGORIES.map(c => `<label class="sg-chip"><input type="checkbox" value="${esc(c)}"><span>${esc(c)}</span></label>`).join("");
    $("category-chips").addEventListener("change", event => { const box = event.target; if (box.checked) filter.categories.add(box.value); else filter.categories.delete(box.value); S.limit = 20; render(); });
    $("mode-chips").addEventListener("change", event => { filter.mode = event.target.value; S.limit = 20; render(); });
    $("clear-filters").onclick = () => { filter.categories.clear(); filter.mode = ""; $("search").value = ""; $("category-chips").querySelectorAll("input").forEach(i => { i.checked = false; }); $("mode-chips").querySelector("input[value='']").checked = true; S.limit = 20; render(); };
    $("filter-btn").onclick = () => { const open = $("filter-btn").getAttribute("aria-expanded") !== "true"; $("filter-btn").setAttribute("aria-expanded", String(open)); $("filters").hidden = !open; };
    $("search").addEventListener("input", () => { S.limit = 20; render(); });
    $("cards").addEventListener("toggle", event => { const details = event.target; const id = details.closest("[data-id]").dataset.id; if (details.open) openCards.add(id); else openCards.delete(id); }, true);
    $("cards").onclick = event => {
      const button = event.target.closest("button[data-action]"); if (!button || S.busy) return;
      const record = button.closest("[data-id]");
      const entry = (S.entries[S.characterId] || []).find(e => e.id === record.dataset.id); if (!entry) return;
      if (button.dataset.action === "edit") toggleEditor(record, entry, button);
      if (button.dataset.action === "sources") void toggleSources(record, entry, button);
      if (button.dataset.action === "delete") { S.deleting = entry; $("delete-error").textContent = ""; $("delete-dialog").showModal(); }
    };
    $("character").onchange = () => { S.characterId = $("character").value; void load(); };
    $("refresh").onclick = () => void (S.characters.length ? load() : start());
    $("more").onclick = () => { S.limit += 20; render(); };
    document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => showTab(button.dataset.tab)));
    $("organize").onclick = async () => {
      if (S.busy) return;
      busy(true); $("organize").textContent = "正在整理…"; notice("正在调用模型，完成前请保持页面打开。");
      try {
        const result = await organize(S.characterId);
        if (!result.success) throw new Error(result.error || "整理失败，请重试");
        render(); await syncContext(S.characterId).catch(() => {});
        notice(`整理完成，记下 ${result.saved} 条。${result.hasMore ? "还有未整理的消息，可再点一次继续。" : ""}`);
      } catch (err) { notice(errText(err), true); render(); }
      finally { busy(false); $("organize").textContent = "整理新消息"; }
    };
  }
