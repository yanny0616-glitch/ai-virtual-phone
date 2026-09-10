#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computePersonalPushDigest, readPersonalPushVersion, VERSION_BLOCK } from "./lib/personal-push-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public/ai-phone-push");
mkdirSync(output, { recursive: true });

// The browser serializer and cloud worker share this pure timing contract.
const workerPath = resolve(root, "supabase/functions/push-generate/index.ts");
const timing = readFileSync(resolve(root, "lib/deferred-reply-timing.ts"), "utf8").replace(/^export /gm, "").trim();
writeFileSync(workerPath, readFileSync(workerPath, "utf8").replace(
  /\/\/ BEGIN DEFERRED REPLY TIMING[\s\S]*?\/\/ END DEFERRED REPLY TIMING/,
  `// BEGIN DEFERRED REPLY TIMING\n${timing}\n// END DEFERRED REPLY TIMING`,
));

const silence = readFileSync(resolve(root, "lib/chat-silence-protocol.ts"), "utf8").replace(/^export /gm, "").trim();
writeFileSync(workerPath, readFileSync(workerPath, "utf8").replace(
  /\/\/ BEGIN CHAT SILENCE PROTOCOL[\s\S]*?\/\/ END CHAT SILENCE PROTOCOL/,
  () => `// BEGIN CHAT SILENCE PROTOCOL\n${silence}\n// END CHAT SILENCE PROTOCOL`,
));

for (const name of ["push-recheck", "push-generate"]) {
  const path = resolve(root, `supabase/functions/${name}/index.ts`);
  let code = readFileSync(path, "utf8");
  for (const [label, source] of [["GUANIAN CLOUD HISTORY", "lib/guanian-cloud-history.ts"], ["GUANIAN PROMISES", "custom-apps/gua-nian/src/domain/promises.mjs"]]) {
    const shared = readFileSync(resolve(root, source), "utf8").replace(/^export /gm, "").trim();
    const block = `// BEGIN ${label}\n${shared}\n// END ${label}`;
    const pattern = new RegExp(`// BEGIN ${label}[\\s\\S]*?// END ${label}`);
    code = pattern.test(code) ? code.replace(pattern, () => block) : code + "\n" + block + "\n";
  }
  writeFileSync(path, code);
}

// 部署包代号：内容（版本块除外）变了就 +1，写回 lib 常量并内联进网关 health
{
  const digest = computePersonalPushDigest(root);
  const current = readPersonalPushVersion(root);
  const version = current.digest === digest ? current.version : current.version + 1;
  writeFileSync(resolve(root, "lib/personal-push-version.ts"), [
    "// 个人云部署包的代号：push:build-dist 发现云函数或 schema 内容变了就自动 +1，",
    "// 网关 health 回报它，宿主对不上就提示「云服务需要重新部署」。不要手改。",
    `export const PERSONAL_PUSH_FUNCTIONS_VERSION = ${version};`,
    `export const PERSONAL_PUSH_FUNCTIONS_DIGEST = "${digest}";`,
    "",
  ].join("\n"));
  const gatewayPath = resolve(root, "supabase/functions/ai-phone-push/index.ts");
  writeFileSync(gatewayPath, readFileSync(gatewayPath, "utf8").replace(VERSION_BLOCK, () => `// BEGIN PERSONAL PUSH VERSION\nconst PERSONAL_PUSH_FUNCTIONS_VERSION = ${version};\n// END PERSONAL PUSH VERSION`));
  if (version !== current.version) console.log(`[personal-push-dist] 部署包内容有变，代号 ${current.version} → ${version}。`);
}

copyFileSync(resolve(root, "supabase/functions/ai-phone-push/index.ts"), resolve(output, "gateway.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-generate/index.ts"), resolve(output, "push-generate.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-shortcut-result/index.ts"), resolve(output, "push-shortcut-result.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-bridge/index.ts"), resolve(output, "push-bridge.mjs"));
copyFileSync(resolve(root, "supabase/functions/screen-chat/index.ts"), resolve(output, "screen-chat.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-recheck/index.ts"), resolve(output, "push-recheck.mjs"));
copyFileSync(resolve(root, "docs/personal-push-supabase.sql"), resolve(output, "schema.sql"));

console.log("[personal-push-dist] 已生成个人离线推送部署包。");
