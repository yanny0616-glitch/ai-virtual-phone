// 个人云部署包代号的共享算法：build 与 check 用同一份摘要口径。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const VERSION_BLOCK = /\/\/ BEGIN PERSONAL PUSH VERSION\nconst PERSONAL_PUSH_FUNCTIONS_VERSION = (\d+);\n\/\/ END PERSONAL PUSH VERSION/;

/** 部署到用户 Supabase 的全部内容；版本块本身不参与摘要，否则 +1 会再触发 +1 */
const DEPLOYED_SOURCES = [
  "supabase/functions/ai-phone-push/index.ts",
  "supabase/functions/push-generate/index.ts",
  "supabase/functions/push-shortcut-result/index.ts",
  "supabase/functions/push-bridge/index.ts",
  "supabase/functions/screen-chat/index.ts",
  "supabase/functions/push-recheck/index.ts",
  "docs/personal-push-supabase.sql",
];

export function computePersonalPushDigest(root) {
  const hash = createHash("sha256");
  for (const file of DEPLOYED_SOURCES) {
    hash.update(file).update("\0");
    hash.update(readFileSync(resolve(root, file), "utf8").replace(VERSION_BLOCK, "")).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

export function readPersonalPushVersion(root) {
  const text = readFileSync(resolve(root, "lib/personal-push-version.ts"), "utf8");
  const version = Number(text.match(/PERSONAL_PUSH_FUNCTIONS_VERSION = (\d+)/)?.[1] ?? 0);
  const digest = text.match(/PERSONAL_PUSH_FUNCTIONS_DIGEST = "([0-9a-f]*)"/)?.[1] ?? "";
  return { version, digest };
}
