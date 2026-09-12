#!/usr/bin/env node
// 陪眠 APP：src/domain/*.mjs 是 ESM（Node 测试直接 import），其余 src/**/*.js 共享一个闭包。
// assets/sources.json 会被注入成 SOUND_SOURCES 常量，供「声音来源」页使用。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageCustomAppDir } from "./lib/custom-app-package.mjs";
import { Script } from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = resolve(root, "custom-apps/pei-mian");
const source = resolve(app, "src");
const output = resolve(app, "index.html");

const domainModules = [
  ["PmRhythm", "domain/rhythm.mjs"],
  ["PmStats", "domain/stats.mjs"],
  ["PmMixer", "domain/mixer.mjs"],
  ["PmWav", "domain/wav.mjs"],
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
    const table = done.map(([n, f]) => `"./${f.split("/").pop()}": ${n}`).join(", ");
    done.push([name, file]);
    return `  const ${name} = (() => {\nconst exports = Object.create(null);\nconst require = id => { const m = ({ ${table} })[id]; if (!m) throw new Error("unknown module " + id); return m; };\n${result.outputText}\nreturn Object.freeze(exports);\n})();\n`;
  }).join("");
}

function soundSources() {
  const list = JSON.parse(readFileSync(resolve(app, "assets/sources.json"), "utf8"));
  const map = Object.fromEntries(list.map(s => [s.key, { id: s.id, name: s.name, author: s.author, duration: s.duration }]));
  return `  const SOUND_SOURCES = ${JSON.stringify(map)};\n`;
}

export function renderPeiMian() {
  const files = JSON.parse(readFileSync(resolve(source, "bundle.json"), "utf8"));
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length
    || files.some(file => typeof file !== "string" || !/^[a-z/-]+\.js$/.test(file))) {
    throw new Error("陪眠 src/bundle.json 必须列出不重复的 JS 源码相对路径。");
  }
  const template = readFileSync(resolve(source, "page.html"), "utf8");
  const [head, ...rest] = files;
  const scripts = readFileSync(resolve(source, head), "utf8") + compileDomainModules() + soundSources()
    + rest.map(file => readFileSync(resolve(source, file), "utf8")).join("");
  const replacements = { STYLES: readFileSync(resolve(source, "styles.css"), "utf8"), SCRIPTS: scripts };
  for (const key of Object.keys(replacements)) {
    if (template.split(`{{${key}}}`).length !== 2) throw new Error(`模板必须恰好包含一个 {{${key}}}`);
  }
  const html = template.replace(/\{\{(STYLES|SCRIPTS)\}\}/g, (_, key) => replacements[key]);
  const tags = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (tags.length !== 1) throw new Error("陪眠产物必须保留单个内联脚本。");
  new Script(tags[0][1], { filename: "pei-mian/index.html" });
  return html;
}

const bundled = resolve(root, "public/custom-apps/pei-mian.zip");
async function buildZip(html) { return (await packageCustomAppDir(app, { "index.html": html })).buffer; }

export async function checkPeiMianBuild() {
  const html = renderPeiMian();
  if (readFileSync(output, "utf8") !== html) throw new Error("陪眠 index.html 与 src 源码不一致。请编辑 src，再运行 npm run pei-mian:build。");
  if (!Buffer.from(readFileSync(bundled)).equals(await buildZip(html))) throw new Error("public/custom-apps/pei-mian.zip 与源码不一致。请运行 npm run pei-mian:build。");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--check", "--package"].includes(arg)) || args.length > 1) throw new Error("用法：node scripts/build-pei-mian.mjs [--check | --package]");
  if (args.includes("--check")) { await checkPeiMianBuild(); console.log("[pei-mian] 源码、单文件产物、随宿主发布的 zip 和脚本语法检查通过。"); return; }
  const html = renderPeiMian();
  writeFileSync(output, html);
  const manifest = JSON.parse(readFileSync(resolve(app, "manifest.json"), "utf8"));
  const zip = await buildZip(html);
  mkdirSync(dirname(bundled), { recursive: true });
  writeFileSync(bundled, zip);
  console.log(`[pei-mian] 已从 src 合成 index.html，并更新 ${bundled}（${(zip.length / 1048576).toFixed(1)} MB）`);
  if (!args.includes("--package")) return;
  const targetDir = resolve(root, "out/custom-apps");
  mkdirSync(targetDir, { recursive: true });
  const target = resolve(targetDir, `pei-mian-${manifest.version}.zip`);
  writeFileSync(target, zip);
  console.log(`[pei-mian] 安装包：${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
