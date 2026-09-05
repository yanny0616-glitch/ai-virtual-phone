#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = resolve(root, "custom-apps/gua-nian");
const source = resolve(app, "src");
const output = resolve(app, "index.html");

const domainModules = [
  ["GuaNianTime", "domain/time.mjs"],
  ["GuaNianScoring", "domain/scoring.mjs"],
];

function compileDomainModules() {
  return domainModules.map(([name, file]) => {
    const code = readFileSync(resolve(source, file), "utf8");
    // 这两个模块没有运行时依赖。用已有 TypeScript 编译器处理真正的 ESM 导出，
    // 浏览器侧每个模块都有独立作用域，只通过导出对象与旧代码连接。
    const result = ts.transpileModule(code, {
      fileName: file.replace(/\.mjs$/, ".js"),
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
    return `  const ${name} = (() => {\nconst exports = Object.create(null);\n${result.outputText}\nreturn Object.freeze(exports);\n})();\n`;
  }).join("");
}

export function renderGuaNian() {
  const files = JSON.parse(readFileSync(resolve(source, "bundle.json"), "utf8"));
  if (!Array.isArray(files) || files.length === 0 || new Set(files).size !== files.length
    || files.some(file => typeof file !== "string" || !/^[a-z/-]+\.js$/.test(file))) {
    throw new Error("挂念 src/bundle.json 必须列出不重复的 JS 源码相对路径。");
  }
  const template = readFileSync(resolve(source, "page.html"), "utf8");
  const replacements = {
    STYLES: readFileSync(resolve(source, "styles.css"), "utf8"),
    // 顺序与原单文件相同，片段共享一个闭包；不逐文件包函数，也不注入模块运行时。
    SCRIPTS: compileDomainModules() + files.map(file => readFileSync(resolve(source, file), "utf8")).join(""),
  };
  for (const key of Object.keys(replacements)) {
    if (template.split(`{{${key}}}`).length !== 2) throw new Error(`模板必须恰好包含一个 {{${key}}}`);
  }
  // replacer 返回值不解释源码中的 $& / $' 等字符。
  const html = template.replace(/\{\{(STYLES|SCRIPTS)\}\}/g, (_, key) => replacements[key]);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error("挂念产物必须保留单个内联脚本。");
  new Script(scripts[0][1], { filename: "gua-nian/index.html" });
  return html;
}

export function checkGuaNianBuild() {
  const html = renderGuaNian();
  if (readFileSync(output, "utf8") !== html) {
    throw new Error("挂念 index.html 与 src 源码不一致。请编辑 src，再运行 npm run gua-nian:build。");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--package"].includes(arg)) || args.length > 1) {
    throw new Error("用法：node scripts/build-gua-nian.mjs [--check | --package]");
  }
  if (args.includes("--check")) {
    checkGuaNianBuild();
    console.log("[gua-nian] 源码、单文件产物和脚本语法检查通过。");
    return;
  }
  const html = renderGuaNian();
  writeFileSync(output, html);
  console.log("[gua-nian] 已从 src 合成 index.html。");
  if (!args.includes("--package")) return;

  const { default: JSZip } = await import("jszip");
  const manifest = JSON.parse(readFileSync(resolve(app, "manifest.json"), "utf8"));
  if (manifest.entry !== "index.html" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("挂念安装包需要 index.html 入口和有效版本号。");
  }
  const zip = new JSZip();
  for (const file of ["manifest.json", "index.html", "icon.png", "presets.json", "README.md"]) {
    zip.file(file, readFileSync(resolve(app, file)));
  }
  const targetDir = resolve(root, "out/custom-apps");
  mkdirSync(targetDir, { recursive: true });
  const target = resolve(targetDir, `gua-nian-${manifest.version}.zip`);
  writeFileSync(target, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  console.log(`[gua-nian] 安装包：${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
