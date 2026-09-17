// ── 收藏：roll 到喜欢的存下来，连同当时的配置 ──
const favorites = {
  filter: "all", openId: "",
  bind() { viewHooks.fav = () => favorites.render(); },
  render() {
    const list = [...state.favorites].sort((a, b) => String(b.favoritedAt || b.createdAt).localeCompare(String(a.favoritedAt || a.createdAt)));
    const filters = $("fav-filters"); filters.innerHTML = "";
    const chars = [...new Set(list.map(r => r.characterId))].map(id => ({ id, name: (list.find(r => r.characterId === id) || {}).characterName || "?" }));
    const opts = [{ v: "all", l: `全部 ${list.length}` }, ...chars.map(c => ({ v: `c:${c.id}`, l: `${c.name} ${list.filter(r => r.characterId === c.id).length}` })), { v: "html", l: `前端型 ${list.filter(r => kindOf(r) !== "text").length}` }];
    opts.forEach(o => { const s = el("span", "chip" + (favorites.filter === o.v ? " on" : ""), o.l); s.onclick = () => { favorites.filter = o.v; favorites.render(); }; filters.appendChild(s); });
    const box = $("fav-list"); box.innerHTML = "";
    const shown = list.filter(r => favorites.filter === "all" ? true : favorites.filter === "html" ? kindOf(r) !== "text" : r.characterId === favorites.filter.slice(2));
    if (!shown.length) { box.appendChild(el("div", "empty", "还没有收藏。舞台页结果下面点「收藏」。")); return; }
    shown.forEach(r => {
      const item = el("div", "fav-item" + (favorites.openId === r.id ? " open" : ""));
      const t = el("div", "t", r.title || r.comboName || "无题"); if (kindOf(r) !== "text") { t.appendChild(document.createTextNode(" ")); t.appendChild(el("span", "badge", KIND_LABEL[kindOf(r)].replace("型", ""))); }
      item.appendChild(t);
      item.appendChild(el("div", "who", [r.characterName, r.comboName, fmtFull(r.createdAt)].filter(Boolean).join(" · ")));
      if (favorites.openId === r.id) {
        const s = r.snapshot || {};
        const dl = el("dl", "info");
        const kv = (k, v) => { if (!v) return; dl.appendChild(el("dt", "", k)); dl.appendChild(el("dd", "", v)); };
        kv("前置", s.preambleName); kv("提示词", (s.prompts || []).join(" · ")); kv("随机", (s.randoms || []).join(" · ")); kv("追加", s.extra);
        kv("输出", `${{ html: "HTML", text: "纯文字", mixed: "组合" }[(s.output || {}).mode] || "纯文字"}${(s.output || {}).wrapTag ? " · <" + s.output.wrapTag + ">" : ""} · ${s.length || ""}`);
        kv("记忆", memoryLabel(s.memory) + (s.rawChannel ? " · 纯裸通道" : "")); kv("我是谁", { persona: "宿主用户人设", custom: "自定身份", observer: "旁观" }[s.who] || ""); kv("模型", r.model);
        item.appendChild(dl);
        const ops = el("div", "ops");
        const mk = (l, fn) => { const b = el("button", "", l); b.type = "button"; b.onclick = e => { e.stopPropagation(); fn(); }; ops.appendChild(b); };
        mk("打开", () => openFullscreen(r, stage.handlers()));
        mk("放到舞台", () => { stage.showResult(r); switchView("stage"); });
        mk("按这套再来一条", () => { const c = stage.comboOf(r); if (!c) { toast("配置已丢失"); return; } switchView("stage"); stage.run(c); });
        mk("删除", () => confirmSheet("删除收藏", `删除《${r.title || r.comboName || "这条"}》？不可恢复。`, "删除", async () => { await remove("favorites", r.id); favorites.render(); }, true));
        item.appendChild(ops);
      }
      item.onclick = () => { favorites.openId = favorites.openId === r.id ? "" : r.id; favorites.render(); };
      box.appendChild(item);
    });
  },
};
