// ── 小剧场库：组合 / 提示词 / 随机池+宏 / 前置要求；组合在独立页编辑，其余在底部抽屉编辑 ──
const OUT_MODE = [{ v: "text", l: "纯文字" }, { v: "html", l: "HTML" }, { v: "mixed", l: "组合" }];
const LEN_OPTS = [{ v: "default", l: "跟设置" }, { v: "short", l: "短" }, { v: "medium", l: "中" }, { v: "long", l: "长" }, { v: "custom", l: "自定" }];
const STYLE_OPTS = [{ v: "free", l: "不约束" }, { v: "vars", l: "给主题变量" }, { v: "strict", l: "严格" }];
const MEM_OPTS = [{ v: "host", l: "跟宿主" }, { v: "recent", l: "最近 N 轮" }, { v: "none", l: "不带" }];
const WHO_OPTS = [{ v: "persona", l: "宿主人设" }, { v: "custom", l: "自定" }, { v: "observer", l: "旁观" }];

function newCombo() {
  const s = state.settings;
  return {
    name: "", tags: [], preambleId: state.preambles[0] ? state.preambles[0].id : "", promptIds: [],
    random: { count: 0, include: [], exclude: [] },
    output: { mode: "text", wrapTag: "", length: "default", customChars: 900, style: s.defaultStyle || "free", staged: !!s.stagedDefault },
    memory: { mode: s.defaultMemory || "host", rounds: Number(s.defaultRounds) || 12 },
    writeBack: !!s.writeBackDefault, who: s.defaultWho || "persona", whoText: "", rawChannel: false, weight: 2, useCount: 0, lastUsedAt: "",
  };
}
function field(label, control) { const w = el("div"); const l = el("label", "lb", label); w.append(l, control); return w; }
function input(value, ph) { const i = el("input", "inp"); i.value = value || ""; if (ph) i.placeholder = ph; return i; }
function textarea(value, rows, ph) { const t = el("textarea", "ta"); t.value = value || ""; t.rows = rows || 5; if (ph) t.placeholder = ph; return t; }
function select(options, value) { const s = el("select", "sel"); options.forEach(o => { const op = el("option", "", o.l); op.value = o.v; s.appendChild(op); }); s.value = value; return s; }
const allTags = list => [...new Set(list.flatMap(x => x.tags || []))];

const composeSaves = new WeakMap();
const library = {
  promptFilter: "全部",
  bind() {
    document.querySelectorAll("#lib-seg [data-lt]").forEach(b => { b.onclick = () => library.setTab(b.dataset.lt); });
    $("btn-new-combo").onclick = () => library.openCompose("");
    $("btn-new-prompt").onclick = () => library.editPrompt(null);
    $("btn-import-prompts").onclick = library.importPrompts;
    $("btn-new-random").onclick = () => library.editRandom(null);
    $("btn-new-macro").onclick = () => library.editMacro(null);
    $("btn-new-pre").onclick = () => library.editPreamble(null);
    viewHooks.library = tab => { if (tab) state.libTab = tab; library.render(); };
    viewHooks.compose = () => {};
  },
  setTab(t) { state.libTab = t; library.render(); },
  render() {
    document.querySelectorAll("#lib-seg [data-lt]").forEach(b => b.classList.toggle("on", b.dataset.lt === state.libTab));
    document.querySelectorAll(".lpane").forEach(p => p.classList.toggle("on", p.dataset.lpane === state.libTab));
    $("cnt-combo").textContent = state.combos.length; $("cnt-prompts").textContent = state.prompts.length;
    $("cnt-random").textContent = state.randoms.length + state.macros.length; $("cnt-pre").textContent = state.preambles.length;
    library.renderCombos(); library.renderPrompts(); library.renderRandoms(); library.renderPreambles();
  },

  // ── 组合列表 ──
  renderCombos() {
    const box = $("combo-list"); box.innerHTML = "";
    if (!state.combos.length) { box.appendChild(el("div", "empty", "还没有小剧场。下面「新建」，或去设置里导入。")); return; }
    const cur = state.settings.currentComboId;
    state.combos.forEach(c => {
      const card = el("div", "card" + (c.id === cur ? " sel" : ""));
      const t = el("div", "t"); t.appendChild(el("span", "grow", c.name));
      if (c.id === cur) t.appendChild(el("span", "badge", "当前"));
      if (c.rawChannel) t.appendChild(el("span", "badge", "纯裸"));
      card.appendChild(t);
      const chips = el("div", "chips");
      const pt = (c.promptIds || []).map(id => (byId(state.prompts, id) || {}).title).filter(Boolean);
      const chip = (k, v) => { const s = el("span", "chip"); s.appendChild(el("b", "", k)); s.appendChild(document.createTextNode(v)); chips.appendChild(s); };
      chip("提示词", pt.length ? `${pt.length} 条` : "无"); chip("随机", (c.random || {}).count ? `抽 ${c.random.count}` : "不抽");
      chip("输出", { html: "HTML", text: "纯文字", mixed: "组合" }[(c.output || {}).mode] || "纯文字"); chip("记忆", memoryLabel(c.memory));
      card.appendChild(chips);
      const foot = el("div", "foot");
      foot.appendChild(el("span", "", `${(c.tags || []).map(x => "#" + x).join(" ") || "无标签"} · 权重 ${c.weight ?? 1}`));
      foot.appendChild(el("span", "w", `${c.useCount || 0} 次${c.lastUsedAt ? " · " + fmtTime(c.lastUsedAt) : ""}`));
      card.appendChild(foot);
      card.onclick = () => library.openCompose(c.id);
      box.appendChild(card);
    });
  },

  // ── 编辑组合页 ──
  openCompose(id) {
    const src = id ? byId(state.combos, id) : null;
    const draft = src ? clone(src) : newCombo();
    if (!draft.random) draft.random = { count: 0, include: [], exclude: [] };
    if (!draft.output) draft.output = newCombo().output;
    if (!draft.memory) draft.memory = newCombo().memory;
    state.compose = draft;
    switchView("compose");
    library.renderCompose(draft, !!src);
  },
  renderCompose(d, exists) {
    const root = $("compose"); root.innerHTML = "";
    const bar = el("div", "cbar");
    const back = el("button", "", "‹ 返回"); back.type = "button"; back.onclick = () => switchView("library");
    bar.appendChild(back); bar.appendChild(el("span", "grow", exists ? "编辑小剧场" : "新建小剧场"));
    if (exists) { const exp = el("button", "small", "导出"); exp.type = "button"; exp.onclick = () => saveJsonFile(exportCombo(d), `小剧场-${d.name || "未命名"}.json`).catch(fail); bar.appendChild(exp); }
    root.appendChild(bar);

    const nameRow = el("div", "field"); nameRow.appendChild(el("label", "", "名字"));
    const nameIn = input(d.name, "比如：深夜便利店偶遇"); nameIn.oninput = () => { d.name = nameIn.value; }; nameRow.appendChild(nameIn); root.appendChild(nameRow);
    const tagRow = el("div", "field"); tagRow.appendChild(el("label", "", "标签")); tagRow.appendChild(tagInput(d.tags, t => { d.tags = t; })); root.appendChild(tagRow);

    const grp = (title, sub) => { const g = el("div", "grp"); const h = el("h3", "", title); if (sub) h.appendChild(el("span", "small", sub)); g.appendChild(h); root.appendChild(g); return g; };

    // 前置
    const g1 = grp("前置要求", "system 框架");
    const preSel = select(state.preambles.map(p => ({ v: p.id, l: p.name })), d.preambleId);
    preSel.onchange = () => { d.preambleId = preSel.value; }; g1.appendChild(preSel);

    // 提示词
    const g2 = grp("提示词", "按顺序拼进任务");
    const plist = el("div", "rows");
    const paintPrompts = () => {
      plist.innerHTML = "";
      if (!d.promptIds.length) plist.appendChild(el("div", "small hint", "还没选提示词。至少要一条，场景 / if 线 / 形式随意搭。"));
      d.promptIds.forEach((pid, i) => {
        const p = byId(state.prompts, pid); if (!p) return;
        const row = el("div", "entry pick2");
        const order = el("div", "order");
        const up = el("button", "", "▲"); up.type = "button"; up.disabled = i === 0; up.onclick = () => { [d.promptIds[i - 1], d.promptIds[i]] = [d.promptIds[i], d.promptIds[i - 1]]; paintPrompts(); };
        const dn = el("button", "", "▼"); dn.type = "button"; dn.disabled = i === d.promptIds.length - 1; dn.onclick = () => { [d.promptIds[i + 1], d.promptIds[i]] = [d.promptIds[i], d.promptIds[i + 1]]; paintPrompts(); };
        order.append(up, dn);
        const body = el("div", "grow"); body.appendChild(el("div", "et", p.title)); body.appendChild(el("div", "ex", (p.tags || []).map(t => "#" + t).join(" ")));
        const rm = el("button", "small", "移除"); rm.type = "button"; rm.onclick = () => { d.promptIds.splice(i, 1); paintPrompts(); };
        row.append(order, body, rm); plist.appendChild(row);
      });
    };
    paintPrompts(); g2.appendChild(plist);
    const addP = el("button", "fab ghost", "＋ 选提示词"); addP.type = "button"; addP.onclick = () => library.pickPrompts(d.promptIds, ids => { d.promptIds = ids; paintPrompts(); }); g2.appendChild(addP);

    // 随机
    const g3 = grp("随机附加", "每次生成从随机池抽");
    g3.appendChild(setRow("抽几条", `池里共 ${state.randoms.length} 条`, stepper(Number(d.random.count) || 0, 0, 5, v => { d.random.count = v; })));
    const tagsR = allTags(state.randoms);
    const pickTags = (label, key) => {
      const chips = el("div", "chips");
      if (!tagsR.length) chips.appendChild(el("span", "small", "随机池还没有标签"));
      tagsR.forEach(t => { const c = el("span", "chip" + ((d.random[key] || []).includes(t) ? " on" : ""), "#" + t); c.onclick = () => { const set = new Set(d.random[key] || []); set.has(t) ? set.delete(t) : set.add(t); d.random[key] = [...set]; c.classList.toggle("on", set.has(t)); }; chips.appendChild(c); });
      g3.appendChild(setRow(label, key === "include" ? "不选 = 全池" : "带这些标签的不抽", chips));
    };
    pickTags("只抽", "include"); pickTags("排除", "exclude");

    // 输出
    const g4 = grp("输出方式");
    g4.appendChild(setRow("形式", "HTML 由 AI 整段写", miniSeg(OUT_MODE, d.output.mode, v => { d.output.mode = v; styleRow.style.display = v === "text" ? "none" : ""; stagedRow.style.display = v === "html" ? "" : "none"; })));
    const wrapIn = input(d.output.wrapTag, "例如 theater，留空不包"); wrapIn.style.maxWidth = "150px"; wrapIn.oninput = () => { d.output.wrapTag = wrapIn.value.replace(/[^a-zA-Z0-9_-]/g, ""); };
    g4.appendChild(setRow("标签包裹", "只取标签内的内容", wrapIn));
    const customIn = input(String(d.output.customChars || 900), "字数"); customIn.type = "number"; customIn.style.maxWidth = "80px"; customIn.oninput = () => { d.output.customChars = Number(customIn.value) || 900; };
    const lenRow = setRow("篇幅", "", miniSeg(LEN_OPTS, d.output.length, v => { d.output.length = v; customRow.style.display = v === "custom" ? "" : "none"; }));
    const customRow = setRow("自定字数", "", customIn); customRow.style.display = d.output.length === "custom" ? "" : "none";
    g4.append(lenRow, customRow);
    const styleRow = setRow("HTML 风格", "严格 = 只准用主题色", miniSeg(STYLE_OPTS, d.output.style, v => { d.output.style = v; })); styleRow.style.display = d.output.mode === "text" ? "none" : "";
    g4.appendChild(styleRow);
    const stagedRow = setRow("分两步出", "先出页面骨架立刻显示，再往里填字；只对 HTML 生效", toggle(!!d.output.staged, v => { d.output.staged = v; })); stagedRow.style.display = d.output.mode === "html" ? "" : "none";
    g4.appendChild(stagedRow);

    // 记忆 / 身份
    const g5 = grp("记忆与身份");
    const roundsRow = setRow("带多少轮", "只算你和角色的正文", stepper(Number(d.memory.rounds) || 12, 1, 50, v => { d.memory.rounds = v; }));
    g5.appendChild(setRow("记忆", "跟宿主 = 用宿主的长期/核心记忆", miniSeg(MEM_OPTS, d.memory.mode, v => { d.memory.mode = v; roundsRow.style.display = v === "recent" ? "" : "none"; })));
    roundsRow.style.display = d.memory.mode === "recent" ? "" : "none"; g5.appendChild(roundsRow);
    g5.appendChild(setRow("写回记忆", "生成后存一条长期记忆", toggle(!!d.writeBack, v => { d.writeBack = v; })));
    const whoIn = textarea(d.whoText, 2, "比如：他多年未见的高中同桌，现在是便利店夜班店员"); const whoRow = el("div"); whoRow.appendChild(whoIn); whoRow.style.display = d.who === "custom" ? "" : "none"; whoIn.oninput = () => { d.whoText = whoIn.value; };
    g5.appendChild(setRow("我是谁", "", miniSeg(WHO_OPTS, d.who, v => { d.who = v; whoRow.style.display = v === "custom" ? "" : "none"; })));
    g5.appendChild(whoRow);

    // 高级
    const g6 = grp("高级");
    g6.appendChild(setRow("纯裸通道", "不走宿主预设，人设/世界书由 APP 自己拼", toggle(!!d.rawChannel, v => { d.rawChannel = v; })));
    g6.appendChild(setRow("随机权重", "「随机一篇」抽中的概率", stepper(Number(d.weight ?? 1), 0, 9, v => { d.weight = v; })));

    // 操作
    const btns = el("div", "btns"); btns.style.marginTop = "18px";
    if (exists) { const del = el("button", "warn", "删除"); del.type = "button"; del.onclick = () => confirmSheet("删除小剧场", `删除《${d.name}》？收藏里的记录不受影响。`, "删除", async () => { await remove("combos", d.id); if (state.settings.currentComboId === d.id) saveSettings({ currentComboId: state.combos[0] ? state.combos[0].id : "" }); switchView("library"); }, true); btns.appendChild(del); }
    const test = el("button", "", "保存并试生成"); test.type = "button"; test.onclick = async () => { const saved = await library.saveCompose(d); if (saved) { switchView("stage"); stage.run(saved); } };
    const save = el("button", "pri", "保存"); save.type = "button"; save.onclick = async () => { const saved = await library.saveCompose(d); if (saved) { toast("已保存"); switchView("library"); } };
    btns.append(test, save); root.appendChild(btns);
  },
  saveCompose(d) {
    if (composeSaves.has(d)) return composeSaves.get(d);
    const job = library.persistCompose(d); composeSaves.set(d, job);
    job.then(() => composeSaves.delete(d), () => composeSaves.delete(d));
    return job;
  },
  async persistCompose(d) {
    d.name = String(d.name || "").trim();
    if (!d.name) { toast("给小剧场起个名字"); return null; }
    if (!d.promptIds.length) { toast("至少选一条提示词"); return null; }
    try {
      const { useCount, lastUsedAt, plays, ...patch } = d;
      const saved = await upsert("combos", patch);
      d.id = saved.id;
      if (!state.settings.currentComboId || !byId(state.combos, state.settings.currentComboId)) saveSettings({ currentComboId: saved.id });
      return saved;
    } catch (e) { fail(e); return null; }
  },
  pickPrompts(selected, onDone) {
    const set = new Set(selected); let q = ""; let tag = "全部";
    openSheet("选提示词", box => {
      const search = input("", "搜标题 / 内容"); search.className = "inp search"; box.appendChild(search);
      const chips = el("div", "chips filters"); box.appendChild(chips);
      const list = el("div", "rows"); box.appendChild(list);
      const paint = () => {
        chips.innerHTML = ""; ["全部", ...allTags(state.prompts)].forEach(t => { const c = el("span", "chip" + (tag === t ? " on" : ""), t); c.onclick = () => { tag = t; paint(); }; chips.appendChild(c); });
        list.innerHTML = "";
        const shown = state.prompts.filter(p => (tag === "全部" || (p.tags || []).includes(tag)) && (!q || (p.title + p.content).toLowerCase().includes(q)));
        if (!shown.length) list.appendChild(el("div", "empty", "没有匹配的提示词"));
        shown.forEach(p => {
          const row = el("div", "pickrow" + (set.has(p.id) ? " on" : ""));
          const body = el("div", "grow"); body.appendChild(el("div", "et", p.title)); body.appendChild(el("div", "ex", (p.tags || []).map(t => "#" + t).join(" ") + " · " + p.content.slice(0, 40)));
          row.append(el("span", "cb"), body);
          row.onclick = () => { set.has(p.id) ? set.delete(p.id) : set.add(p.id); row.classList.toggle("on", set.has(p.id)); };
          list.appendChild(row);
        });
      };
      search.oninput = () => { q = search.value.trim().toLowerCase(); paint(); };
      paint();
      const btns = el("div", "btns"); const ok = el("button", "pri", "确定"); ok.type = "button";
      ok.onclick = () => { const kept = selected.filter(id => set.has(id)); const added = [...set].filter(id => !kept.includes(id)); closeSheet(); onDone([...kept, ...added]); };
      btns.appendChild(ok); box.appendChild(btns);
    });
  },

  // ── 提示词 ──
  renderPrompts() {
    const filters = $("prompt-filters"); filters.innerHTML = "";
    const tags = ["全部", ...allTags(state.prompts)];
    if (!tags.includes(library.promptFilter)) library.promptFilter = "全部";
    tags.forEach(t => { const c = el("span", "chip" + (library.promptFilter === t ? " on" : ""), t); c.onclick = () => { library.promptFilter = t; library.renderPrompts(); }; filters.appendChild(c); });
    const box = $("prompt-list"); box.innerHTML = "";
    const shown = state.prompts.filter(p => library.promptFilter === "全部" || (p.tags || []).includes(library.promptFilter));
    if (!shown.length) { box.appendChild(el("div", "empty", "空的。新增一条，或批量导入。")); return; }
    shown.forEach(p => box.appendChild(library.entry(p.title, p.content, p.tags, () => library.editPrompt(p))));
  },
  entry(title, content, tags, onClick) {
    const row = el("div", "entry");
    const body = el("div", "grow"); body.appendChild(el("div", "et", title)); body.appendChild(el("div", "ex", content));
    const tg = el("div", "tags"); (tags || []).slice(0, 3).forEach(t => tg.appendChild(el("span", "tag", t)));
    row.append(body, tg); row.onclick = onClick; return row;
  },
  editPrompt(p) {
    const d = p ? clone(p) : { title: "", tags: [], content: "" };
    openSheet(p ? "编辑提示词" : "新增提示词", box => {
      const f = el("div", "frm");
      const title = input(d.title, "标题"); title.oninput = () => { d.title = title.value; };
      f.appendChild(field("标题", title));
      f.appendChild(field("标签（场景 / if 线 / 形式 / 文字 / 前端 …）", tagInput(d.tags, t => { d.tags = t; })));
      const ta = textarea(d.content, 9, "支持宏：{{user}} {{char}} {{篇幅}} {{random::a::b}} {{roll:1d6}} {{随机词:世界}} {{随机数:好感}}"); ta.oninput = () => { d.content = ta.value; };
      f.appendChild(field("内容", ta));
      box.appendChild(f);
      box.appendChild(library.sheetButtons(p, async () => {
        if (!d.title.trim() || !d.content.trim()) { toast("标题和内容都要填"); return; }
        await upsert("prompts", d); closeSheet(); library.render();
      }, async () => {
        const used = state.combos.filter(c => (c.promptIds || []).includes(p.id)).map(c => c.name);
        confirmSheet("删除提示词", used.length ? `《${p.title}》正被 ${used.join("、")} 使用，删除后它们会少一条任务。继续？` : `删除《${p.title}》？`, "删除", async () => {
          await remove("prompts", p.id);
          for (const c of state.combos) if ((c.promptIds || []).includes(p.id)) await upsert("combos", { id: c.id, promptIds: c.promptIds.filter(x => x !== p.id) });
          library.render();
        }, true);
      }));
    });
  },
  sheetButtons(existing, onSave, onDelete) {
    const btns = el("div", "btns");
    if (existing) { const del = el("button", "warn", "删除"); del.type = "button"; del.onclick = onDelete; btns.appendChild(del); }
    const cancel = el("button", "", "取消"); cancel.type = "button"; cancel.onclick = closeSheet;
    const save = el("button", "pri", "保存"); save.type = "button"; save.onclick = () => onSave().catch(fail);
    btns.append(cancel, save); return btns;
  },
  importPrompts() {
    openSheet("批量导入提示词", box => {
      box.appendChild(el("p", "note-box", "两种来源：① 粘贴文本，每条用一行「## 标题 #标签 #标签」开头，下面是内容；② 选一个 JSON 文件：本 APP 导出的、暗柜「夜间档案」直接进库，其它格式（酒馆预设、角色卡、别人的生成器）会把里面像提示词的段落列出来让你挑。"));
      const ta = textarea("", 8, "## 雨夜便利店 #场景 #日常\n写{{char}}在深夜便利店……\n\n## 弹幕流 #形式 #前端\n输出一段带弹幕滚动的 HTML……"); box.appendChild(ta);
      const btns = el("div", "btns");
      const file = el("button", "", "选 JSON 文件"); file.type = "button"; file.onclick = async () => {
        try { const data = await pickJsonFile(); const n = await library.importAny(data); closeSheet(); library.render(); toast(n ? `导入 ${n} 条` : "没有导入"); } catch (e) { fail(e); }
      };
      const ok = el("button", "pri", "导入文本"); ok.type = "button"; ok.onclick = async () => {
        const blocks = ta.value.split(/^##\s*/m).map(s => s.trim()).filter(Boolean); let n = 0;
        for (const b of blocks) {
          const nl = b.indexOf("\n"); const head = nl < 0 ? b : b.slice(0, nl); const content = nl < 0 ? "" : b.slice(nl + 1).trim();
          const tags = [...head.matchAll(/#(\S+)/g)].map(m => m[1]); const title = head.replace(/#\S+/g, "").trim();
          if (!title || !content) continue;
          await upsert("prompts", { title, tags, content }); n++;
        }
        closeSheet(); library.render(); toast(n ? `导入 ${n} 条` : "没解析到内容，检查「## 标题」格式");
      };
      btns.append(file, ok); box.appendChild(btns);
    });
  },
  async importAny(data) {
    if (data && data.app === "float.xiaojuchang") return importBundle(data);
    if (data && (data.aiInstruction || (data.templateSnapshot && data.templateSnapshot.aiInstruction))) { await importBlackMarketTheater(data); return 1; }
    if (Array.isArray(data)) { let n = 0; for (const t of data) { if (t && (t.aiInstruction || (t.templateSnapshot && t.templateSnapshot.aiInstruction))) { await importBlackMarketTheater(t); n++; } else if (t && t.title && t.content) { await upsert("prompts", { title: String(t.title), tags: Array.isArray(t.tags) ? t.tags : [], content: String(t.content) }); n++; } } return n; }
    if (data && Array.isArray(data.theaters)) { let n = 0; for (const t of data.theaters) { await importBlackMarketTheater(t); n++; } return n; }
    const found = scanLooseJson(data);
    if (!found.length) throw new Error("这个 JSON 里没找到像提示词的段落。");
    return library.pickLoose(found);
  },
  /** 没认出格式的 JSON：列出扫到的段落，勾选后按所选类型入库。取消时返回 0 */
  pickLoose(found) {
    return new Promise(resolve => {
      let done = false; const finish = n => { if (!done) { done = true; resolve(n); } };
      const set = new Set(); let target = "prompts", tags = [], q = "";
      openSheet("从 JSON 里挑", box => {
        box.appendChild(el("p", "note-box", `没认出这个格式，把里面像提示词的 ${found.length} 段列出来了。点一条勾上，点正文能展开看全文。`));
        const top = el("div", "row loose-top");
        const seg = miniSeg([{ v: "prompts", l: "导为提示词" }, { v: "preambles", l: "前置要求" }, { v: "randoms", l: "随机条目" }], target, v => { target = v; tagBox.style.display = v === "preambles" ? "none" : ""; });
        const all = el("button", "small-btn", "全选"); all.type = "button";
        all.onclick = () => { const shown = visible(); const every = shown.every(c => set.has(c)); shown.forEach(c => every ? set.delete(c) : set.add(c)); paint(); };
        top.append(seg, el("span", "grow"), all); box.appendChild(top);
        const tagBox = field("统一加标签（可空）", tagInput(tags, t => { tags = t; })); box.appendChild(tagBox);
        let search = null;
        if (found.length > 8) { search = input("", "搜名字 / 内容"); search.className = "inp search"; search.oninput = () => { q = search.value.trim().toLowerCase(); paint(); }; box.appendChild(search); }
        const list = el("div", "rows"); box.appendChild(list);
        const visible = () => found.filter(c => !q || (c.name + c.content).toLowerCase().includes(q));
        const btns = el("div", "btns");
        const cancel = el("button", "", "取消"); cancel.type = "button"; cancel.onclick = closeSheet;
        const ok = el("button", "pri", "导入"); ok.type = "button";
        const paintOk = () => { ok.textContent = set.size ? `导入 ${set.size} 条` : "导入"; ok.disabled = !set.size; };
        const paint = () => {
          list.innerHTML = "";
          const shown = visible();
          if (!shown.length) list.appendChild(el("div", "empty", "没有匹配的段落"));
          shown.forEach(c => {
            const row = el("div", "pickrow" + (set.has(c) ? " on" : ""));
            const body = el("div", "grow"); body.appendChild(el("div", "et", c.name));
            const ex = el("div", "ex", c.content); body.appendChild(ex);
            body.appendChild(el("div", "path", c.path));
            ex.onclick = e => { e.stopPropagation(); ex.classList.toggle("full"); };
            row.append(el("span", "cb"), body);
            row.onclick = () => { set.has(c) ? set.delete(c) : set.add(c); row.classList.toggle("on", set.has(c)); paintOk(); };
            list.appendChild(row);
          });
          paintOk();
        };
        paint();
        ok.onclick = async () => {
          const picked = found.filter(c => set.has(c)); if (!picked.length) return;
          ok.disabled = true;
          try {
            let n = 0;
            for (const c of picked) {
              if (target === "preambles") await upsert("preambles", { name: c.name, content: c.content });
              else await upsert(target, { title: c.name, tags: [...tags], content: c.content });
              n++;
            }
            finish(n); closeSheet();
          } catch (e) { fail(e); ok.disabled = false; }
        };
        btns.append(cancel, ok); box.appendChild(btns);
      }, () => finish(0));
    });
  },

  // ── 随机池 + 宏 ──
  renderRandoms() {
    const box = $("random-list"); box.innerHTML = "";
    if (!state.randoms.length) box.appendChild(el("div", "empty", "随机池是空的"));
    state.randoms.forEach(r => box.appendChild(library.entry(r.title, r.content, r.tags, () => library.editRandom(r))));
    const mb = $("macro-list"); mb.innerHTML = "";
    if (!state.macros.length) mb.appendChild(el("div", "empty", "还没有宏"));
    state.macros.forEach(m => {
      const desc = m.kind === "number" ? `{{随机数:${m.name}}} → ${m.min}～${m.max}` : `{{随机词:${m.name}}} → ${(m.values || []).length} 个词：${(m.values || []).slice(0, 6).join("、")}${(m.values || []).length > 6 ? "…" : ""}`;
      mb.appendChild(library.entry(m.name, desc, [m.kind === "number" ? "数字" : "词"], () => library.editMacro(m)));
    });
  },
  editRandom(r) {
    const d = r ? clone(r) : { title: "", tags: [], content: "" };
    openSheet(r ? "编辑随机条目" : "新增随机条目", box => {
      const f = el("div", "frm");
      const title = input(d.title, "标题"); title.oninput = () => { d.title = title.value; }; f.appendChild(field("标题", title));
      f.appendChild(field("标签（小剧场里按标签只抽 / 排除）", tagInput(d.tags, t => { d.tags = t; })));
      const ta = textarea(d.content, 6, "抽中时追加到任务里的一句话"); ta.oninput = () => { d.content = ta.value; }; f.appendChild(field("内容", ta));
      box.appendChild(f);
      box.appendChild(library.sheetButtons(r, async () => { if (!d.title.trim() || !d.content.trim()) { toast("标题和内容都要填"); return; } await upsert("randoms", d); closeSheet(); library.render(); },
        () => confirmSheet("删除随机条目", `删除《${r.title}》？`, "删除", async () => { await remove("randoms", r.id); library.render(); }, true)));
    });
  },
  editMacro(m) {
    const d = m ? clone(m) : { name: "", kind: "words", values: [], min: 1, max: 6 };
    openSheet(m ? "编辑宏" : "新增宏", box => {
      const f = el("div", "frm");
      const name = input(d.name, "名字，比如 世界"); name.oninput = () => { d.name = name.value.trim(); }; f.appendChild(field("名字（提示词里写 {{随机词:名字}} 或 {{随机数:名字}}）", name));
      const wordsBox = el("div"); const numBox = el("div", "two");
      const ta = textarea((d.values || []).join("\n"), 7, "一行一个词"); ta.oninput = () => { d.values = ta.value.split(/\n/).map(s => s.trim()).filter(Boolean); }; wordsBox.appendChild(field("词表", ta));
      const mn = input(String(d.min ?? 1)); mn.type = "number"; mn.oninput = () => { d.min = Number(mn.value) || 0; }; const mx = input(String(d.max ?? 6)); mx.type = "number"; mx.oninput = () => { d.max = Number(mx.value) || 0; };
      numBox.append(field("最小", mn), field("最大", mx));
      const paint = () => { wordsBox.style.display = d.kind === "words" ? "" : "none"; numBox.style.display = d.kind === "number" ? "" : "none"; };
      f.appendChild(field("类型", miniSeg([{ v: "words", l: "词表" }, { v: "number", l: "数字范围" }], d.kind, v => { d.kind = v; paint(); })));
      f.append(wordsBox, numBox); paint(); box.appendChild(f);
      box.appendChild(library.sheetButtons(m, async () => {
        if (!d.name) { toast("宏要有名字"); return; }
        if (d.kind === "words" && !(d.values || []).length) { toast("词表至少一个词"); return; }
        await upsert("macros", d); closeSheet(); library.render();
      }, () => confirmSheet("删除宏", `删除「${m.name}」？用到它的提示词会原样输出宏文本。`, "删除", async () => { await remove("macros", m.id); library.render(); }, true)));
    });
  },

  // ── 前置要求 ──
  renderPreambles() {
    const box = $("pre-list"); box.innerHTML = "";
    state.preambles.forEach(p => {
      const used = state.combos.filter(c => c.preambleId === p.id).length;
      box.appendChild(library.entry(p.name, p.content, used ? [`${used} 个小剧场在用`] : [], () => library.editPreamble(p)));
    });
  },
  editPreamble(p) {
    const d = p ? clone(p) : { name: "", content: "" };
    openSheet(p ? "编辑前置要求" : "新增前置要求", box => {
      const f = el("div", "frm");
      const name = input(d.name, "名字"); name.oninput = () => { d.name = name.value; }; f.appendChild(field("名字", name));
      const ta = textarea(d.content, 12, "整段 system 级别的框架说明。默认链路里它排在人设 / 世界书 / 记忆之后；纯裸通道里它就是整个 system。"); ta.oninput = () => { d.content = ta.value; }; f.appendChild(field("内容", ta));
      box.appendChild(f);
      box.appendChild(library.sheetButtons(p, async () => { if (!d.name.trim() || !d.content.trim()) { toast("名字和内容都要填"); return; } delete d.builtin; await upsert("preambles", d); closeSheet(); library.render(); },
        () => {
          if (state.preambles.length <= 1) { toast("至少留一条前置要求"); return; }
          confirmSheet("删除前置要求", `删除「${p.name}」？用它的小剧场会改用第一条。`, "删除", async () => {
            await remove("preambles", p.id); const fb = state.preambles[0].id;
            for (const c of state.combos) if (c.preambleId === p.id) await upsert("combos", { id: c.id, preambleId: fb });
            library.render();
          }, true);
        }));
    });
  },
};
