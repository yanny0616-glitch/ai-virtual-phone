// 官方自定义 APP 安装包的唯一打包口径：三个构建脚本都从这里出 zip，
// 字节才能对得上（check 逐字节比、宿主启动时按 index.json 自动升级）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** 不进安装包的目录/文件：源码、架构说明、历史 zip */
const EXCLUDED = new Set(["src", "ARCHITECTURE.md"]);

export function listCustomAppPackageFiles(dir) {
  const files = [];
  const walk = (sub) => {
    for (const name of readdirSync(resolve(dir, sub))) {
      if (name.endsWith(".zip") || name.startsWith(".")) continue;
      const rel = sub ? `${sub}/${name}` : name;
      if (!sub && EXCLUDED.has(name)) continue;
      const full = resolve(dir, rel);
      if (statSync(full).isDirectory()) walk(rel);
      else if (statSync(full).isFile()) files.push(rel);
    }
  };
  walk("");
  const head = ["manifest.json", "index.html"].filter(name => files.includes(name));
  const rest = files.filter(name => !head.includes(name)).sort();
  return [...head, ...rest];
}

/** 文件时间固定为 0：内容不变字节就不变 */
export async function packageCustomAppDir(dir, overrides = {}) {
  const { default: JSZip } = await import("jszip");
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
  if (manifest.entry !== "index.html" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error(`${dir}：安装包需要 index.html 入口和 x.y.z 版本号。`);
  }
  const zip = new JSZip();
  for (const file of listCustomAppPackageFiles(dir)) {
    const content = file in overrides ? overrides[file] : readFileSync(resolve(dir, file));
    zip.file(file, content, { date: new Date(0), createFolders: false });
  }
  return { manifest, buffer: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) };
}
