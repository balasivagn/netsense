// @vitest-environment node
import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ protect: vi.fn(), calls: vi.fn(), options: {} as { signInUrl?: string } }));
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (callback: (auth: { protect: typeof mocks.protect }, request: NextRequest) => Promise<void>, options: { signInUrl?: string }) => {
    mocks.options = options;
    return async (request: NextRequest) => {
      mocks.calls();
      await callback({ protect: mocks.protect }, request);
      return NextResponse.next();
    };
  },
}));
beforeEach(() => {
  vi.resetModules();
  mocks.protect.mockReset();
  mocks.calls.mockReset();
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", crypto.randomUUID());
  vi.stubEnv("CLERK_SECRET_KEY", crypto.randomUUID());
});
afterEach(() => vi.unstubAllEnvs());
const request = (pathname: string) => new NextRequest(`https://app.invalid${pathname}`);
const event = {} as NextFetchEvent;

test("configured proxy protects coach routes and configures the local sign-in page", async () => {
  const { default: proxy } = await import("./proxy");
  for (const pathname of ["/sessions", "/sessions/a/status", "/api/uploads", "/api/uploads/part.json", "/api/media/sign"]) {
    await proxy(request(pathname), event);
  }
  expect(mocks.protect).toHaveBeenCalledTimes(5);
  expect(mocks.options.signInUrl).toBe("/sign-in");
});

test("worker, local media and student API authorization never passes through Clerk", async () => {
  const { default: proxy } = await import("./proxy");
  for (const pathname of ["/api/worker/sign", "/api/media/local/sessions/a/proxy.mp4", "/api/l/token/code", "/api/l/token/media"]) {
    expect((await proxy(request(pathname), event))?.status).toBe(200);
  }
  expect(mocks.calls).not.toHaveBeenCalled();
});

test("unconfigured coach pages redirect locally; coach APIs fail closed", async () => {
  vi.stubEnv("CLERK_SECRET_KEY", "");
  const { default: proxy } = await import("./proxy");
  const page = await proxy(request("/sessions"), event);
  expect(page?.headers.get("location")).toBe("https://app.invalid/sign-in");
  expect((await proxy(request("/api/uploads"), event))?.status).toBe(503);
  expect(mocks.calls).not.toHaveBeenCalled();
});
