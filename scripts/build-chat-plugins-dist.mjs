#!/usr/bin/env node
// 仓库自带的聊天插件（chat-plugins/*.js）随宿主一起发布到 public/chat-plugins/，
// 并生成 index.json 供 App 内「官方插件」一键安装、启动时自动更新。

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "chat-plugins");
const output = resolve(root, "public/chat-plugins");
mkdirSync(output, { recursive: true });

const pick = (text, key) => {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, "m"));
  return m ? m[1] : "";
};

const index = [];
for (const file of readdirSync(source).filter(f => f.endsWith(".js")).sort()) {
  const text = readFileSync(resolve(source, file), "utf8");
  const id = pick(text, "id");
  if (!id) continue;
  copyFileSync(resolve(source, file), resolve(output, file));
  index.push({ id, name: pick(text, "name") || id, version: pick(text, "version") || "0", description: pick(text, "description"), file });
}
writeFileSync(resolve(output, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`[chat-plugins-dist] 已发布 ${index.length} 个官方插件。`);
