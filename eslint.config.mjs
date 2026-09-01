import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    "out/**",
    "public/weixin-local-assistant/**",
    // .mjs 外皮下是给 Deno 用的 TypeScript，当 JS 解析必然报错
    "public/ai-phone-push/**",
    "supabase/functions/**",
  ]),
]);
