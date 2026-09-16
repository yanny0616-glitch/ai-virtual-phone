// ── 宏：宿主只展开自己预设里的宏，APP 传出去的文字要自己展开。语法与宿主一致，另加随机词 / 随机数 ──
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
function pickOne(list) { return list[Math.floor(Math.random() * list.length)]; }
function shuffle(list) { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/**
 * ctx: { user, char, length, macros:[{name,kind,values|min,max}] }
 * 支持：{{user}} {{char}} {{time}} {{date}} {{weekday}} {{篇幅}} {{random::a::b}} {{random:a,b}}
 *      {{随机词:名字}} {{随机词:名字:数量}} {{随机数:名字}} {{roll:1d6}}
 */
function expandMacros(text, ctx) {
  let out = String(text ?? "");
  for (let pass = 0; pass < 3 && /\{\{/.test(out); pass++) {
    out = out.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, body) => {
      const b = body.trim();
      if (b === "user") return ctx.user || "用户";
      if (b === "char") return ctx.char || "角色";
      if (b === "篇幅" || b === "length") return ctx.length || "篇幅不限";
      const now = new Date();
      if (b === "time") return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      if (b === "date") return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      if (b === "weekday") return WEEKDAYS[now.getDay()];
      if (b.startsWith("random::")) { const items = b.slice(8).split("::").map(s => s.trim()).filter(Boolean); return items.length ? pickOne(items) : ""; }
      if (b.startsWith("random:")) { const items = b.slice(7).split(/[,\n，]/).map(s => s.trim()).filter(Boolean); return items.length ? pickOne(items) : ""; }
      let m = b.match(/^roll:\s*(\d+)d(\d+)$/i);
      if (m) { let sum = 0; for (let i = 0; i < Math.min(50, Number(m[1])); i++) sum += 1 + Math.floor(Math.random() * Math.max(1, Number(m[2]))); return String(sum); }
      m = b.match(/^(?:随机词|pick)[:：]\s*([^:：]+?)\s*(?:[:：]\s*(\d+))?$/);
      if (m) {
        const def = (ctx.macros || []).find(x => x.kind === "words" && x.name === m[1]);
        if (!def) return whole;
        const n = Math.max(1, Math.min(20, Number(m[2] || 1)));
        return shuffle(def.values || []).slice(0, n).join("、");
      }
      m = b.match(/^(?:随机数|num)[:：]\s*([^:：]+?)\s*$/);
      if (m) {
        const def = (ctx.macros || []).find(x => x.kind === "number" && x.name === m[1]);
        if (!def) return whole;
        const lo = Number(def.min ?? 1), hi = Number(def.max ?? 10);
        return String(lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1)));
      }
      return whole;
    });
  }
  return out;
}
