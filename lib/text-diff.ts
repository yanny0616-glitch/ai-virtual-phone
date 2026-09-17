// 预设条目同步时给「当前 / 内置」两段文字做对比：先按行找出增删，再在成对改动的行里标出改了哪几个字。

export type DiffSpan = { text: string; kind: "same" | "add" | "del" };
export type DiffLine =
    | { kind: "same"; text: string }
    | { kind: "add" | "del"; spans: DiffSpan[] }
    | { kind: "gap"; count: number };

function lcsOps<T>(a: T[], b: T[]): Array<{ op: "same" | "add" | "del"; a?: T; b?: T }> {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const ops: Array<{ op: "same" | "add" | "del"; a?: T; b?: T }> = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ op: "same", a: a[i], b: b[j] }); i += 1; j += 1; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: "del", a: a[i] }); i += 1; }
        else { ops.push({ op: "add", b: b[j] }); j += 1; }
    }
    while (i < n) ops.push({ op: "del", a: a[i++] });
    while (j < m) ops.push({ op: "add", b: b[j++] });
    return ops;
}

function merge(spans: DiffSpan[]): DiffSpan[] {
    const out: DiffSpan[] = [];
    for (const span of spans) {
        const last = out[out.length - 1];
        if (last && last.kind === span.kind) last.text += span.text;
        else if (span.text) out.push({ ...span });
    }
    return out;
}

// 字级对比 O(n·m)，太长的行直接整行标红绿
const CHAR_DIFF_LIMIT = 600;

function charDiff(before: string, after: string): { del: DiffSpan[]; add: DiffSpan[] } {
    if (before.length * after.length > CHAR_DIFF_LIMIT * CHAR_DIFF_LIMIT) {
        return { del: [{ text: before, kind: "del" }], add: [{ text: after, kind: "add" }] };
    }
    const del: DiffSpan[] = [], add: DiffSpan[] = [];
    for (const step of lcsOps([...before], [...after])) {
        if (step.op === "same") { del.push({ text: step.a!, kind: "same" }); add.push({ text: step.b!, kind: "same" }); }
        else if (step.op === "del") del.push({ text: step.a!, kind: "del" });
        else add.push({ text: step.b!, kind: "add" });
    }
    return { del: merge(del), add: merge(add) };
}

/** 只留改动附近 context 行，其余相同的行折成「N 行相同」 */
export function diffText(before: string, after: string, context = 1): { lines: DiffLine[]; added: number; removed: number } {
    const ops = lcsOps(before.split("\n"), after.split("\n"));
    const raw: DiffLine[] = [];
    let added = 0, removed = 0;
    for (let k = 0; k < ops.length;) {
        if (ops[k].op === "same") { raw.push({ kind: "same", text: ops[k].a! }); k += 1; continue; }
        const dels: string[] = [], adds: string[] = [];
        while (k < ops.length && ops[k].op !== "same") {
            if (ops[k].op === "del") dels.push(ops[k].a!); else adds.push(ops[k].b!);
            k += 1;
        }
        removed += dels.length; added += adds.length;
        const paired = Math.min(dels.length, adds.length);
        const delLines: DiffLine[] = [], addLines: DiffLine[] = [];
        for (let p = 0; p < paired; p += 1) {
            const { del, add } = charDiff(dels[p], adds[p]);
            delLines.push({ kind: "del", spans: del });
            addLines.push({ kind: "add", spans: add });
        }
        for (const text of dels.slice(paired)) delLines.push({ kind: "del", spans: [{ text, kind: "del" }] });
        for (const text of adds.slice(paired)) addLines.push({ kind: "add", spans: [{ text, kind: "add" }] });
        raw.push(...delLines, ...addLines);
    }
    const keep = raw.map(line => line.kind !== "same");
    raw.forEach((line, index) => {
        if (line.kind === "same") return;
        for (let d = 1; d <= context; d += 1) {
            if (index - d >= 0) keep[index - d] = true;
            if (index + d < raw.length) keep[index + d] = true;
        }
    });
    const lines: DiffLine[] = [];
    raw.forEach((line, index) => {
        if (keep[index]) { lines.push(line); return; }
        const last = lines[lines.length - 1];
        if (last?.kind === "gap") last.count += 1;
        else lines.push({ kind: "gap", count: 1 });
    });
    return { lines, added, removed };
}
