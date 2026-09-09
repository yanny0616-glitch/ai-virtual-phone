  /* ================= 注入聊天提示词 ================= */
  // 当轮路径纯读：每次重读设置和记录，不用前台缓存，也不写共享上下文或等待自动整理。
  async function providePromptContext(input) {
    if (!input || !input.characterId || !Array.isArray(input.messages)) return "";
    const rows = await S.api.db.list("settings", { limit: 5 });
    const settings = { ...SETTINGS_DEFAULT, ...((rows || [])[0] || {}) };
    if (!settings.enabled) return "";
    const entries = await S.api.db.list(col(input.characterId), { limit: 500 });
    const text = input.messages.map(m => typeof m.content === "string" ? m.content : "").join("\n");
    return ShiguangRecall.contextText(ShiguangRecall.selectForPrompt(entries || [], text, settings.tokenBudget, new Date()));
  }
  // 覆盖式写一段进角色的提示词，宿主排在聊天历史之后。每来一条消息就按最近几句
  // 重算一次，为其他场景和旧宿主刷新状态；普通私聊优先用上面的当轮返回值。
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
