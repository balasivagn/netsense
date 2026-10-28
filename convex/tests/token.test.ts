import { describe, expect, test } from "vitest";
import { signJobToken, verifyJobToken } from "../lib/jobToken";

const secret = () => crypto.randomUUID();
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
async function independent(payload: string, key: string, signEncoded = false) {
  const bytes = new TextEncoder().encode(payload);
  const encoded = encode(bytes);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    signEncoded ? new TextEncoder().encode(encoded) : bytes,
  );
  return `${encoded}.${encode(new Uint8Array(signature))}`;
}
describe("job tokens", () => {
  test("independent HMAC signs raw UTF8 JSON, including non-ASCII and whitespace", async () => {
    const key = secret();
    const payload = '{ "exp":2000, "sessionId":"séance", "jobId":"job" }';
    const token = await independent(payload, key);
    expect(await verifyJobToken(token, key, 1000)).toEqual({
      jobId: "job",
      sessionId: "séance",
      exp: 2000,
    });
    expect(
      await verifyJobToken(await independent(payload, key, true), key, 1000),
    ).toBeNull();
    const claims = { jobId: "job", sessionId: "session", exp: 2000 };
    expect(await signJobToken(claims, key)).toBe(
      await independent(JSON.stringify(claims), key),
    );
  });
  test("rejects tampering, wrong/empty secret and exact expiry", async () => {
    const key = secret();
    const token = await signJobToken(
      { jobId: "job", sessionId: "session", exp: 2000 },
      key,
    );
    for (const invalid of [
      token + ".extra",
      token + "x",
      "",
      "a.b",
      token.replace(/^./, "!"),
    ])
      expect(await verifyJobToken(invalid, key, 1000)).toBeNull();
    expect(await verifyJobToken(token, secret(), 1000)).toBeNull();
    expect(await verifyJobToken(token, "", 1000)).toBeNull();
    expect(await verifyJobToken(token, key, 2000)).toBeNull();
    await expect(
      signJobToken({ jobId: "job", sessionId: "session", exp: 2000 }, ""),
    ).rejects.toThrow();
  });
  test.each([
    {},
    { jobId: "job", sessionId: "session", exp: 2000, extra: true },
    { jobId: "", sessionId: "session", exp: 2000 },
    { jobId: "job", exp: 2000 },
    { jobId: "job", sessionId: "session", exp: "2000" },
    { jobId: "job", sessionId: "session", exp: 2000.5 },
    { jobId: "job", sessionId: "session", exp: 999 },
  ])("rejects correctly signed invalid claims %#", async (payload) => {
    const key = secret();
    expect(
      await verifyJobToken(
        await independent(JSON.stringify(payload), key),
        key,
        1000,
      ),
    ).toBeNull();
  });
  test("rejects correctly signed malformed JSON", async () => {
    const key = secret();
    expect(
      await verifyJobToken(await independent("{", key), key, 1000),
    ).toBeNull();
  });
});

test("rejects noncanonical base64url segments even when unused bits decode identically", async () => {
  const key = crypto.randomUUID();
  const token = await signJobToken(
    { jobId: "job", sessionId: "session", exp: 2000 },
    key,
  );
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(token.at(-1)!);
  // SHA-256 signatures have two unused trailing base64 bits.
  const changed = token.slice(0, -1) + alphabet[last + 1];
  expect(await verifyJobToken(changed, key, 1000)).toBeNull();
});
