#!/usr/bin/env node
// 拾光 APP：src/domain/*.mjs 是真正的 ESM（Node 测试直接 import），其余 src/**/*.js 共享一个闭包。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = resolve(root, "custom-apps/shiguang");
const source = resolve(app, "src");
const output = resolve(app, "index.html");

const domainModules = [
  ["ShiguangText", "domain/text.mjs"],
  ["ShiguangRounds", "domain/rounds.mjs"],
  ["ShiguangRecall", "domain/recall.mjs"],
  ["ShiguangExtraction", "domain/extraction.mjs"],
];

function compileDomainModules() {
  const done = [];
  return domainModules.map(([name, file]) => {
    const code = readFileSync(resolve(source, file), "utf8");
    const result = ts.transpileModule(code, {
      fileName: file.replace(/\.mjs$/, ".js"),
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n"));
    // 模块之间只准引用前面编好的：require 表按顺序累积。
    const table = done.map(([n, f]) => `"./${f.split("/").pop()}": ${n}`).join(", ");
    done.push([name, file]);
    return `  const ${name} = (() => {\nconst exports = Object.create(null);\nconst require = id => { const m = ({ ${table} })[id]; if (!m) throw new Error("unknown module " + id); return m; };\n${result.outputText}\nreturn Object.freeze(exports);\n})();\n`;
  }).join("");
}

export function renderShiguang() {
  const files = JSON.parse(readFileSync(resolve(source, "bundle.json"), "utf8"));
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length
    || files.some(file => typeof file !== "string" || !/^[a-z/-]+\.js$/.test(file))) {
    throw new Error("拾光 src/bundle.json 必须列出不重复的 JS 源码相对路径。");
  }
  const template = readFileSync(resolve(source, "page.html"), "utf8");
  const replacements = {
    STYLES: readFileSync(resolve(source, "styles.css"), "utf8"),
    SCRIPTS: compileDomainModules() + files.map(file => readFileSync(resolve(source, file), "utf8")).join(""),
  };
  for (const key of Object.keys(replacements)) {
    if (template.split(`{{${key}}}`).length !== 2) throw new Error(`模板必须恰好包含一个 {{${key}}}`);
  }
  const html = template.replace(/\{\{(STYLES|SCRIPTS)\}\}/g, (_, key) => replacements[key]);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error("拾光产物必须保留单个内联脚本。");
  new Script(scripts[0][1], { filename: "shiguang/index.html" });
  return html;
}

const bundled = resolve(root, "public/custom-apps/shiguang.zip");
const PACKAGE_FILES = ["manifest.json", "index.html", "icon.svg", "README.md"];

/** 随宿主发布的那份 zip：文件时间固定，内容不变字节就不变，check 才能逐字节比。 */
async function buildZip(html) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const file of PACKAGE_FILES) zip.file(file, file === "index.html" ? html : readFileSync(resolve(app, file)), { date: new Date(0) });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function checkShiguangBuild() {
  const html = renderShiguang();
  if (readFileSync(output, "utf8") !== html) {
    throw new Error("拾光 index.html 与 src 源码不一致。请编辑 src，再运行 npm run shiguang:build。");
  }
  if (!Buffer.from(readFileSync(bundled)).equals(await buildZip(html))) {
    throw new Error("public/custom-apps/shiguang.zip 与源码不一致。请运行 npm run shiguang:build。");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--package"].includes(arg)) || args.length > 1) {
    throw new Error("用法：node scripts/build-shiguang.mjs [--check | --package]");
  }
  if (args.includes("--check")) { await checkShiguangBuild(); console.log("[shiguang] 源码、单文件产物、随宿主发布的 zip 和脚本语法检查通过。"); return; }
  const html = renderShiguang();
  writeFileSync(output, html);
  const manifest = JSON.parse(readFileSync(resolve(app, "manifest.json"), "utf8"));
  if (manifest.entry !== "index.html" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("拾光安装包需要 index.html 入口和有效版本号。");
  const zip = await buildZip(html);
  mkdirSync(dirname(bundled), { recursive: true });
  writeFileSync(bundled, zip);
  console.log(`[shiguang] 已从 src 合成 index.html，并更新 ${bundled}`);
  if (!args.includes("--package")) return;
  const targetDir = resolve(root, "out/custom-apps");
  mkdirSync(targetDir, { recursive: true });
  const target = resolve(targetDir, `shiguang-${manifest.version}.zip`);
  writeFileSync(target, zip);
  console.log(`[shiguang] 安装包：${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
