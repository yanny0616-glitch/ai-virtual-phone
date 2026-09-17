// ── 生成装配：组合 → 前置 + <Brief> → ai.generate（白名单只放人设/世界书/记忆）或 ai.chat 纯裸通道 → 切段 ──
const WHITELIST_BASE = ["charDescription", "charPersonality", "characterRelations", "worldInfoBefore", "worldInfoAfter"];
const WHITELIST_PERSONA = ["personaDescription"];
const WHITELIST_MEMORY = ["memoryCore", "memoryLongTerm", "shortTermMemory"];
const STYLE_HINT = {
  free: "",
  vars: "样式提示：页面外层已定义 CSS 变量 --xjc-bg（底色）--xjc-ink（文字）--xjc-acc（强调色）--xjc-line（细线）--xjc-font（字体），优先使用它们，让画面和 APP 主题协调；其余自由发挥。",
  strict: "样式约束：颜色只能使用 CSS 变量 --xjc-bg --xjc-ink --xjc-acc --xjc-line（可用 color-mix 或透明度派生），字体只用 --xjc-font；不得自带其他颜色值。",
};

// 组合快照带上可重放的依赖；随机池保留候选，重放时仍重新抽取。
function captureCombo(combo) {
  const copy = clone(combo);
  if (!copy._dependencies) {
    copy._dependencies = clone({
      preamble: byId(state.preambles, combo.preambleId) || state.preambles[0] || null,
      prompts: (combo.promptIds || []).map(id => byId(state.prompts, id)).filter(Boolean),
      randoms: state.randoms, macros: state.macros,
      length: resolveLength(combo),
    });
  }
  return copy;
}
function comboPrompts(combo) {
  return [...(combo._virtualPrompts || []), ...(combo._dependencies
    ? combo._dependencies.prompts : (combo.promptIds || []).map(id => byId(state.prompts, id)).filter(Boolean))];
}
function comboPreamble(combo) {
  return combo._dependencies ? combo._dependencies.preamble : byId(state.preambles, combo.preambleId) || state.preambles[0];
}

function macroCtx(combo, character = state.character, userName = state.userName) {
  const len = resolveLength(combo);
  return { user: userName, char: charName(character), length: len ? `约 ${len.chars} 字` : "篇幅不限", macros: combo._dependencies ? combo._dependencies.macros : state.macros };
}
function resolveLength(combo) {
  if (combo._dependencies) return combo._dependencies.length;
  const o = combo.output || {};
  if (o.length === "custom") return { chars: Math.max(50, Number(o.customChars) || 900), label: "自定" };
  if (o.length && o.length !== "default") return { chars: LENGTH_CHARS[o.length] || 900, label: LENGTH_LABEL[o.length] };
  if (!state.settings.lengthLimit) return null;
  const k = state.settings.defaultLength || "medium";
  return { chars: LENGTH_CHARS[k] || 900, label: LENGTH_LABEL[k] };
}
function drawRandoms(combo) {
  const rule = combo.random || {}; const n = Math.max(0, Number(rule.count) || 0);
  if (!n) return [];
  const inc = new Set(rule.include || []), exc = new Set(rule.exclude || []);
  const randoms = combo._dependencies ? combo._dependencies.randoms : state.randoms;
  let pool = randoms.filter(r => { const tags = r.tags || []; if (tags.some(t => exc.has(t))) return false; if (inc.size && !tags.some(t => inc.has(t))) return false; return true; });
  if (!pool.length) pool = randoms.filter(r => !(r.tags || []).some(t => exc.has(t)));
  return shuffle(pool).slice(0, n);
}

/** 返回 { tasks, snapshot } —— tasks 是 <Brief> 全文，snapshot 记下这次用了什么 */
function buildTasks(combo, extra, character = state.character, userName = state.userName, phase = null) {
  const ctx = macroCtx(combo, character, userName);
  const prompts = comboPrompts(combo);
  const randoms = phase && phase.randoms ? phase.randoms : drawRandoms(combo);
  const len = resolveLength(combo);
  const o = combo.output || {};
  const lines = ["<Brief>"];
  const who = combo.who || "persona";
  if (who === "persona") lines.push(`【身份】故事里的「${ctx.user}」就是用户本人，沿用前面给出的用户人设。`);
  else if (who === "custom") lines.push(`【身份】用户在这篇里的身份：${expandMacros(combo.whoText || "", ctx) || "由你根据场景安排"}。忽略前面的用户人设。`);
  else lines.push(`【身份】用户不出场，只作为旁观者阅读。全篇不要出现「${ctx.user}」这个人，重点写 ${ctx.char} 与其他人。`);
  let i = 1;
  for (const p of prompts) lines.push(`【任务 ${i++} · ${p.title}】${expandMacros(p.content, ctx)}`);
  for (const r of randoms) lines.push(`【随机附加 · ${r.title}】${expandMacros(r.content, ctx)}`);
  if (extra) lines.push(`【本次追加】${expandMacros(extra, ctx)}`);
  const out = [];
  const kind = phase && phase.kind;
  if (kind === "shell") {
    out.push("这一步只做页面骨架，不写正文。输出一段完整可渲染的 HTML（含 style 与 script），把所有将来要放文字的位置用空的占位元素标出来：<span data-slot=\"1\" data-hint=\"这里放什么、大约多少字\"></span>，编号从 1 递增，占位元素内部留空、不要嵌套占位。栏目名、用户名、时间戳、按钮文字这类界面文字直接写死。占位数量按内容需要，通常 5～40 个。不要 markdown 围栏、不要任何 HTML 之外的说明文字。 " + MOBILE_HTML_RULES);
    if (STYLE_HINT[o.style]) out.push(STYLE_HINT[o.style]);
    out.push("给这一篇起一个不超过 12 字的标题，放在最前面一行，格式：标题：xxx");
  } else if (kind === "fill") {
    lines.push(`【骨架】页面骨架已经定稿，下面是它的文字脉络，[[编号]] 就是要你填的位置：\n${phase.outline}`);
    lines.push(`【占位清单】\n${phase.slots.map(x => `[[${x.n}]] ${x.hint || "正文"}`).join("\n")}`);
    out.push("只输出各占位的文字。格式严格：每段以单独一行 [[编号]] 开头，从下一行起是该处的文字，可用 <br> 换行，不要任何其它 HTML、不要 markdown、不要解释；每个编号都要给到，按编号顺序，不要多不要少。");
    if (len) out.push(`全部占位的文字合计约 ${len.chars} 字。`);
  } else {
    if (o.mode === "html") out.push("整体输出为一段 HTML（不要 markdown 围栏、不要任何 HTML 之外的说明文字）。" + (prompts.some(p => (p.tags || []).includes("前端")) ? "" : " " + MOBILE_HTML_RULES));
    else if (o.mode === "mixed") out.push("允许 HTML 与纯文字混排：HTML 部分用 ```html 围栏包裹，文字部分直接写；两者之间空一行。" + " " + MOBILE_HTML_RULES);
    else out.push("只输出纯文字正文，不要 HTML、不要 markdown 标题、不要代码块。");
    if (len) out.push(`篇幅约 ${len.chars} 字（HTML 里只算可见文字）。`);
    if (o.wrapTag) out.push(`把全部输出包在 <${o.wrapTag}></${o.wrapTag}> 标签内，标签外不要有任何内容。`);
    if (o.mode !== "text" && STYLE_HINT[o.style]) out.push(STYLE_HINT[o.style]);
    out.push("给这一篇起一个不超过 12 字的标题，放在最前面一行，格式：标题：xxx");
  }
  lines.push(`【输出要求】${out.join(" ")}`);
  lines.push("</Brief>");
  return {
    tasks: lines.join("\n"), randoms,
    snapshot: {
      comboId: combo.id || "", comboName: combo.name, preambleName: (comboPreamble(combo) || {}).name || "",
      prompts: prompts.map(p => p.title), randoms: randoms.map(r => r.title), who, output: { ...o }, length: len ? `${len.label} · 约 ${len.chars} 字` : "不限",
      memory: { ...(combo.memory || {}) }, rawChannel: !!combo.rawChannel, extra: extra || "", staged: kind === "shell",
    },
  };
}

// ── 分两步出：第一步骨架带 data-slot 占位，第二步按编号填字。占位是我们指定的空叶子元素，正则够用 ──
const SLOT_RE = /<([a-zA-Z][\w-]*)\b([^>]*?\sdata-slot="(\d+)"[^>]*)>([\s\S]*?)<\/\1>/g;
function extractSlots(html) {
  const slots = [], seen = new Set();
  for (const m of html.matchAll(SLOT_RE)) {
    const n = m[3]; if (seen.has(n)) continue; seen.add(n);
    const hint = (m[2].match(/data-hint="([^"]*)"/) || [])[1] || "";
    slots.push({ n, hint: hint.replace(/&quot;/g, '"').trim() });
  }
  const outline = html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(SLOT_RE, " [[$3]] ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section|article|header|footer)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, 4000);
  return { slots, outline };
}
function parseFill(text) {
  const map = {};
  const body = String(text).replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "").replace(/```[a-z]*\n?|```/g, "");
  for (const m of body.matchAll(/\[\[(\d+)\]\]\s*([\s\S]*?)(?=\n\s*\[\[\d+\]\]|$)/g)) { const t = m[2].trim(); if (t) map[m[1]] = t; }
  return map;
}
const slotHtml = text => esc(text).replace(/&lt;br\s*\/?&gt;/gi, "<br>").replace(/\n/g, "<br>");
function fillSlots(html, map) {
  return html.replace(SLOT_RE, (whole, tag, attrs, n, inner) => map[n] ? `<${tag}${attrs}>${slotHtml(map[n])}</${tag}>` : whole);
}

function includeList(combo) {
  const list = [...WHITELIST_BASE];
  if ((combo.who || "persona") === "persona") list.push(...WHITELIST_PERSONA);
  if ((combo.memory || {}).mode === "host") list.push(...WHITELIST_MEMORY);
  return list;
}

async function recentHistory(characterId, rounds) {
  const target = Math.max(1, Math.min(50, Number(rounds) || 12)) * 2;
  let before = "", history = [];
  const cursors = new Set();
  while (history.length < target) {
    let res;
    try { res = await api.chat.readHistory({ characterId, sessionId: "", limit: 200, before }); }
    catch (e) { if (String(e && e.message).includes("chat.readHistory 找不到会话")) return []; throw e; }
    if (res && res.characterId && res.characterId !== characterId) throw new Error("聊天记录与当前角色不一致。");
    const msgs = (res && res.messages) || [];
    const eligible = msgs.filter(m => !m.isRetracted && (m.role === "user" || m.role === "assistant") && m.content && !String(m.mediaType || "").startsWith("app_"));
    history = [...eligible, ...history];
    if (msgs.length < 200 || history.length >= target) break;
    const cursor = msgs[0] && msgs[0].id;
    if (!cursor || cursors.has(cursor)) throw new Error("宿主未能继续读取聊天记录，请更新宿主。");
    cursors.add(cursor); before = cursor;
  }
  return history.slice(-target).map(m => ({ role: m.role, content: String(m.content).slice(0, 4000), createdAt: m.createdAt }));
}
function historyText(history, character, userName) {
  if (!history.length) return "";
  return "<RecentChat>\n" + history.map(m => `${m.role === "user" ? userName : character.name}：${m.content}`).join("\n") + "\n</RecentChat>";
}
async function refreshUserName(character) {
  if (!character) return;
  const profile = await api.user.getProfile({ characterId: character.id });
  if (state.character && state.character.id === character.id) state.userName = (profile && profile.name) || "用户";
  return profile;
}

async function rawContext(character, history, userName, persona, memories) {
  const parts = [];
  parts.push("<CharacterSheet>", `角色：${character.name}`, character.persona ? `设定：${character.persona}` : "", character.personality ? `性格：${character.personality}` : "", "</CharacterSheet>");
  const wb = character.embeddedWorldBook;
  if (wb && Array.isArray(wb.entries) && wb.entries.length) {
    parts.push("<WorldNotes>");
    for (const e of wb.entries.slice(0, 60)) { if (e && !e.disable && e.content) parts.push(`- ${(e.comment || (Array.isArray(e.key) ? e.key.join("/") : e.key) || "")}：${e.content}`); }
    parts.push("</WorldNotes>");
  }
  if (persona && persona.text) parts.push("<UserPersona>", persona.text, "</UserPersona>");
  if (memories) for (const [tag, value] of Object.entries(memories)) if (value && value.text) parts.push(`<${tag}>`, value.text, `</${tag}>`);
  parts.push(historyText(history, character, userName));
  return parts.filter(Boolean).join("\n");
}

/** 主入口：返回 { raw, title, segments, snapshot, model } */
async function generateTheater(combo, opts) {
  const character = (opts && opts.character) || state.character;
  if (!character) throw new Error("先选一个角色。");
  combo = captureCombo(combo);
  const profile = await api.user.getProfile({ characterId: character.id });
  const userName = (profile && profile.name) || "用户";
  const pre = comboPreamble(combo);
  const preamble = pre ? expandMacros(pre.content, macroCtx(combo, character, userName)) : "";
  const mem = combo.memory || { mode: "host", rounds: 12 };
  const history = mem.mode === "recent" ? await recentHistory(character.id, mem.rounds) : [];
  let rawCtx = null;
  if (combo.rawChannel) {
    const full = await api.characters.get(character.id).catch(() => character);
    const query = { characterId: character.id, sessionId: "" };
    const persona = (combo.who || "persona") === "persona" ? await api.user.getPersona(query) : null;
    let memories = null;
    if (mem.mode === "host") {
      const [core, long, short] = await Promise.all([api.memory.readCore(query), api.memory.readLongTerm(query), api.memory.readShortTerm(query)]);
      memories = { memoryCore: core, memoryLongTerm: long, shortTermMemory: short };
    }
    rawCtx = await rawContext(full || character, history, userName, persona, memories);
  }
  const cancelled = () => !!(opts && opts.isCancelled && opts.isCancelled());
  // 宿主流式：有 onStream 才带第二个参数；老宿主会忽略它，照旧一次性返回
  const stream = (kind, snapshot) => opts && opts.onStream ? { onChunk: info => { if (cancelled()) return; const text = previewText(info && info.text); opts.onStream(kind === "fill" ? { kind, text, snapshot, fill: parseFill(text) } : { kind, text, snapshot }); } } : undefined;
  const call = async (tasks, handlers) => {
    if (combo.rawChannel) {
      const res = await api.ai.chat({ characterId: character.id, messages: [
        { role: "system", content: preamble || "只输出 <Brief> 要求的内容。" },
        { role: "user", content: `${rawCtx}\n\n${tasks}` },
      ] }, handlers);
      return { raw: (res && res.text) || "", model: "" };
    }
    const res = await api.ai.generate({
      characterId: character.id,
      instruction: [preamble, historyText(history, character, userName), tasks].filter(Boolean).join("\n\n"),
      messages: [],
      historyLimit: Math.max(1, Math.min(50, (Number(mem.rounds) || 12) * 2)),
      appTags: ["xjc"],
      promptProfile: { id: "xjc", label: "小剧场", include: includeList(combo), history: "none", enableRegexes: false },
    }, handlers);
    return { raw: (res && res.text) || "", model: (res && res.model) || "" };
  };
  const o = combo.output || {};
  if (o.staged && o.mode === "html") {
    const shellTask = buildTasks(combo, opts && opts.extra, character, userName, { kind: "shell" });
    const shell = await call(shellTask.tasks, stream("shell", shellTask.snapshot));
    if (cancelled()) return null;
    if (!shell.raw.trim()) throw new Error("模型没有返回骨架。");
    const parsed = postProcess(shell.raw, combo);
    const seg = parsed.segments.find(x => x.type === "html");
    const found = seg ? extractSlots(seg.content) : { slots: [] };
    // 模型没按占位写就当一次性成品，不再跑第二步
    if (!seg || !found.slots.length) return { raw: shell.raw, title: parsed.title, segments: parsed.segments, snapshot: { ...shellTask.snapshot, staged: false }, model: shell.model };
    if (opts && opts.onShell) opts.onShell({ raw: shell.raw, title: parsed.title, segments: parsed.segments, snapshot: shellTask.snapshot, model: shell.model, slots: found.slots });
    if (cancelled()) return null;
    const fillTask = buildTasks(combo, opts && opts.extra, character, userName, { kind: "fill", randoms: shellTask.randoms, slots: found.slots, outline: found.outline });
    const fill = await call(fillTask.tasks, stream("fill", shellTask.snapshot));
    if (cancelled()) return null;
    const map = parseFill(fill.raw);
    if (!Object.keys(map).length) throw new Error("第二步没填出文字，骨架已保留。");
    const segments = parsed.segments.map(x => x === seg ? { type: "html", content: fillSlots(seg.content, map) } : x);
    return { raw: `${shell.raw}\n\n<!-- 填字 -->\n${fill.raw}`, title: parsed.title, segments, snapshot: shellTask.snapshot, model: shell.model || fill.model, fill: map };
  }
  const { tasks, snapshot } = buildTasks(combo, opts && opts.extra, character, userName);
  const { raw, model } = await call(tasks, stream("text", snapshot));
  if (cancelled()) return null;
  if (!raw.trim()) throw new Error("模型没有返回内容。");
  const parsed = postProcess(raw, combo);
  return { raw, title: parsed.title, segments: parsed.segments, snapshot, model };
}

/** 流式增量是模型原文，思维链标签可能还没闭合，预览前先剥掉 */
function previewText(text) { return String(text || "").replace(/<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi, "").replace(/^\s+/, ""); }
function postProcess(raw, combo) {
  let text = String(raw).replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
  let title = "";
  const grab = () => { const tm = text.match(/^\s*(?:<!--\s*)?(?:标题|题目|Title)\s*[:：]\s*(.{1,40}?)\s*(?:-->)?\s*$/m); if (tm) { title = tm[1].replace(/^[「《"']|[」》"']$/g, ""); text = text.replace(tm[0], "").trim(); } };
  grab();
  const tag = (combo.output || {}).wrapTag;
  if (tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    const found = [...text.matchAll(re)].map(m => m[1].trim()).filter(Boolean);
    if (found.length) text = found.join("\n\n");
    else text = text.replace(new RegExp(`<\\/?${tag}[^>]*>`, "gi"), "").trim();
  }
  if (!title) grab();
  const segments = [];
  const fence = /```(?:html|HTML)?\s*\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = fence.exec(text)) !== null) {
    const before = text.slice(last, m.index).trim(); if (before) segments.push({ type: "text", content: before });
    const inner = m[1].trim(); if (inner) segments.push({ type: looksHtml(inner) ? "html" : "text", content: inner });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) segments.push({ type: (combo.output || {}).mode !== "text" && looksHtml(rest) ? "html" : "text", content: rest });
  if (!title) {
    const h = segments.find(s => s.type === "html") && (segments.find(s => s.type === "html").content.match(/<h[1-3][^>]*>([^<]{1,40})<\/h[1-3]>/i) || segments.find(s => s.type === "html").content.match(/<title>([^<]{1,40})<\/title>/i));
    if (h) title = h[1].trim();
    else { const t = segments.find(s => s.type === "text"); if (t) title = t.content.split(/\n/)[0].replace(/<[^>]*>/g, "").replace(/^[#*\s「《]+|[」》*]+$/g, "").trim().slice(0, 18); }
  }
  return { title: title || combo.name || "小剧场", segments };
}
function looksHtml(s) { return /^\s*(<!doctype|<html|<style|<div|<section|<article|<main|<body|<table|<ul|<ol|<header|<span|<p\b)/i.test(s) || (/<\w+[^>]*>/.test(s) && /<\/\w+>/.test(s) && (s.match(/<\w+/g) || []).length >= 3); }

function weightedRandomCombo() {
  const pool = state.combos.map(c => ({ c, w: Math.max(0, Number(c.weight) || 0) })).filter(x => x.w > 0);
  if (state.settings.randomIncludesAi) pool.push({ c: aiPickCombo(), w: 1 });
  const total = pool.reduce((a, x) => a + x.w, 0);
  if (!total) return state.combos[0] || aiPickCombo();
  let r = Math.random() * total;
  for (const x of pool) { r -= x.w; if (r <= 0) return x.c; }
  return pool[pool.length - 1].c;
}
/** 虚拟组合：把所有「形式」提示词列给 AI，让它自己挑一种 */
function aiPickCombo() {
  const forms = state.prompts.filter(p => (p.tags || []).includes("形式"));
  const menu = forms.map((p, i) => `${i + 1}. ${p.title}：${p.content.replace(/\s+/g, " ").slice(0, 80)}…`).join("\n");
  const scenes = state.prompts.filter(p => (p.tags || []).includes("场景")).map(p => p.title).join(" / ");
  const picker = { id: "", title: "AI 自选", content: `从下面的形式里自选一种最适合当前关系与最近发生的事的，严格按那一条的形式要求写；场景可从「${scenes || "任意"}」里挑，也可以自创。\n${menu}\n先在标题行之后用一行注明「形式：xxx」。` };
  return {
    id: "", name: "AI 自选", tags: ["随机"], preambleId: state.settings.defaultPreambleId || (state.preambles[0] || {}).id, promptIds: [], _virtualPrompts: [picker],
    random: { count: 1, include: [], exclude: [] },
    output: { mode: "mixed", wrapTag: "", length: "default", customChars: 900, style: state.settings.defaultStyle || "free" },
    memory: { mode: state.settings.defaultMemory || "host", rounds: state.settings.defaultRounds || 12 },
    writeBack: false, who: state.settings.defaultWho || "persona", whoText: "", rawChannel: false, weight: 1,
  };
}
async function writeBackMemory(result, combo) {
  if (!combo.writeBack || !result.characterId) return;
  const text = result.segments.filter(s => s.type === "text").map(s => s.content).join("\n") || result.segments.map(s => s.content.replace(/<[^>]+>/g, " ")).join(" ");
  const gist = text.replace(/\s+/g, " ").slice(0, 400);
  if (!gist) return;
  try { await api.memory.add({ characterId: result.characterId, type: "long_term", importance: 0.5, reason: `小剧场《${result.title}》`, content: `（小剧场·${combo.name}）${gist}` }); }
  catch (e) { console.warn("[小剧场] 写回记忆失败", e); }
}
