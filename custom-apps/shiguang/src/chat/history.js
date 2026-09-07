  /* ================= 读聊天记录 ================= */
  const { isTextMessage } = ShiguangRounds;
  const byTime = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));

  /** 从最新往回翻页，翻到水位之前为止；返回水位之后的文本消息，按时间升序。 */
  async function messagesAfter(cid, watermarkAt, maxPages = 25) {
    const out = [];
    let before = "";
    for (let page = 0; page < maxPages; page++) {
      const result = await S.api.chat.readHistory({ characterId: cid, limit: 200, before: before || undefined });
      const messages = (result && result.messages) || [];
      if (!messages.length) break;
      let reached = false;
      for (const m of messages) {
        if (watermarkAt && String(m.createdAt) <= watermarkAt) { reached = true; continue; }
        if (isTextMessage(m)) out.push(m);
      }
      if (reached || messages.length < 200) break;
      before = messages[0].id;
    }
    return out.sort(byTime);
  }

  async function recentMessages(cid, limit = 8) {
    const result = await S.api.chat.readHistory({ characterId: cid, limit });
    return ((result && result.messages) || []).filter(isTextMessage);
  }

  /** 按 id 找原消息：先翻最近两千条，找不到就当已不在本机。 */
  async function findMessages(cid, ids) {
    const wanted = new Set(ids);
    const found = [];
    let before = "";
    for (let page = 0; page < 10 && wanted.size; page++) {
      const result = await S.api.chat.readHistory({ characterId: cid, limit: 200, before: before || undefined });
      const messages = (result && result.messages) || [];
      if (!messages.length) break;
      for (const m of messages) if (wanted.has(m.id)) { found.push(m); wanted.delete(m.id); }
      if (messages.length < 200) break;
      before = messages[0].id;
    }
    return found.sort(byTime);
  }
