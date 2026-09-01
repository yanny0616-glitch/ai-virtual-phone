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
    // 扩展名是 .mjs，内容却是给 Deno 边缘函数用的 TypeScript（与
    // supabase/functions/*/index.ts 字节一致，npm run check:push 会验）。
    // 浏览器只把它们当文本 fetch 后上传部署，从不执行，所以 TS 语法是对的——
    // 但 eslint 按扩展名当 JS 解析必然报 Parsing error。
    "public/ai-phone-push/**",
    "supabase/functions/**",
  ]),
]);
