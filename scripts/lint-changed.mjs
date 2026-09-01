#!/usr/bin/env node
// 只 lint 改动过的文件。全量 `eslint .` 要跑几分钟（900+ 源文件 × 类型感知规则
// × React Compiler 数据流分析），日常改几个文件时没必要全扫。
//
//   npm run lint:changed                     只查未提交的改动（默认，提交前自查用这个）
//   npm run lint:changed -- HEAD~3           对比指定基准
//   npm run lint:changed -- upstream/main    查本地 fork 相对上游的全部改动
//   npm run lint:changed -- --fix            透传 eslint 参数
//
// 无改动时直接退出，绝不退化成 `eslint .`——那正是要避开的全量扫描。

import { execFileSync, spawnSync } from "node:child_process";

const LINTABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function git(args) {
    try {
        return execFileSync("git", args, { encoding: "utf8" });
    } catch {
        return "";
    }
}

function revExists(ref) {
    return spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" }).status === 0;
}

// 参数里第一个不以 - 开头的当作对比基准，其余透传给 eslint。
const argv = process.argv.slice(2);
const baseArg = argv.find(a => !a.startsWith("-"));
const passthrough = argv.filter(a => a !== baseArg);

// 默认 HEAD = 只查工作区里还没提交的改动。这是提交前自查最常要的范围；
// 传 upstream/main 之类的分支名时改用 merge-base，免得把上游改动算成"我改的"。
let base = "HEAD";
if (baseArg) {
    base = revExists(baseArg) && baseArg !== "HEAD"
        ? (git(["merge-base", "HEAD", baseArg]).trim() || baseArg)
        : baseArg;
}

const files = new Set();
for (const line of [
    git(["diff", "--name-only", "--diff-filter=ACMR", base]),      // 相对基准的已提交改动
    git(["diff", "--name-only", "--diff-filter=ACMR"]),            // 未暂存
    git(["diff", "--name-only", "--diff-filter=ACMR", "--cached"]),// 已暂存
    git(["ls-files", "--others", "--exclude-standard"]),           // 未跟踪的新文件
].join("\n").split("\n")) {
    const file = line.trim();
    if (file && LINTABLE.test(file)) files.add(file);
}

const targets = [...files];
if (targets.length === 0) {
    console.log(`没有相对 ${base} 改动过的可 lint 文件，跳过。`);
    process.exit(0);
}

console.log(`lint ${targets.length} 个改动文件（基准 ${base}）：`);
for (const file of targets) console.log(`  ${file}`);

// --no-error-on-unmatched-pattern：文件被 globalIgnores 排除时不报错退出
// --no-warn-ignored：显式点名了被忽略的文件（如 supabase/functions/**）时不刷警告
const result = spawnSync(
    "npx",
    [
        "eslint",
        "--no-error-on-unmatched-pattern",
        "--no-warn-ignored",
        "--cache",
        "--cache-location",
        ".eslintcache",
        ...passthrough,
        ...targets,
    ],
    { stdio: "inherit" },
);
process.exit(result.status ?? 1);
