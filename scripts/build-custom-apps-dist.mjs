#!/usr/bin/env node
// 仓库自带的自定义 APP（custom-apps/*/）随宿主发布到 public/custom-apps/<目录名>.zip，
// 并生成 index.json 供宿主启动时对照版本提示升级。--check 只比对不写。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageCustomAppDir } from "./lib/custom-app-package.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "custom-apps");
const output = resolve(root, "public/custom-apps");
const check = process.argv.includes("--check");

const index = [];
const stale = [];
for (const dir of readdirSync(source).sort()) {
  const appDir = resolve(source, dir);
  if (!statSync(appDir).isDirectory() || !existsSync(resolve(appDir, "manifest.json"))) continue;
  const { manifest, buffer } = await packageCustomAppDir(appDir);
  const file = `${dir}.zip`;
  const target = resolve(output, file);
  if (!existsSync(target) || !readFileSync(target).equals(buffer)) {
    if (check) stale.push(file); else writeFileSync(target, buffer);
  }
  index.push({ id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description || "", file });
}
const indexText = JSON.stringify(index, null, 2) + "\n";
const indexPath = resolve(output, "index.json");
if (!existsSync(indexPath) || readFileSync(indexPath, "utf8") !== indexText) {
  if (check) stale.push("index.json"); else writeFileSync(indexPath, indexText);
}

if (stale.length > 0) {
  console.error(`public/custom-apps 落后于源码：${stale.join("、")}。请运行 npm run apps:build-dist。`);
  process.exit(1);
}
console.log(`[custom-apps-dist] ${check ? "已核对" : "已发布"} ${index.length} 个官方 APP。`);
