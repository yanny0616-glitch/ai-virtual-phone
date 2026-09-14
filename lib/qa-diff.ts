// 提案卡的按行 diff：纯函数、零依赖，给 UI 展示「点应用前到底改了什么」。
// 行数超过上限时不做 LCS（O(n·m) 内存），退化成「整文件替换」提示。

export type QaDiffLine = { kind: "same" | "add" | "del"; text: string };
export type QaDiffHunk = { oldStart: number; newStart: number; lines: QaDiffLine[] };
export type QaLineDiff = {
    hunks: QaDiffHunk[];
    added: number;
    removed: number;
    /** 任一侧超过行数上限，未做逐行比对 */
    tooLarge: boolean;
};

export const QA_DIFF_MAX_LINES = 4000;
const CONTEXT_LINES = 3;

function splitLines(text: string): string[] {
    if (!text) return [];
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
}

/** 去掉公共头尾后再做 LCS，改一处的大文件几乎不花内存 */
function diffLines(a: string[], b: string[]): QaDiffLine[] {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const midA = a.slice(head, a.length - tail);
    const midB = b.slice(head, b.length - tail);

    const n = midA.length;
    const m = midB.length;
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i * (m + 1) + j] = midA[i] === midB[j]
                ? table[(i + 1) * (m + 1) + j + 1] + 1
                : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
        }
    }
    const out: QaDiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (midA[i] === midB[j]) {
            out.push({ kind: "same", text: midA[i] });
            i++;
            j++;
        } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) {
            out.push({ kind: "del", text: midA[i++] });
        } else {
            out.push({ kind: "add", text: midB[j++] });
        }
    }
    while (i < n) out.push({ kind: "del", text: midA[i++] });
    while (j < m) out.push({ kind: "add", text: midB[j++] });
    for (const text of a.slice(a.length - tail)) out.push({ kind: "same", text });
    return out;
}

function toHunks(lines: QaDiffLine[]): QaDiffHunk[] {
    const hunks: QaDiffHunk[] = [];
    let oldNo = 1;
    let newNo = 1;
    let current: QaDiffHunk | null = null;
    let trailing = 0; // 当前 hunk 末尾已带的上下文行数

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.kind === "same") {
            if (current) {
                if (trailing < CONTEXT_LINES) {
                    current.lines.push(line);
                    trailing++;
                } else {
                    // 再往后若 CONTEXT_LINES 内还有改动就合并，否则封口
                    const nextChange = lines.slice(index, index + CONTEXT_LINES + 1).findIndex((l) => l.kind !== "same");
                    if (nextChange === -1) current = null;
                    else current.lines.push(line);
                }
            }
            oldNo++;
            newNo++;
            continue;
        }
        if (!current) {
            const lead = lines.slice(Math.max(0, index - CONTEXT_LINES), index);
            current = { oldStart: oldNo - lead.length, newStart: newNo - lead.length, lines: [...lead] };
            hunks.push(current);
        }
        current.lines.push(line);
        trailing = 0;
        if (line.kind === "del") oldNo++;
        else newNo++;
    }
    return hunks;
}

export function computeQaLineDiff(oldText: string, newText: string): QaLineDiff {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    if (a.length > QA_DIFF_MAX_LINES || b.length > QA_DIFF_MAX_LINES) {
        return { hunks: [], added: b.length, removed: a.length, tooLarge: true };
    }
    const lines = diffLines(a, b);
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (line.kind === "add") added++;
        else if (line.kind === "del") removed++;
    }
    return { hunks: toHunks(lines), added, removed, tooLarge: false };
}
