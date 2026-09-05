import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    // 挂念源码按顺序拼入同一个闭包，文件间共享顶层声明；它们不是独立 ES modules。
    files: ["custom-apps/gua-nian/src/**/*.js"],
    languageOptions: { sourceType: "script" },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["custom-apps/gua-nian/src/domain/*.mjs"],
    rules: {
      "no-restricted-globals": ["error", "S", "AiPhone", "window", "document", "fetch", "localStorage", "setTimeout", "setInterval"],
      "no-restricted-syntax": ["error",
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: "当前时间由调用方通过参数传入。" },
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "构造 Date 时必须传入明确时间。" },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "public/weixin-local-assistant/**",
    // .mjs 外皮下是给 Deno 用的 TypeScript，当 JS 解析必然报错
    "public/ai-phone-push/**",
    "supabase/functions/**",
  ]),
]);
