#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePersonalPushDigest, readPersonalPushVersion, VERSION_BLOCK } from "./lib/personal-push-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["supabase/functions/ai-phone-push/index.ts", "public/ai-phone-push/gateway.mjs"],
  ["supabase/functions/push-generate/index.ts", "public/ai-phone-push/push-generate.mjs"],
  ["supabase/functions/push-shortcut-result/index.ts", "public/ai-phone-push/push-shortcut-result.mjs"],
  ["supabase/functions/push-bridge/index.ts", "public/ai-phone-push/push-bridge.mjs"],
  ["supabase/functions/screen-chat/index.ts", "public/ai-phone-push/screen-chat.mjs"],
  ["supabase/functions/push-recheck/index.ts", "public/ai-phone-push/push-recheck.mjs"],
  ["docs/personal-push-supabase.sql", "public/ai-phone-push/schema.sql"],
];

const failures = [];
const timing = readFileSync(resolve(root, "lib/deferred-reply-timing.ts"), "utf8").replace(/^export /gm, "").trim();
const worker = readFileSync(resolve(root, "supabase/functions/push-generate/index.ts"), "utf8");
if (!worker.includes(`// BEGIN DEFERRED REPLY TIMING\n${timing}\n// END DEFERRED REPLY TIMING`)) failures.push("云端延后回复规则与共享源码不一致");
const silence = readFileSync(resolve(root, "lib/chat-silence-protocol.ts"), "utf8").replace(/^export /gm, "").trim();
if (!worker.includes(`// BEGIN CHAT SILENCE PROTOCOL\n${silence}\n// END CHAT SILENCE PROTOCOL`)) failures.push("云端沉默协议与共享源码不一致");
for (const name of ["push-recheck", "push-generate"]) {
  const code = readFileSync(resolve(root, `supabase/functions/${name}/index.ts`), "utf8");
  for (const [label, path] of [["GUANIAN CLOUD HISTORY", "lib/guanian-cloud-history.ts"], ["GUANIAN PROMISES", "custom-apps/gua-nian/src/domain/promises.mjs"]]) {
    const shared = readFileSync(resolve(root, path), "utf8").replace(/^export /gm, "").trim();
    if (!code.includes(`// BEGIN ${label}\n${shared}\n// END ${label}`)) failures.push(`${name} 的 ${label} 与共享源码不一致`);
  }
}
{
  const current = readPersonalPushVersion(root);
  if (current.digest !== computePersonalPushDigest(root)) failures.push("云函数或 schema 内容变了，但部署包代号没有更新");
  const gateway = readFileSync(resolve(root, "supabase/functions/ai-phone-push/index.ts"), "utf8").match(VERSION_BLOCK);
  if (!gateway || Number(gateway[1]) !== current.version) failures.push("网关内联的部署包代号与 lib/personal-push-version.ts 不一致");
}
for (const [source, output] of pairs) {
  const sourceText = readFileSync(resolve(root, source), "utf8");
  const outputText = readFileSync(resolve(root, output), "utf8");
  if (sourceText !== outputText) failures.push(`${output} 与 ${source} 不一致`);
}

const forbiddenOrigin = "floatbubble.netlify.app";
for (const file of [...new Set(pairs.flat())]) {
  if (readFileSync(resolve(root, file), "utf8").includes(forbiddenOrigin)) {
    failures.push(`${file} 含有私有站点地址`);
  }
}

if (failures.length > 0) {
  console.error(failures.map(item => `- ${item}`).join("\n"));
  console.error("请运行 npm run push:build-dist 后重试。");
  process.exit(1);
}

console.log("[personal-push-dist] 源文件、公开部署包与通用站点配置一致。");
