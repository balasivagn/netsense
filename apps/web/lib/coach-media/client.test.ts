// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { loadMedia } from "./client";
afterEach(() => {
  vi.unstubAllGlobals();
});
const response = () => ({
  url: `${location.origin}/api/media/local/sessions/owned/proxy.mp4?exp=1&sig=test-only`,
  expiresAt: Date.now() + 60000,
  width: 640,
  height: 360,
  durationMs: 2000,
});
test("bounded client only accepts expiring same-origin session URLs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(response())),
  );
  expect(
    (await loadMedia("owned", "proxy", new AbortController().signal)).url,
  ).toContain("/sessions/owned/");
  for (const patch of [
    { url: "https://foreign.invalid/media" },
    { url: `${location.origin}/api/media/local/sessions/foreign/proxy.mp4` },
    { expiresAt: 0 },
    { width: Infinity },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...response(), ...patch })),
    );
    await expect(
      loadMedia("owned", "proxy", new AbortController().signal),
    ).rejects.toThrow();
  }
});
test("oversized/malformed body and non-subject track reject", async () => {
  for (const value of [
    " ".repeat(1048577),
    "{",
    JSON.stringify({
      ...response(),
      trackId: "t",
      track: { fps: 10, subjectOnly: false, frames: [], gaps: [], swaps: [] },
    }),
  ]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(value)),
    );
    await expect(
      loadMedia("owned", "track:r", new AbortController().signal),
    ).rejects.toThrow();
  }
});
