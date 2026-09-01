#!/usr/bin/env node
//   npm run lint:changed                     只查未提交的改动（默认）
//   npm run lint:changed -- HEAD~3           对比指定基准
//   npm run lint:changed -- upstream/main    查本地 fork 相对上游的全部改动
//   npm run lint:changed -- --fix            透传 eslint 参数

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

const argv = process.argv.slice(2);
const baseArg = argv.find(a => !a.startsWith("-"));
const passthrough = argv.filter(a => a !== baseArg);

// 传分支名时取 merge-base，否则上游领先的提交会被算成本地改动
let base = "HEAD";
if (baseArg) {
    base = revExists(baseArg) && baseArg !== "HEAD"
        ? (git(["merge-base", "HEAD", baseArg]).trim() || baseArg)
        : baseArg;
}

const files = new Set();
for (const line of [
    git(["diff", "--name-only", "--diff-filter=ACMR", base]),
    git(["diff", "--name-only", "--diff-filter=ACMR"]),
    git(["diff", "--name-only", "--diff-filter=ACMR", "--cached"]),
    git(["ls-files", "--others", "--exclude-standard"]),
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
