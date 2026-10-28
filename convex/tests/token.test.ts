import { describe, expect, test } from "vitest";
import { signJobToken, verifyJobToken } from "../lib/jobToken";

describe("job tokens", () => {
  test("accepts only a signed, live closed payload", async () => {
    const secret = "test-only-memory-secret";
    const token = await signJobToken({ jobId: "job", sessionId: "session", exp: 2_000 }, secret);
    await expect(verifyJobToken(token, secret, 1_000)).resolves.toEqual({ jobId: "job", sessionId: "session", exp: 2_000 });
    await expect(verifyJobToken(`${token}.extra`, secret, 1_000)).resolves.toBeNull();
    await expect(verifyJobToken(`${token.slice(0, -1)}x`, secret, 1_000)).resolves.toBeNull();
    await expect(verifyJobToken(token, secret, 2_000)).resolves.toBeNull();
  });
});
