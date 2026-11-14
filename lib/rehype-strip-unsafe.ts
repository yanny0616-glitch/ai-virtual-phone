import type { Element, Root, RootContent } from "hast";

/**
 * rehype-raw 之后使用：模型/正则/角色卡输出的原始 HTML 不可信。
 * 保留排版用的标签、内联样式、class 和 data-*（含 data-action），
 * 移除能执行脚本、创建独立执行上下文或提交请求的标签与属性。
 * 规则与 components/ui/story-html-renderer.tsx 里的 DOMPurify 配置保持一致。
 */
const FORBIDDEN_TAGS = new Set([
    "script",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "base",
    "form",
    "input",
    "textarea",
    "select",
    "option",
    "link",
    "meta",
    "portal",
    "noscript",
    "template",
]);

const FORBIDDEN_PROPERTIES = new Set(["srcDoc", "formAction", "action", "ping"]);

const URL_PROPERTIES = new Set(["href", "src", "xLinkHref", "action", "formAction", "poster", "background", "cite", "data"]);

const UNSAFE_URL_RE = /^\s*(?:javascript|vbscript|data:text\/html)/i;

function cleanElement(node: Element): void {
    const props = node.properties ?? {};
    for (const key of Object.keys(props)) {
        if (/^on/i.test(key) || FORBIDDEN_PROPERTIES.has(key)) {
            delete props[key];
            continue;
        }
        if (URL_PROPERTIES.has(key)) {
            const value = props[key];
            const text = Array.isArray(value) ? value.join(" ") : String(value ?? "");
            // 去掉控制字符和空白后再判断，防 "java\tscript:" 之类的绕过
            if (UNSAFE_URL_RE.test(text.replace(/[\u0000- ]/g, ""))) delete props[key];
        }
    }
}

function cleanChildren(children: RootContent[]): RootContent[] {
    const out: RootContent[] = [];
    for (const child of children) {
        if (child.type === "element") {
            if (FORBIDDEN_TAGS.has(child.tagName.toLowerCase())) continue;
            cleanElement(child);
            child.children = cleanChildren(child.children as RootContent[]) as Element["children"];
            if (child.content) child.content.children = cleanChildren(child.content.children);
        }
        out.push(child);
    }
    return out;
}

export default function rehypeStripUnsafe() {
    return (tree: Root) => {
        tree.children = cleanChildren(tree.children);
    };
}
