  /* ================= 回看原消息 ================= */
  async function showSources(entry) {
    $("source-list").innerHTML = '<p class="empty">正在寻找原消息…</p>'; $("sources").showModal();
    try {
      const list = await findMessages(entry.characterId, entry.sourceIds || []);
      $("source-list").innerHTML = list.map(m => `<article class="source"><small>${esc(fmtTime(m.createdAt))} · ${m.role === "user" ? "你" : "角色"}</small><p>${esc(m.content)}</p></article>`).join("")
        || '<p class="empty">关联的原消息已不在最近两千条聊天里，记忆仍保留。</p>';
    } catch (err) { $("source-list").textContent = errText(err); }
  }
  $("close-sources").onclick = () => $("sources").close();
