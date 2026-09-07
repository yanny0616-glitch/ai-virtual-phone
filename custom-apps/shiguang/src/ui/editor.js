  /* ================= 编辑、删除 ================= */
  const LIMITS = { title: 60, summary: 200, reason: 1200, story: 1200, facts: 5500, significance: 600, followup: 1000, promptSummary: 600 };
  function input(name, label, value, rows = 3) {
    const max = LIMITS[name] || 1200;
    return `<label>${esc(label)}<textarea name="${name}" maxlength="${max}" rows="${rows}" ${["title", "summary", "promptSummary"].includes(name) ? "required" : ""}>${esc(value)}</textarea><small>最多 ${max} 字</small></label>`;
  }
  function showEditor(entry) {
    S.editing = entry;
    const e = present(entry);
    $("edit-fields").innerHTML = `<section class="edit-section"><h3>供 AI 回忆的摘要</h3><p class="muted">保留人名、具体物品或作品名、关键行为、日期与约定。进展和后续会自动附在摘要之后。</p><div class="fields">${input("promptSummary", "摘要正文", e.promptSummary || ShiguangRecall.defaultSummary(e), 6)}<label>发送方式<select name="recallMode">${Object.entries(MODES).map(([v, k]) => `<option value="${v}" ${e.recallMode === v ? "selected" : ""}>${k}</option>`).join("")}</select></label><label>回忆关键词（用顿号或逗号隔开，最多 8 个）<input name="keywords" value="${esc((e.keywords || []).join("、"))}"></label></div><button type="button" class="quiet wide" id="regenerate-summary">从下方卡片内容重新生成摘要</button><small>这会替换上方编辑框中的摘要，保存前不会改变记录。</small></section><details><summary>编辑故事与具体信息</summary><div class="fields">${input("title", "标题", e.title, 1)}${input("summary", "卡片简述", e.summary)}${input("reason", "事情的缘由", e.reason)}${input("story", "那天发生了什么", e.story)}${input("facts", "具体信息（每行：名称：内容，最多 12 行）", (e.details || []).map(f => f.label + "：" + f.value).join("\n"))}${input("significance", "值得记住的", e.significance)}<div><span>记忆类型（至少一种）</span><div class="check-group">${CATEGORIES.map(c => `<label><input type="checkbox" name="categories" value="${esc(c)}" ${(e.categories || []).includes(c) ? "checked" : ""}>${esc(c)}</label>`).join("")}</div></div></div></details><div class="fields"><label>当前进展<select name="status">${Object.entries(STATUSES).map(([v, k]) => `<option value="${v}" ${e.status === v ? "selected" : ""}>${k}</option>`).join("")}</select></label><label id="due-field">约定日期<input type="date" name="dueAt" value="${esc(e.dueAt || "")}"></label>${input("followup", "后来发生了什么", e.followup)}</div>`;
    const form = $("edit-form");
    const syncDate = () => { $("due-field").hidden = form.elements.status.value !== "pending"; };
    form.elements.status.onchange = syncDate; syncDate();
    $("regenerate-summary").onclick = () => { form.elements.promptSummary.value = ShiguangRecall.defaultSummary({ ...draftFromForm(), legacy: undefined }); };
    $("edit-error").textContent = "";
    $("editor").showModal(); $("editor").scrollTop = 0;
  }
  function draftFromForm() {
    const fd = new FormData($("edit-form")), draft = Object.fromEntries(fd);
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
    if (!d.summary) throw new Error("卡片简述不能为空");
    if (!d.promptSummary) throw new Error("摘要不能为空");
    if (!d.categories.length) throw new Error("至少选择一种记忆类型");
    if (d.keywords.length > 8) throw new Error("关键词最多 8 个");
    if (d.details.length > 12) throw new Error("具体信息最多 12 行");
    for (const f of d.details) if (f.label.length > 40 || f.value.length > 400) throw new Error("具体信息每行名称最多 40 字、内容最多 400 字");
    if (!MODES[d.recallMode]) throw new Error("发送方式无效");
    if (!STATUSES[d.status]) throw new Error("进展无效");
    if (d.dueAt && !ShiguangText.isValidDate(d.dueAt)) throw new Error("约定日期无效");
  }
  async function saveEdit(event) {
    event.preventDefault();
    const entry = S.editing;
    if (!entry || $("save-entry").disabled) return;
    $("save-entry").disabled = true; $("close-editor").disabled = true; $("edit-error").textContent = "";
    try {
      const d = draftFromForm(); validateDraft(d);
      const now = new Date(Math.max(Date.now(), Date.parse(entry.updatedAt) + 1)).toISOString();
      const next = { ...entry, ...d, dueAt: d.status === "pending" ? d.dueAt || undefined : undefined, userEdited: true, updatedAt: now, baseUpdatedAt: entry.updatedAt };
      await putEntry(entry.characterId, next);
      $("editor").close(); render(); notice("记忆和摘要已保存。下次选中时使用卡片中显示的内容。");
      syncContext(entry.characterId).catch(() => {});
    } catch (err) { $("edit-error").textContent = errText(err); }
    finally { $("save-entry").disabled = false; $("close-editor").disabled = false; }
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
    $("close-editor").onclick = () => $("editor").close();
    $("editor").addEventListener("cancel", event => { if ($("save-entry").disabled) event.preventDefault(); });
    $("delete-dialog").addEventListener("cancel", event => { if ($("confirm-delete").disabled) event.preventDefault(); });
    $("edit-form").onsubmit = saveEdit;
  }
