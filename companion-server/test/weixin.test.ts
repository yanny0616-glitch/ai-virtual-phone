import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Store } from "../src/store.ts";
import { WeixinService } from "../src/weixin.ts";

test("vendor 里的微信核心和 tools/weixin-local-assistant 是同一份", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.equal(read("../src/vendor/weixin-assistant-core.mjs"), read("../../tools/weixin-local-assistant/assistant-core.mjs"));
});

function fakeCore(tag: string, calls: string[]) {
  return {
    WEIXIN_CORE_PROTOCOL_VERSION: 3,
    setMediaReplyEnabled: () => {},
    pollOnce: async (env: Record<string, string>) => { calls.push(`${tag}:${env.SUPABASE_BUCKET}`); return { results: [{ received: 2, autoReply: { sent: 1 } }] }; },
  };
}

test("开关：关着不轮询；开了用桶里的核心轮询并记心跳；桶里协议不对退回内置", async () => {
  const store = new Store(":memory:");
  const calls: string[] = [];
  const bucketCode = "export async function pollOnce(){}\nexport const WEIXIN_CORE_PROTOCOL_VERSION = 3;";
  const svc = new WeixinService({
    store, url: "https://cloud.test", key: "k", log: () => {},
    fetch: (async () => new Response(bucketCode)) as typeof fetch,
    importCore: async () => fakeCore("bucket", calls),
  });
  assert.deepEqual(await svc.tick(), {});
  assert.equal(calls.length, 0);
  store.setMeta("weixin:enabled", "1");
  const beat = await svc.tick();
  assert.deepEqual(calls, ["bucket:ai-phone-backup"]);
  assert.equal(beat.sent, 1);
  assert.equal(beat.received, 2);
  assert.equal(beat.codeSource, "bucket");
  assert.equal(svc.heartbeat().sent, 1);

  const old = new WeixinService({ store, url: "https://cloud.test", key: "k", log: () => {},
    fetch: (async () => new Response("export async function pollOnce(){}\nexport const WEIXIN_CORE_PROTOCOL_VERSION = 2;")) as typeof fetch,
    importCore: async () => { throw new Error("不该加载"); }, bundledCore: fakeCore("bundled", calls) });
  assert.equal((await old.tick()).codeSource, "bundled");
  assert.equal(calls.at(-1), "bundled:ai-phone-backup");

  store.setMeta("weixin:enabled", "0");
  assert.equal((await old.tick(true)).codeSource, "bundled", "手动测试一次不看开关");
});
