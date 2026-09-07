  /* ================= 回看原消息（卡片内气泡） ================= */
  async function toggleSources(record, entry, button) {
    const slot = record.querySelector(".sg-slot");
    const open = !!slot.querySelector("[data-sources]");
    record.querySelectorAll("[data-action=edit]").forEach(b => b.setAttribute("aria-expanded", "false"));
    button.setAttribute("aria-expanded", String(!open));
    if (open) { slot.innerHTML = ""; return; }
    slot.innerHTML = '<section class="sg-source" data-sources><h3>聊天原消息</h3><p class="sg-fine">正在加载…</p></section>';
    try {
      const list = await findMessages(entry.characterId, entry.sourceIds || []);
      const box = slot.querySelector("[data-sources]"); if (!box) return;
      const who = character(entry.characterId);
      box.innerHTML = `<h3>聊天原消息 · ${list.length} 条</h3>` + (list.map(m => `<div class="sg-msg ${m.role === "user" ? "sg-user" : ""}"><label>${m.role === "user" ? "你" : esc(who ? who.name : "角色")} · ${esc(fmtTime(m.createdAt))}</label><p>${esc(m.content)}</p></div>`).join("")
        || '<p class="sg-fine">关联的原消息已不在最近两千条聊天里，记忆仍保留。</p>');
    } catch (err) { cardNotice(entry.id, errText(err), true); }
  }
