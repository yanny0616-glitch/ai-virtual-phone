  /* ================= 卡片内编辑、删除 ================= */
  const LIMITS = { title: 60, summary: 200, reason: 1200, story: 1200, facts: 5500, significance: 600, followup: 1000, promptSummary: 600 };
  function field(name, label, value, rows = 2) {
    const max = LIMITS[name] || 1200;
    return `<label>${esc(label)}<textarea name="${name}" maxlength="${max}" rows="${rows}" ${["title", "summary", "promptSummary"].includes(name) ? "required" : ""}>${esc(value)}</textarea></label>`;
  }
  function editorHtml(entry) {
    const e = present(entry);
    return `<form class="sg-update" data-editor>
<h3>发给 AI 的摘要</h3><p class="sg-fine">保留人名、具体物品或作品名、关键行为、日期与约定；进展和后续会自动附在后面。</p>
${field("promptSummary", "摘要", e.promptSummary || ShiguangRecall.defaultSummary(e), 4)}
<div class="sg-inline"><button type="button" class="sg-action" data-regenerate>从卡片内容重新生成</button></div>
<div class="sg-two"><label>发送方式<select name="recallMode">${Object.entries(MODES).map(([v, k]) => `<option value="${v}" ${e.recallMode === v ? "selected" : ""}>${k}</option>`).join("")}</select></label><label>进展<select name="status">${Object.entries(STATUSES).map(([v, k]) => `<option value="${v}" ${e.status === v ? "selected" : ""}>${k}</option>`).join("")}</select></label></div>
<label data-due hidden>约定日期<input type="date" name="dueAt" value="${esc(e.dueAt || "")}"></label>
<label>回忆关键词<small>顿号或逗号隔开，最多 8 个</small><input name="keywords" value="${esc((e.keywords || []).join("、"))}"></label>
<h3>记忆类型</h3><div class="sg-chips">${CATEGORIES.map(c => `<label class="sg-chip"><input type="checkbox" name="categories" value="${esc(c)}" ${(e.categories || []).includes(c) ? "checked" : ""}><span>${esc(c)}</span></label>`).join("")}</div>
${field("title", "标题", e.title, 1)}${field("summary", "记忆简述", e.summary)}${field("reason", "事情的缘由", e.reason)}${field("story", "那天发生了什么", e.story)}${field("facts", "具体信息（每行一项：名称：内容）", (e.details || []).map(f => f.label + "：" + f.value).join("\n"))}${field("significance", "值得记住的", e.significance)}${field("followup", "后来发生了什么", e.followup)}
<button class="sg-submit" type="submit">保存记忆</button>
<button class="sg-clear" type="button" data-action="delete">删除这条记忆</button>
</form>`;
  }
  function toggleEditor(record, entry, button) {
    const slot = record.querySelector(".sg-slot");
    const open = !!slot.querySelector("[data-editor]");
    record.querySelectorAll("[data-action=sources]").forEach(b => b.setAttribute("aria-expanded", "false"));
    slot.innerHTML = open ? "" : editorHtml(entry);
    button.setAttribute("aria-expanded", String(!open));
    if (open) return;
    const form = slot.querySelector("form");
    const syncDate = () => { form.querySelector("[data-due]").hidden = form.elements.status.value !== "pending"; };
    form.elements.status.onchange = syncDate; syncDate();
    form.querySelector("[data-regenerate]").onclick = () => { form.elements.promptSummary.value = ShiguangRecall.defaultSummary({ ...draftFromForm(form), legacy: undefined }); };
    form.onsubmit = event => { event.preventDefault(); void saveEdit(record, entry, form); };
  }
  function draftFromForm(form) {
    const fd = new FormData(form), draft = Object.fromEntries(fd);
    for (const key of Object.keys(draft)) if (typeof draft[key] === "string") draft[key] = draft[key].trim();
    draft.categories = fd.getAll("categories");
    draft.keywords = [...new Set(String(draft.keywords || "").split(/[,，、\n]+/).map(v => v.trim()).filter(Boolean))];
    draft.details = String(draft.facts || "").split("\n").map(v => v.trim()).filter(Boolean).map(line => {
      const i = line.search(/[：:]/); return i > 0 ? { label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : { label: "补充", value: line };
    });
    delete draft.facts;
    return draft;
  }
  function validateDraft(d) {
    if (!d.title) throw new Error("标题不能为空");
    if (!d.summary) throw new Error("记忆简述不能为空");
    if (!d.promptSummary) throw new Error("摘要不能为空");
    if (!d.categories.length) throw new Error("至少选择一种记忆类型");
    if (d.keywords.length > 8) throw new Error("关键词最多 8 个");
    if (d.details.length > 12) throw new Error("具体信息最多 12 行");
    for (const f of d.details) if (f.label.length > 40 || f.value.length > 400) throw new Error("具体信息每行名称最多 40 字、内容最多 400 字");
    if (!MODES[d.recallMode]) throw new Error("发送方式无效");
    if (!STATUSES[d.status]) throw new Error("进展无效");
    if (d.dueAt && !ShiguangText.isValidDate(d.dueAt)) throw new Error("约定日期无效");
  }
  async function saveEdit(record, entry, form) {
    const submit = form.querySelector(".sg-submit");
    if (submit.disabled) return;
    submit.disabled = true; submit.textContent = "保存中…"; cardNotice(entry.id, "");
    try {
      const d = draftFromForm(form); validateDraft(d);
      const now = new Date(Math.max(Date.now(), Date.parse(entry.updatedAt) + 1)).toISOString();
      const next = { ...entry, ...d, dueAt: d.status === "pending" ? d.dueAt || undefined : undefined, userEdited: true, updatedAt: now, baseUpdatedAt: entry.updatedAt };
      await putEntry(entry.characterId, next);
      render(); cardNotice(entry.id, "记忆已更新，手动修改的内容会优先保留。");
      syncContext(entry.characterId).catch(() => {});
    } catch (err) { cardNotice(entry.id, errText(err), true); submit.disabled = false; submit.textContent = "保存记忆"; }
  }
  async function confirmDelete() {
    const entry = S.deleting; if (!entry || $("confirm-delete").disabled) return;
    $("confirm-delete").disabled = true; $("cancel-delete").disabled = true;
    try {
      const now = new Date(Math.max(Date.now(), Date.parse(entry.updatedAt) + 1)).toISOString();
      await putEntry(entry.characterId, { ...entry, deletedAt: now, userEdited: true, updatedAt: now, baseUpdatedAt: entry.updatedAt });
      $("delete-dialog").close(); render(); notice("这条拾光已删除，原聊天消息保留。");
      syncContext(entry.characterId).catch(() => {});
    } catch (err) { $("delete-error").textContent = errText(err); }
    finally { $("confirm-delete").disabled = false; $("cancel-delete").disabled = false; }
  }
  function bindEditor() {
    $("confirm-delete").onclick = confirmDelete;
    $("cancel-delete").onclick = () => $("delete-dialog").close();
    $("delete-dialog").addEventListener("cancel", event => { if ($("confirm-delete").disabled) event.preventDefault(); });
  }
