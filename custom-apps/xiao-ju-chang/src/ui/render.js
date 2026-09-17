// ── 渲染：AI 写的 HTML/JS 整块放进沙盒 iframe；纯文字段落也进同一个 iframe，样式跟当前主题 ──
const frames = new Map();
let frameSeq = 0;
window.addEventListener("message", e => {
  const d = e.data; if (!d || d.source !== "xjc-frame" || !frames.has(d.id)) return;
  const entry = frames.get(d.id), f = entry.iframe;
  if (!f.isConnected || e.source !== f.contentWindow) return;
  if (d.type === "resize" && Number.isFinite(d.height) && !entry.fullscreen) f.style.height = `${Math.max(80, Math.min(20000, Math.ceil(d.height)))}px`;
  if (d.type === "action" && entry.result) {
    const visible = entry.fullscreen ? !$("fullscreen").hidden : $("fullscreen").hidden && state.view === "stage";
    const text = typeof d.text === "string" ? d.text.trim() : "";
    if (visible && text) stage.continueResult(entry.result, text);
  }
});

function themeTokens() {
  const cs = getComputedStyle($("app"));
  const get = (k, d) => (cs.getPropertyValue(k) || d).trim();
  return { size: 13 * (Number(state.settings.fontScale) || 1), lineHeight: LINE_HEIGHTS[state.settings.lineHeight] || 1.55, bg: get("--paper", "#f6f1e8"), ink: get("--ink", "#1c1a17"), acc: get("--acc", "#8b2e2e"), line: get("--line", "#d9d1c3"), font: cs.fontFamily || "sans-serif", serif: getComputedStyle(document.querySelector(".topbar h1")).fontFamily };
}
function textToHtml(text) {
  return String(text).split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
}
function frameDoc(segments, id, fullscreen) {
  const t = themeTokens();
  const body = segments.map(s => s.type === "html" ? `<div class="xjc-html">${s.content}</div>` : `<article class="xjc-text">${textToHtml(s.content)}</article>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--xjc-bg:${t.bg};--xjc-ink:${t.ink};--xjc-acc:${t.acc};--xjc-line:${t.line};--xjc-font:${t.font.replace(/"/g, "'")};--xjc-serif:${t.serif.replace(/"/g, "'")}}
html,body{margin:0;padding:0;background:var(--xjc-bg);color:var(--xjc-ink);font-family:var(--xjc-font);font-size:${t.size}px;line-height:${t.lineHeight};-webkit-text-size-adjust:100%}
body{min-height:0}#xjc-content{display:flow-root;padding:${fullscreen ? "14px 16px 40px" : "12px 14px"}}
*{box-sizing:border-box}img,video,canvas,svg,iframe{max-width:100%}
.xjc-text p{margin:0 0 .9em;text-align:justify;word-break:break-word}
.xjc-text p:last-child{margin-bottom:0}
.xjc-text+.xjc-html,.xjc-html+.xjc-text,.xjc-html+.xjc-html{margin-top:16px}
.xjc-html{max-width:100%;overflow-x:auto}
[data-slot]:empty{display:inline-block;min-width:4em;min-height:1em;vertical-align:middle;border-radius:3px;background:linear-gradient(90deg,transparent 20%,var(--xjc-line) 50%,transparent 80%) 0 0/200% 100%;animation:xjc-sh 1.4s linear infinite;opacity:.7}
@keyframes xjc-sh{to{background-position:-200% 0}}
.xjc-text.writing p:last-child::after{content:"▍";margin-left:1px;color:var(--xjc-acc);animation:xjc-bl 1s steps(2) infinite}
@keyframes xjc-bl{50%{opacity:0}}
</style></head><body><div id="xjc-content">${body}</div>
<${"script"}>(function(){var id=${JSON.stringify(id)};var content=document.getElementById("xjc-content");function h(){return Math.max(content.scrollHeight,content.getBoundingClientRect().height)}var last=0;function send(){var v=h();if(Math.abs(v-last)>1){last=v;parent.postMessage({source:"xjc-frame",type:"resize",id:id,height:v},"*")}}
if(window.ResizeObserver){new ResizeObserver(send).observe(content)}window.addEventListener("load",send);setInterval(send,600);send();
window.addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.source!=="xjc-parent"||d.id!==id)return;if(d.type==="reading"){if(Number.isFinite(d.size))document.body.style.fontSize=d.size+"px";if(Number.isFinite(d.lineHeight))document.body.style.lineHeight=d.lineHeight;send()}if(d.type==="text"&&typeof d.html==="string"){content.innerHTML=d.html;send()}if(d.type==="fill"&&d.slots){Object.keys(d.slots).forEach(function(k){var t=String(d.slots[k]).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]}).replace(/&lt;br\\s*\\/?&gt;/gi,"<br>").replace(/\\n/g,"<br>");document.querySelectorAll('[data-slot="'+k+'"]').forEach(function(n){n.innerHTML=t})});send()}});
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("[data-action]"):null;if(a){parent.postMessage({source:"xjc-frame",type:"action",id:id,text:a.getAttribute("data-action")||a.textContent||""},"*")}});})();</${"script"}>
</body></html>`;
}
function updateFrameReading() {
  const t = themeTokens();
  for (const [id, entry] of frames) if (entry.iframe.isConnected) entry.iframe.contentWindow.postMessage({ source: "xjc-parent", type: "reading", id, size: t.size, lineHeight: t.lineHeight }, "*");
}
/** 分两步出的第二步：把填好的字送进已经显示的 iframe，不重载、不打断它的脚本 */
function fillFrame(result, slots) {
  for (const [id, entry] of frames) if (entry.result === result && entry.iframe.isConnected) entry.iframe.contentWindow.postMessage({ source: "xjc-parent", type: "fill", id, slots }, "*");
}
/** 流式：纯文字边写边显示，整段重设 innerHTML，不重载 iframe */
function streamFrame(result, segments, writing) {
  const html = segments.map(s => `<article class="xjc-text${writing ? " writing" : ""}">${textToHtml(s.content)}</article>`).join("\n");
  for (const [id, entry] of frames) if (entry.result === result && entry.iframe.isConnected) entry.iframe.contentWindow.postMessage({ source: "xjc-parent", type: "text", id, html }, "*");
}
/** 结果对象在原地更新后（填字、流式收尾）刷新标题和字数，不重挂卡片 */
function refreshResultMeta(result) {
  const card = document.querySelector("#result-host .result"); if (!card) return;
  const snap = result.snapshot || {};
  card.querySelector("h2").textContent = result.title || snap.comboName || "无题";
  const spans = card.querySelectorAll(".meta span");
  if (spans[0]) spans[0].textContent = `${result.characterName || charName(state.character)} · ${fmtTime(result.createdAt)}`;
  if (spans[1]) spans[1].textContent = `${resultCharCount(result)} 字 · ${memoryLabel(snap.memory)}${result.model ? " · " + result.model : ""}`;
}
function setResultStatus(text) {
  const node = document.querySelector("#result-host .result .status"); if (!node) return;
  node.hidden = !text; node.textContent = ""; if (text) { node.appendChild(el("i", "spin")); node.appendChild(document.createTextNode(text)); }
}
function mountFrame(container, segments, fullscreen, result) {
  for (const [key, entry] of frames) if (!entry.iframe.isConnected) frames.delete(key);
  const id = `f${++frameSeq}`;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups");
  iframe.setAttribute("scrolling", fullscreen ? "yes" : "no");
  iframe.title = "小剧场";
  iframe.srcdoc = frameDoc(segments, id, fullscreen);
  frames.set(id, { iframe, result, fullscreen });
  container.appendChild(iframe);
  return iframe;
}

const KIND_LABEL = { html: "前端型", text: "文字型", mixed: "组合型" };
/** 收藏/最近里可能有缺字段的旧数据或别人导入的数据，取用前一律过这里 */
function segmentsOf(result) {
  const list = Array.isArray(result && result.segments) ? result.segments.filter(s => s && typeof s.content === "string") : [];
  if (list.length) return list;
  const raw = result && typeof result.raw === "string" ? result.raw.trim() : "";
  return raw ? [{ type: "text", content: raw }] : [{ type: "text", content: "这条记录的内容已经丢失了。" }];
}
function kindOf(result) {
  const types = new Set(segmentsOf(result).map(s => s.type));
  return types.size > 1 ? "mixed" : (types.has("html") ? "html" : "text");
}
function resultCharCount(result) { return segmentsOf(result).reduce((a, s) => a + (s.type === "html" ? s.content.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, "").replace(/\s+/g, "").length : s.content.replace(/\s+/g, "").length), 0); }

/** 结果卡：handlers = { again, fav, copy } */
function renderResultCard(host, result, handlers) {
  host.innerHTML = "";
  const card = el("article", "result");
  const kind = el("div", "kind row");
  const snap = result.snapshot || {};
  const picks = Array.isArray(snap.randoms) ? snap.randoms : [];
  const kt = el("span", "grow", `${KIND_LABEL[kindOf(result)]} · ${snap.comboName || result.comboName || "小剧场"}${picks.length ? " · 随机 " + picks.join("、") : ""}`);
  const fs = el("button", "fs", "⤢ 全屏"); fs.type = "button"; fs.onclick = () => openFullscreen(result, handlers);
  kind.append(kt, fs); card.appendChild(kind);
  card.appendChild(el("h2", "", result.title || snap.comboName || "无题"));
  const status = el("div", "status"); status.hidden = true; card.appendChild(status);
  const wrap = el("div", "frame-wrap"); mountFrame(wrap, segmentsOf(result), false, result);
  card.appendChild(wrap);
  const meta = el("div", "meta");
  meta.appendChild(el("span", "", `${result.characterName || charName(state.character)} · ${fmtTime(result.createdAt)}`));
  meta.appendChild(el("span", "", `${resultCharCount(result)} 字 · ${memoryLabel(snap.memory)}${result.model ? " · " + result.model : ""}`));
  card.appendChild(meta);
  const ops = el("div", "ops");
  const mk = (label, fn, cls) => { const b = el("button", cls || "", label); b.type = "button"; b.onclick = fn; ops.appendChild(b); return b; };
  mk("再来一条", () => handlers.again(result));
  const favBtn = mk(favoriteOf(result) ? "已收藏" : "收藏", async () => { try { const id = await handlers.fav(result); if (id) favBtn.textContent = "已收藏"; } catch (e) { fail(e); } });
  mk("复制", () => handlers.copy(result));
  card.appendChild(ops);
  host.appendChild(card);
  return card;
}
function memoryLabel(m) { if (!m) return "记忆未知"; return m.mode === "host" ? "跟宿主记忆" : m.mode === "recent" ? `最近 ${m.rounds || 12} 轮` : "不带记忆"; }

let fsResult = null, fsHandlers = null;
function openFullscreen(result, handlers) {
  fsResult = result; fsHandlers = handlers;
  const body = $("fs-body"); body.innerHTML = "";
  $("fs-title").textContent = result.title || "";
  mountFrame(body, segmentsOf(result), true, result);
  $("fullscreen").hidden = false;
}
function closeFullscreen() { $("fullscreen").hidden = true; $("fs-body").innerHTML = ""; fsResult = null; }
$("fs-close").onclick = closeFullscreen;
$("fs-again").onclick = () => { if (fsResult && fsHandlers) { const r = fsResult; closeFullscreen(); fsHandlers.again(r); } };

function resultPlainText(result) {
  return segmentsOf(result).map(s => s.type === "text" ? s.content : s.content.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim()).join("\n\n");
}
async function copyResult(result) {
  const text = `${result.title}\n\n${resultPlainText(result)}`;
  try { await navigator.clipboard.writeText(text); toast("已复制正文"); }
  catch { openSheet("复制", box => { const ta = el("textarea", "ta"); ta.value = result.raw; ta.rows = 12; box.appendChild(ta); ta.focus(); ta.select(); }); }
}
