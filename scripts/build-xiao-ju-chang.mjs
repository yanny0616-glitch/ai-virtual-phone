#!/usr/bin/env node
// 小剧场 APP：src/**/*.js 按 bundle.json 顺序拼成一个闭包，注入 page.html，产出单文件 index.html 和随宿主发布的 zip。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { packageCustomAppDir } from "./lib/custom-app-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = resolve(root, "custom-apps/xiao-ju-chang");
const source = resolve(app, "src");
const output = resolve(app, "index.html");
const bundled = resolve(root, "public/custom-apps/xiao-ju-chang.zip");

export function renderXiaoJuChang() {
  const files = JSON.parse(readFileSync(resolve(source, "bundle.json"), "utf8"));
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length
    || files.some(file => typeof file !== "string" || !/^[a-z/-]+\.js$/.test(file))) {
    throw new Error("小剧场 src/bundle.json 必须列出不重复的 JS 源码相对路径。");
  }
  const template = readFileSync(resolve(source, "page.html"), "utf8");
  const scripts = files.map(file => readFileSync(resolve(source, file), "utf8")).join("\n");
  const replacements = { STYLES: readFileSync(resolve(source, "styles.css"), "utf8"), SCRIPTS: scripts };
  for (const key of Object.keys(replacements)) {
    if (template.split(`{{${key}}}`).length !== 2) throw new Error(`模板必须恰好包含一个 {{${key}}}`);
  }
  const html = template.replace(/\{\{(STYLES|SCRIPTS)\}\}/g, (_, key) => replacements[key]);
  const tags = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (tags.length !== 1) throw new Error("小剧场产物必须保留单个内联脚本。");
  new Script(tags[0][1], { filename: "xiao-ju-chang/index.html" });
  return html;
}

async function buildZip(html) { return (await packageCustomAppDir(app, { "index.html": html })).buffer; }

export async function checkXiaoJuChangBuild() {
  const html = renderXiaoJuChang();
  if (readFileSync(output, "utf8") !== html) throw new Error("小剧场 index.html 与 src 源码不一致。请编辑 src，再运行 npm run xjc:build。");
  if (!Buffer.from(readFileSync(bundled)).equals(await buildZip(html))) throw new Error("public/custom-apps/xiao-ju-chang.zip 与源码不一致。请运行 npm run xjc:build。");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--package"].includes(arg)) || args.length > 1) throw new Error("用法：node scripts/build-xiao-ju-chang.mjs [--check | --package]");
  if (args.includes("--check")) { await checkXiaoJuChangBuild(); console.log("[xiao-ju-chang] 源码、单文件产物、zip 和脚本语法检查通过。"); return; }
  const html = renderXiaoJuChang();
  writeFileSync(output, html);
  const manifest = JSON.parse(readFileSync(resolve(app, "manifest.json"), "utf8"));
  const zip = await buildZip(html);
  mkdirSync(dirname(bundled), { recursive: true });
  writeFileSync(bundled, zip);
  console.log(`[xiao-ju-chang] 已从 src 合成 index.html，并更新 ${bundled}（${(zip.length / 1024).toFixed(0)} KB）`);
  if (!args.includes("--package")) return;
  const targetDir = resolve(root, "out/custom-apps");
  mkdirSync(targetDir, { recursive: true });
  const target = resolve(targetDir, `xiao-ju-chang-${manifest.version}.zip`);
  writeFileSync(target, zip);
  console.log(`[xiao-ju-chang] 安装包：${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
