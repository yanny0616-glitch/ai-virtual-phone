// 回复格式自愈：模型偶尔把「格式说明」写进正文，或者把一句话拆成好几行。
// 这里只做保守修补，拿不准就原样保留。纯函数，解析器在切气泡前后调用。

const CJK = "\\u3400-\\u9fff\\uf900-\\ufaff";
const CJK_CHAR_RE = new RegExp(`[${CJK}]`);
const HAS_CJK_RE = new RegExp(`[${CJK}]`);

// 中文元话语：提到输出格式本身的词
const META_WORD_ZH_RE = /JSON|json|方括号|输出格式|格式要求|富媒体指令|按格式|指令格式|标记格式|系统提示|提示词/;
// 英文元话语：「Writing the JSON lines:」「Now I'll output the messages:」「Let me write…:」
const META_LINE_EN_RE = /^(?:writing|now\s+i(?:'|’)?ll|let\s+me|i(?:'|’)?ll\s+(?:now\s+)?(?:write|output|respond|reply|format)|output(?:ting)?|here\s+(?:is|are)\s+(?:the|my)|formatting|following\s+the\s+format)\b/i;
const LIST_PREFIX_RE = /^\s*(?:\d+[.、)）]|[-*•]|#{1,6})\s*/;

/**
 * 删掉模型写进正文的格式说明行：
 * - 不以 [ 【 { < 开头、提到格式类词语、以冒号结尾的行；
 * - 编号 / 列表 / 标题行里提到格式类词语的；
 * - 纯英文、以「Writing / Let me / Here is…」开头、以冒号结尾的行（中文回复里不会有这种台词）。
 * 删掉的行超过一半时视为误判，整段原样返回。
 */
export function stripFormatMetaTalk(text: string): string {
    if (!text) return text;
    const lines = text.split("\n");
    const nonEmpty = lines.filter(line => line.trim()).length;
    if (nonEmpty === 0) return text;
    let removed = 0;
    const kept = lines.filter(rawLine => {
        const line = rawLine.trim();
        if (!line || /^[[【{<\x00]/.test(line)) return true;
        const endsWithColon = /[:：]$/.test(line);
        const isMeta =
            (META_WORD_ZH_RE.test(line) && (endsWithColon || LIST_PREFIX_RE.test(line)))
            || (endsWithColon && !HAS_CJK_RE.test(line) && META_LINE_EN_RE.test(line));
        if (isMeta) removed += 1;
        return !isMeta;
    });
    if (removed === 0 || removed * 2 > nonEmpty) return text;
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 行尾是这些字，说明话没说完（介词、副词、连词）：「再 / 把咱们赏月的心情 / 给搅了」
const DANGLING_END = "把被给让对从向往跟与及或再就都还又才很太最更比";
// 行首是这些字，一定是接着上一行说的（助词、语气词）
const CONTINUATION_START = "的了着吗呢吧嘛";
// 行首是这些字时，上一行没收尾（不以语气词结尾、至少两个字）才接
const SOFT_CONTINUATION_START = "给把被";
const SENTENCE_FINAL = "了吧啊呢吗哦呀嘛啦哈嗯噢喔";
const LINE_END_PUNCT_RE = /[\p{P}\p{S}\s]$/u;

function shouldJoinCjk(prev: string, next: string): boolean {
    const last = prev.slice(-1);
    const first = next.charAt(0);
    if (!CJK_CHAR_RE.test(last) || !CJK_CHAR_RE.test(first)) return false;
    if (LINE_END_PUNCT_RE.test(prev)) return false;
    if (DANGLING_END.includes(last)) return true;
    if (CONTINUATION_START.includes(first)) return true;
    if (SOFT_CONTINUATION_START.includes(first)) return prev.length >= 2 && !SENTENCE_FINAL.includes(last);
    return false;
}

/**
 * 一个气泡里被换行切断的半句接回去：
 * - 中文：上一行明显没说完（以「把 / 再 / 很…」收尾），或下一行以「的 / 了 / 吗…」开头；
 * - 英文：上一行以字母数字结尾、下一行小写开头，换成一个空格。
 * 以标点、emoji 收尾的行，以及看不出是断句的换行（诗、歌词、刻意分行）原样保留。
 */
export function rejoinBrokenLines(text: string): string {
    if (!text || !text.includes("\n")) return text;
    const lines = text.split("\n");
    const out: string[] = [lines[0]];
    for (let i = 1; i < lines.length; i += 1) {
        const prev = out[out.length - 1];
        const next = lines[i];
        const prevTrim = prev.trimEnd();
        const nextTrim = next.trimStart();
        if (!prevTrim || !nextTrim || /^[[【{<]/.test(nextTrim)) {
            out.push(next);
            continue;
        }
        if (shouldJoinCjk(prevTrim, nextTrim)) {
            out[out.length - 1] = prevTrim + nextTrim;
        } else if (/[A-Za-z0-9,]$/.test(prevTrim) && /^[a-z]/.test(nextTrim) && !HAS_CJK_RE.test(prevTrim + nextTrim)) {
            out[out.length - 1] = `${prevTrim} ${nextTrim}`;
        } else {
            out.push(next);
        }
    }
    return out.join("\n");
}
