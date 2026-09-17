// 工坊代码块语法高亮：只注册常用语言，包体可控；结果是 hljs 转义过的 HTML。
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerLanguage("python", python);
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerLanguage("xml", xml);
hljs.registerAliases(["html", "svg", "vue"], { languageName: "xml" });
hljs.registerLanguage("yaml", yaml);
hljs.registerAliases(["yml"], { languageName: "yaml" });

// 超过这个长度不高亮：一次性 tokenize 几十 KB 会卡主线程，低端机尤甚
const MAX_HIGHLIGHT_CHARS = 30_000;
// 没标语言时只在短代码上自动识别（识别要把所有语言各跑一遍）
const MAX_AUTODETECT_CHARS = 3_000;

/** 返回高亮后的 HTML（已转义）；不高亮时返回 null，由调用方按纯文本渲染 */
export function highlightQaCode(code: string, language: string): string | null {
    if (!code || code.length > MAX_HIGHLIGHT_CHARS) return null;
    try {
        const lang = language.toLowerCase();
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        if (lang || code.length > MAX_AUTODETECT_CHARS) return null;
        const auto = hljs.highlightAuto(code);
        return auto.relevance >= 5 ? auto.value : null;
    } catch {
        return null;
    }
}
