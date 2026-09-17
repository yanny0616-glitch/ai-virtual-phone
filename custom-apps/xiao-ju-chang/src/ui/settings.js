// ── 设置：外观 / 生成 / 数据 三类横排切换 ──
const settings = {
  bind() {
    document.querySelectorAll("#set-cats [data-p]").forEach(b => { b.onclick = () => { document.querySelectorAll("#set-cats [data-p]").forEach(x => x.classList.toggle("on", x === b)); document.querySelectorAll(".view-settings .pane").forEach(p => p.classList.toggle("on", p.dataset.pane === b.dataset.p)); }; });
    viewHooks.settings = () => settings.render();
  },
  set(patch) {
    const before = state.settings.theme;
    saveSettings(patch); theme.apply();
    if (patch.fontScale !== undefined || patch.lineHeight !== undefined) updateFrameReading();
    if (patch.theme && patch.theme !== before && state.result && $("result-host").firstChild) stage.showResult(state.result);
  },
  render() { settings.renderLook(); settings.renderGen(); settings.renderData(); },

  renderLook() {
    const box = $("pane-look"); box.innerHTML = "";
    const s = state.settings;
    const tiles = el("div", "themes");
    THEMES.forEach(t => {
      const b = el("button", "th" + (s.theme === t.id ? " on" : "")); b.type = "button";
      b.appendChild(el("div", "pv " + t.pv)); b.appendChild(el("b", "", t.name)); b.appendChild(el("span", "", t.desc));
      b.onclick = () => { settings.set({ theme: t.id }); settings.renderLook(); };
      tiles.appendChild(b);
    });
    box.appendChild(tiles);
    box.appendChild(setRow("字号", "整体偏小是故意的", miniSeg([{ v: "0.92", l: "小" }, { v: "1", l: "标准" }, { v: "1.08", l: "略大" }], String(s.fontScale || 1), v => settings.set({ fontScale: Number(v) }))));
    box.appendChild(setRow("行距", "", miniSeg([{ v: "tight", l: "紧" }, { v: "mid", l: "中" }, { v: "loose", l: "松" }], s.lineHeight || "mid", v => settings.set({ lineHeight: v }))));
    box.appendChild(setRow("动效", "抽屉滑入、生成时呼吸灯", toggle(s.motion !== false, v => settings.set({ motion: v }))));
  },
  renderGen() {
    const box = $("pane-gen"); box.innerHTML = "";
    const s = state.settings;
    const h = t => { const x = el("div", "grp"); x.appendChild(el("h3", "", t)); box.appendChild(x); return x; };
    const g1 = h("生成");
    const lenRow = setRow("默认篇幅", "小剧场里选「跟设置」时用", miniSeg([{ v: "short", l: "短 400" }, { v: "medium", l: "中 900" }, { v: "long", l: "长 1800" }], s.defaultLength || "medium", v => settings.set({ defaultLength: v })));
    g1.appendChild(setRow("篇幅限制", "关掉后不给模型字数要求", toggle(s.lengthLimit !== false, v => { settings.set({ lengthLimit: v }); lenRow.style.opacity = v ? "" : ".4"; })));
    lenRow.style.opacity = s.lengthLimit !== false ? "" : ".4"; g1.appendChild(lenRow);
    g1.appendChild(setRow("边写边显示", "宿主支持流式时逐字出现；HTML 分两步出的第二步直接填进格子", toggle(s.streamPreview !== false, v => settings.set({ streamPreview: v }))));
    const g2 = h("新建小剧场的默认值");
    g2.appendChild(setRow("我是谁", "", miniSeg(WHO_OPTS, s.defaultWho || "persona", v => settings.set({ defaultWho: v }))));
    const roundsRow = setRow("默认轮数", "", stepper(Number(s.defaultRounds) || 12, 1, 50, v => settings.set({ defaultRounds: v })));
    g2.appendChild(setRow("记忆", "", miniSeg(MEM_OPTS, s.defaultMemory || "host", v => { settings.set({ defaultMemory: v }); roundsRow.style.display = v === "recent" ? "" : "none"; })));
    roundsRow.style.display = (s.defaultMemory || "host") === "recent" ? "" : "none"; g2.appendChild(roundsRow);
    g2.appendChild(setRow("写回记忆", "", toggle(!!s.writeBackDefault, v => settings.set({ writeBackDefault: v }))));
    g2.appendChild(setRow("HTML 风格约束", "", miniSeg(STYLE_OPTS, s.defaultStyle || "free", v => settings.set({ defaultStyle: v }))));
    g2.appendChild(setRow("HTML 分两步出", "先骨架后填字，页面能早点看到", toggle(!!s.stagedDefault, v => settings.set({ stagedDefault: v }))));
    const g3 = h("随机与最近");
    g3.appendChild(setRow("随机一篇可抽到「AI 自选」", "", toggle(s.randomIncludesAi !== false, v => settings.set({ randomIncludesAi: v }))));
    g3.appendChild(setRow("最近保留", "没收藏的结果留几条", stepper(Number(s.recentKeep) || 10, 1, 50, v => settings.set({ recentKeep: v }))));
  },
  renderData() {
    const box = $("pane-data"); box.innerHTML = "";
    const counts = `${state.combos.length} 个小剧场 · ${state.prompts.length} 条提示词 · ${state.randoms.length} 条随机 · ${state.macros.length} 个宏 · ${state.preambles.length} 条前置 · ${state.favorites.length} 收藏`;
    box.appendChild(el("p", "note-box", counts));
    const invalidCount = Object.values(state.invalidRecords || {}).reduce((n, rows) => n + rows.length, 0);
    if (invalidCount) box.appendChild(el("p", "note-box", `有 ${invalidCount} 条无效数据已隔离。导出整包会保留其原始内容，清空或重置会删除。`));
    const row = (label, sub, btnLabel, fn, danger) => { const b = el("button", danger ? "danger" : "", btnLabel); b.type = "button"; b.onclick = () => fn().catch(fail); box.appendChild(setRow(label, sub, b)); };
    row("导出整包", "库 + 收藏，JSON", "导出", async () => { await saveJsonFile(exportBundle(), `小剧场-全部-${new Date().toISOString().slice(0, 10)}.json`); });
    row("导入", "本 APP 的 JSON / 暗柜「夜间档案」；其它 JSON 会列出段落让你挑", "选文件", async () => { const data = await pickJsonFile(); const n = await library.importAny(data); toast(n ? `导入 ${n} 条` : "没有导入"); settings.renderData(); });
    row("恢复默认库", "只补缺失的默认条目，不动你改过的", "补齐", async () => { await seedIfEmpty(true); toast("已补齐"); library.render(); settings.renderData(); });
    row("清空最近", "", "清空", async () => confirmSheet("清空最近", "删掉所有未收藏的最近结果？", "清空", async () => { await clearCollection("recents"); state.result = null; $("result-host").innerHTML = ""; settings.renderData(); toast("已清空"); }, true), true);
    row("清空收藏", "", "清空", async () => confirmSheet("清空收藏", "删掉全部收藏？不可恢复。", "清空", async () => { await clearCollection("favorites"); settings.renderData(); toast("已清空"); }, true), true);
    row("重置全部", "库、收藏、设置全删，重新播种默认库", "重置", async () => confirmSheet("重置全部", "所有小剧场、提示词、收藏和设置都会删掉。确定？", "全部重置", async () => {
      for (const n of ["combos", "prompts", "randoms", "macros", "preambles", "favorites", "recents"]) await clearCollection(n);
      const id = state.settings.id; state.settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), id, characterId: state.character ? state.character.id : "" };
      saveSettings({}); await seedIfEmpty(); theme.apply(); state.result = null; $("result-host").innerHTML = ""; settings.render(); toast("已重置");
    }, true), true);
    box.appendChild(el("p", "small hint", "版本 0.1.1 · 生成走宿主 ai.generate，只注入人设 / 性格 / 关系 / 世界书 / 你选的记忆段；纯裸通道走 ai.chat。"));
  },
};
