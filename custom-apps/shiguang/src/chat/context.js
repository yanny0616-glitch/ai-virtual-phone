  /* ================= 注入聊天提示词 ================= */
  // 覆盖式写一段进角色的提示词，宿主排在聊天历史之后。每来一条消息就按最近几句
  // 重算一次，所以「按话题回忆」跟的是上一轮话题；关掉拾光要写空串撤销。
  async function syncContext(cid, recent) {
    const settings = await loadSettings();
    let text = "";
    if (settings.enabled) {
      const entries = S.entries[cid] || await loadEntries(cid);
      const messages = recent || await recentMessages(cid);
      const picked = ShiguangRecall.selectForPrompt(entries, messages.map(m => m.content).join("\n"), settings.tokenBudget, new Date());
      text = ShiguangRecall.contextText(picked);
    }
    // 宿主按更新时间淘汰超过 6 小时或跨天的状态；文字没变也要续期。
    await S.api.chat.setContext({ characterId: cid, label: "", text });
    return text;
  }
