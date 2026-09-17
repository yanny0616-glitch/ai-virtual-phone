// ── 舞台：主演卡 → 选小剧场 → 生成 → 结果 → 最近 ──
const pendingFavorites = new Map();
const stage = {
  bind() {
    $("btn-gen").onclick = () => { const c = stage.currentCombo(); if (!c) { toast("先建一个小剧场"); switchView("library"); return; } stage.run(c); };
    $("btn-random").onclick = () => stage.run(weightedRandomCombo());
    $("btn-ai").onclick = () => stage.run(aiPickCombo());
    viewHooks.stage = () => stage.render();
  },
  currentCombo() { return byId(state.combos, state.settings.currentComboId) || state.combos[0] || null; },
  comboOf(result) { return result.comboCopy || byId(state.combos, result.comboId) || null; },
  continueResult(result, text) {
    if (state.busy) { toast("上一篇还在写"); return; }
    const combo = stage.comboOf(result);
    if (!combo) { toast("配置已丢失"); return; }
    const character = byId(state.characters, result.characterId);
    if (!character) { toast("这篇的角色已删除或不可见"); return; }
    closeFullscreen();
    switchView("stage");
    return stage.run(combo, `上一篇正文：\n${resultPlainText(result)}\n\n用户在上一篇里选择了「${text}」，接着这个选择往下写新的一篇。`, character);
  },
  render() { stage.renderLead(); stage.renderPick(); stage.renderRecent(); if (state.result && !$("result-host").children.length) stage.showResult(state.result); },

  renderLead() {
    const box = $("lead"); box.innerHTML = "";
    const c = state.character;
    const ava = el("span", "ava c1");
    if (c && c.avatar) { const img = el("img"); img.src = c.avatar; img.alt = ""; ava.appendChild(img); } else ava.textContent = c ? c.name.slice(0, 1) : "?";
    const info = el("div", "grow");
    info.appendChild(el("div", "nm", c ? c.name : "还没有角色"));
    const mine = c ? [...state.recents, ...state.favorites].filter(r => r.characterId === c.id) : [];
    const last = mine.map(r => r.createdAt).sort().pop();
    const played = c ? (state.combos.reduce((a, x) => a + ((x.plays || {})[c.id] || 0), 0)) : 0;
    info.appendChild(el("div", "small", c ? `已演 ${played} 篇${last ? " · 上次 " + fmtTime(last) : ""} · ${memoryLabel((stage.currentCombo() || {}).memory)}` : "去宿主里先建一个角色"));
    const sw = el("button", "sw", "切换 ›"); sw.type = "button"; sw.onclick = stage.pickCharacter;
    box.append(ava, info, sw);
  },
  pickCharacter() {
    openSheet("选主演", box => {
      if (!state.characters.length) { box.appendChild(el("p", "empty", "宿主里还没有角色")); return; }
      state.characters.forEach(c => {
        const row = el("div", "pickrow" + (state.character && c.id === state.character.id ? " on" : ""));
        const ava = el("span", "ava c1"); if (c.avatar) { const img = el("img"); img.src = c.avatar; ava.appendChild(img); } else ava.textContent = c.name.slice(0, 1);
        ava.style.width = "28px"; ava.style.height = "28px"; ava.style.fontSize = "11px";
        row.append(ava, el("div", "grow", c.name));
        row.onclick = () => { state.character = c; refreshUserName(c).catch(fail); saveSettings({ characterId: c.id }); closeSheet(); stage.render(); };
        box.appendChild(row);
      });
    });
  },

  renderPick() {
    const box = $("pick"); box.innerHTML = "";
    const c = stage.currentCombo();
    if (!c) { box.appendChild(el("div", "name none", "还没有小剧场，去「小剧场」页建一个")); box.onclick = () => switchView("library"); return; }
    box.appendChild(el("div", "name", c.name));
    const chips = el("div", "chips");
    const titles = (c.promptIds || []).map(id => (byId(state.prompts, id) || {}).title).filter(Boolean);
    const chip = (k, v) => { const s = el("span", "chip"); s.appendChild(el("b", "", k)); s.appendChild(document.createTextNode(v)); chips.appendChild(s); };
    chip("提示词", titles.length ? titles.join(" · ") : "无");
    const r = c.random || {}; chip("随机", r.count ? `抽 ${r.count}${(r.include || []).length ? " · #" + r.include.join(" #") : ""}` : "不抽");
    chip("输出", ({ html: "HTML", text: "纯文字", mixed: "组合" }[(c.output || {}).mode] || "纯文字") + ((c.output || {}).staged && (c.output || {}).mode === "html" ? " · 两步" : ""));
    chip("记忆", memoryLabel(c.memory));
    box.appendChild(chips);
    box.onclick = stage.pickCombo;
  },
  pickCombo() {
    openSheet("选小剧场", box => {
      const cur = state.settings.currentComboId;
      state.combos.forEach(c => {
        const row = el("div", "pickrow" + (c.id === cur ? " on" : ""));
        const cb = el("span", "cb"); const body = el("div", "grow");
        body.appendChild(el("div", "et", c.name));
        body.appendChild(el("div", "ex", `${(c.tags || []).join(" · ") || "无标签"} · 权重 ${c.weight ?? 1}`));
        const edit = el("button", "small", "编辑"); edit.type = "button"; edit.onclick = e => { e.stopPropagation(); closeSheet(); library.openCompose(c.id); };
        row.append(cb, body, edit);
        row.onclick = () => { saveSettings({ currentComboId: c.id }); closeSheet(); stage.render(); };
        box.appendChild(row);
      });
      const add = el("button", "fab ghost", "新建小剧场"); add.type = "button"; add.onclick = () => { closeSheet(); library.openCompose(""); };
      box.appendChild(add);
    });
  },

  runSeq: 0,
  async run(combo, extra, selectedCharacter = state.character) {
    if (state.busy) { toast("上一篇还在写"); return; }
    if (!selectedCharacter) { toast("先选一个角色"); return; }
    const character = clone(selectedCharacter);
    combo = captureCombo(combo);
    const token = ++stage.runSeq;
    const mine = () => stage.runSeq === token;
    state.busy = true;
    const host = $("result-host"); host.innerHTML = "";
    const started = Date.now();
    const busy = el("div", "busy");
    const line = el("div", "row"); line.appendChild(el("i", "spin")); line.appendChild(el("span", "", `${charName(character)} 正在演《${combo.name}》`)); const sec = el("b", "sec", "0 秒"); line.appendChild(sec);
    const cancel = el("button", "cancel", "取消"); cancel.type = "button"; cancel.onclick = () => stage.cancel(token);
    busy.append(line, cancel); host.appendChild(busy);
    let phase = "", chars = 0;
    const tick = () => { const n = Math.round((Date.now() - started) / 1000); sec.textContent = `${n} 秒${chars ? ` · ${chars} 字` : ""}`; if (phase) setResultStatus(`${phase} · ${n} 秒`); };
    const timer = setInterval(tick, 1000);
    stage.setWriting(true);
    $("main").scrollTop = 0;
    let result = null, previewing = false;
    const stamp = () => new Date().toISOString();
    const base = () => ({ characterId: character.id, characterName: character.name, comboId: combo.id || "", comboName: combo.name, comboCopy: clone(combo), createdAt: stamp() });
    const slotTotal = { n: 0 };
    // 流式预览：纯文字直接写进 iframe；HTML 只报字数（半截 HTML 没法渲染）；填字阶段流进格子
    const preview = throttle(ev => {
      if (!mine()) return;
      chars = ev.text.replace(/\s+/g, "").length;
      if (ev.kind === "fill") {
        const done = Object.keys(ev.fill).length;
        if (result && done) { fillFrame(result, ev.fill); phase = `骨架好了，正在填第 ${Math.min(done, slotTotal.n)} / ${slotTotal.n} 处`; }
        tick(); return;
      }
      if (ev.kind !== "text") { tick(); return; }
      const parsed = postProcess(ev.text, combo);
      if (!parsed.segments.length || !parsed.segments.every(x => x.type === "text")) { tick(); return; }
      if (!result) { result = { ...base(), title: parsed.title, raw: ev.text, segments: [{ type: "text", content: "" }], snapshot: ev.snapshot || {} }; stage.showResult(result); stage.markWriting(true); previewing = true; host.appendChild(cancel); }
      if (!previewing) return;
      streamFrame(result, parsed.segments, true);
      Object.assign(result, { title: parsed.title, raw: ev.text, segments: parsed.segments }); refreshResultMeta(result);
      tick();
    }, 160);
    try {
      const gen = await generateTheater(combo, {
        extra, character, isCancelled: () => !mine(),
        onStream: state.settings.streamPreview !== false ? preview : undefined,
        onShell: shell => {
          if (!mine()) return;
          preview.cancel(); chars = 0;
          result = { ...base(), title: shell.title, raw: shell.raw, segments: shell.segments, snapshot: shell.snapshot, model: shell.model };
          stage.showResult(result); stage.markWriting(true);
          slotTotal.n = shell.slots.length;
          phase = `骨架好了，正在填 ${shell.slots.length} 处文字`; tick();
          host.appendChild(cancel);
        },
      });
      if (!mine() || !gen) return;
      preview.cancel(); clearInterval(timer); phase = ""; setResultStatus(""); cancel.remove();
      if (result) Object.assign(result, { title: gen.title, raw: gen.raw, segments: gen.segments, snapshot: gen.snapshot, model: gen.model, createdAt: stamp() });
      else result = { ...base(), title: gen.title, raw: gen.raw, segments: gen.segments, snapshot: gen.snapshot, model: gen.model };
      const saved = await pushRecent(result);
      Object.assign(result, saved);
      state.result = result;
      if (gen.fill) { fillFrame(result, gen.fill); refreshResultMeta(result); }
      else if (previewing && gen.segments.every(x => x.type === "text")) { streamFrame(result, gen.segments, false); refreshResultMeta(result); }
      else stage.showResult(result);
      stage.markWriting(false);
      const current = byId(state.combos, combo.id);
      if (current) {
        const plays = { ...(current.plays || {}) }; plays[character.id] = (plays[character.id] || 0) + 1;
        await upsert("combos", { id: current.id, useCount: (current.useCount || 0) + 1, lastUsedAt: result.createdAt, plays });
      }
      saveSettings({ issueNo: (Number(state.settings.issueNo) || 1) + 1 });
      writeBackMemory(result, combo);
      stage.renderLead(); stage.renderRecent();
    } catch (e) {
      if (!mine()) return;
      preview.cancel(); clearInterval(timer); phase = ""; setResultStatus(""); cancel.remove();
      const err = el("div", "err", `没写出来：${e && e.message ? e.message : e}`);
      const retry = el("button", "fab ghost", "再试一次"); retry.type = "button"; retry.onclick = () => stage.run(combo, extra, character);
      if (result && !previewing) { stage.markWriting(false); host.append(err, retry); } else { host.innerHTML = ""; host.append(err, retry); }
    } finally { if (mine()) { clearInterval(timer); state.busy = false; stage.setWriting(false); } }
  },
  /** 宿主的 ai.generate 不能中断，取消只是不再等它：结果回来也丢掉 */
  cancel(token) {
    if (stage.runSeq !== token || !state.busy) return;
    stage.runSeq++; state.busy = false; stage.setWriting(false);
    const host = $("result-host"); host.innerHTML = "";
    host.appendChild(el("div", "empty", "已取消。模型那边可能还在写，回来的结果会直接丢掉。"));
  },
  /** 还在写的结果卡：收藏 / 复制 / 再来一条先按不了，免得存半篇 */
  markWriting(on) { const card = $("result-host").querySelector(".result"); if (card) card.classList.toggle("writing", on); },
  setWriting(on) { $("app").classList.toggle("writing", on); const b = $("btn-gen"); b.disabled = on; b.textContent = on ? "正在写…" : "生成一篇"; },
  handlers() {
    return {
      again: r => { const c = stage.comboOf(r); if (c) stage.run(c); else toast("这个小剧场已删除"); },
      fav: r => {
        const key = r.id || r;
        if (pendingFavorites.has(key)) return pendingFavorites.get(key);
        const job = (async () => {
          const existing = favoriteOf(r);
          if (existing) { r.favoriteId = existing.id; toast("已经收藏过了"); return existing.id; }
          const { id, favoriteId, ...data } = r;
          const saved = await upsert("favorites", { ...data, recentId: id || "", favoritedAt: new Date().toISOString() });
          r.favoriteId = saved.id;
          if (id && state.recents.some(x => x.id === id)) await upsert("recents", { id, favoriteId: saved.id });
          toast("已收藏"); favorites.render(); return saved.id;
        })();
        pendingFavorites.set(key, job);
        job.then(() => pendingFavorites.delete(key), () => pendingFavorites.delete(key));
        return job;
      },
      copy: r => copyResult(r),
    };
  },
  showResult(result) { state.result = result; renderResultCard($("result-host"), result, stage.handlers()); },

  renderRecent() {
    const box = $("recent"); box.innerHTML = "";
    const list = [...state.recents].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    $("recent-title").textContent = `最近 · ${list.length}`;
    if (!list.length) { box.appendChild(el("div", "empty", "还没有生成过。点上面的「生成一篇」。")); return; }
    list.forEach(r => {
      const row = el("div", "item");
      row.appendChild(el("span", "t", r.title || r.comboName || "无题"));
      row.appendChild(el("span", "badge", KIND_LABEL[kindOf(r)].replace("型", "")));
      row.appendChild(el("span", "small", fmtTime(r.createdAt)));
      row.onclick = () => { stage.showResult(r); $("main").scrollTop = 0; };
      box.appendChild(row);
    });
  },
};
