  /* ================= 后台：每条新消息 ================= */
  // APP 开着时前台收；关着时宿主临时拉起隐藏环境跑同一个 handler，跑完销毁。
  // 顺序固定：先按最新几句刷新注入，再看攒没攒够轮数整理。整理成功后再刷一次注入。
  async function onChatMessage(payload) {
    if (!payload || payload.isGroup || !payload.characterId) return;
    const cid = payload.characterId;
    if (!S.characters.length) S.characters = await S.api.characters.list().catch(() => []);
    if (!character(cid)) return;
    await serial("bg:" + cid, async () => {
      await syncContext(cid);
      if (payload.message && payload.message.role === "assistant") {
        const result = await maybeAutoOrganize(cid);
        if (result && result.success) {
          await syncContext(cid);
          if (!S.background && S.characterId === cid) { render(); notice(`自动整理完成，保存 ${result.saved} 条。`); }
        }
      }
    });
  }
