  /* ================= 整理：聊天 → 拾光 ================= */
  const { countRounds, sliceBatch } = ShiguangRounds;
  const { selectCandidates, formatEvents, buildPrompt, parseResult } = ShiguangExtraction;

  function withLock(cid, task) {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return navigator.locks.request("shiguang:" + cid, { ifAvailable: true }, lock => lock ? task() : Promise.resolve({ success: false, error: "另一处正在整理这位角色，请稍后。" }));
    }
    return task();
  }

  /** 一次处理一批（约两万四千字）；hasMore 表示还有没整理的，再点一次继续。 */
  async function organize(cid) {
    const settings = await loadSettings();
    if (!settings.enabled) return { success: false, error: "请先在「回忆规则」开启拾光。" };
    const who = character(cid);
    if (!who) return { success: false, error: "角色不存在，请刷新。" };
    return withLock(cid, async () => {
      try {
        // 进度和记录每次都重读：前台页面和宿主临时拉起的隐藏环境各有一份缓存，不能各信各的
        const progress = await loadProgress(cid);
        const pending = await messagesAfter(cid, progress && progress.watermarkAt);
        if (pending.length < 2) return { success: false, error: "还没有足够的新聊天消息，继续聊聊再整理。" };
        const sources = sliceBatch(pending);
        const events = formatEvents(sources, who.name);
        const entries = await loadEntries(cid);
        const candidates = selectCandidates(entries, events);
        const result = await S.api.ai.chat({ characterId: cid, messages: [{ role: "user", content: buildPrompt(who.name, events, candidates) }], temperature: 0.3 });
        if (!result || !result.text) throw new Error("模型返回了空内容，未改变整理进度。");
        if (result.wasTruncated) throw new Error("模型输出被截断，未保存；请提高输出上限后重试。");
        const now = new Date().toISOString();
        const parsed = parseResult(result.text, sources, candidates, cid, now);
        let saved = 0;
        for (const entry of parsed) {
          const old = entries.find(e => e.id === entry.id);
          if (old && (old.deletedAt || (old.userEdited && entry.baseUpdatedAt !== old.updatedAt))) continue;
          try { if (await putEntry(cid, entry)) saved++; } catch { /* 版本冲突：用户刚改过，这条让给用户 */ }
        }
        const last = sources[sources.length - 1];
        await saveProgress(cid, { watermarkAt: String(last.createdAt), watermarkId: last.id, lastRunAt: now, lastError: "", retryAfter: "" });
        return { success: true, saved, hasMore: sources.length < pending.length };
      } catch (err) {
        const message = errText(err);
        await saveProgress(cid, { lastError: message, retryAfter: new Date(Date.now() + 5 * 60000).toISOString() }).catch(() => {});
        return { success: false, error: message };
      }
    });
  }

  /** 自动整理：新消息攒够设定轮数才调模型；失败后五分钟内不再试。 */
  async function maybeAutoOrganize(cid) {
    const settings = await loadSettings();
    if (!settings.enabled || !settings.autoEnabled) return null;
    const progress = await loadProgress(cid);
    if (progress && progress.retryAfter && progress.retryAfter > new Date().toISOString()) return null;
    if (!progress || !progress.watermarkAt) {
      // 第一次遇到这位角色：从现在起算，不回头翻整部聊天史。想整理更早的，在设置里点「从头整理」。
      await saveProgress(cid, { watermarkAt: new Date().toISOString(), watermarkId: "" });
      return null;
    }
    const pending = await messagesAfter(cid, progress.watermarkAt);
    if (countRounds(pending) < Math.max(5, settings.roundInterval || 20)) return null;
    return organize(cid);
  }
