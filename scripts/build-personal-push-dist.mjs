#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

copyFileSync(resolve(root, "supabase/functions/ai-phone-push/index.ts"), resolve(output, "gateway.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-generate/index.ts"), resolve(output, "push-generate.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-shortcut-result/index.ts"), resolve(output, "push-shortcut-result.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-bridge/index.ts"), resolve(output, "push-bridge.mjs"));
copyFileSync(resolve(root, "supabase/functions/screen-chat/index.ts"), resolve(output, "screen-chat.mjs"));
copyFileSync(resolve(root, "supabase/functions/push-recheck/index.ts"), resolve(output, "push-recheck.mjs"));
copyFileSync(resolve(root, "docs/personal-push-supabase.sql"), resolve(output, "schema.sql"));

console.log("[personal-push-dist] 已生成个人离线推送部署包。");
