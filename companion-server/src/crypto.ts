// 个人云 push_jobs 里的加密载荷（AES-GCM，密钥 = SHA-256(payload_key + ":push-job-v1")）。
// 只在迁移时用：把云端冻结的提示词模板解出来当后端的初始快照。

export type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

export async function decryptPayload(payload: EncryptedPayload, secret: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const bytes = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
  const ct = bytes(payload.ct), tag = bytes(payload.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(payload.iv) }, key, combined);
  return new TextDecoder().decode(plain);
}

export async function encryptPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
  return { v: 1, iv: b64(iv), tag: b64(combined.slice(combined.length - 16)), ct: b64(combined.slice(0, combined.length - 16)) };
}
