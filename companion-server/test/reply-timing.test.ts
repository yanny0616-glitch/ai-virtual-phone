import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("reply-timing.ts 和前端 lib/deferred-reply-timing.ts 是同一份规则", () => {
  const body = (path: string) => {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    return text.slice(text.indexOf("export type CloudReplyTiming"));
  };
  assert.equal(body("../src/reply-timing.ts"), body("../../lib/deferred-reply-timing.ts"));
});
