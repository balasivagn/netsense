// @vitest-environment node
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), getToken: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
import { getCoachRouteAuth } from "./coach-route-auth";
beforeEach(() => { mocks.auth.mockReset(); mocks.getToken.mockReset(); });

test("native Convex integration uses the session token without a legacy template", async () => {
  const opaque = crypto.randomUUID();
  mocks.getToken.mockResolvedValue(opaque);
  mocks.auth.mockResolvedValue({ userId: "coach-a", sessionClaims: { aud: "convex" }, getToken: mocks.getToken });
  const result = await getCoachRouteAuth();
  expect(result?.convexToken === opaque).toBe(true);
  expect(mocks.getToken).toHaveBeenCalledWith({});
});
test("legacy integration requests the convex JWT template", async () => {
  mocks.getToken.mockResolvedValue(crypto.randomUUID());
  mocks.auth.mockResolvedValue({ userId: "coach-a", sessionClaims: {}, getToken: mocks.getToken });
  expect((await getCoachRouteAuth())?.clerkUserId).toBe("coach-a");
  expect(mocks.getToken).toHaveBeenCalledWith({ template: "convex" });
});
test("missing identity or missing token fail closed", async () => {
  mocks.auth.mockResolvedValue({ userId: null, getToken: mocks.getToken });
  expect(await getCoachRouteAuth()).toBeNull();
  expect(mocks.getToken).not.toHaveBeenCalled();
  mocks.getToken.mockResolvedValue(null);
  mocks.auth.mockResolvedValue({ userId: "coach-a", sessionClaims: {}, getToken: mocks.getToken });
  expect(await getCoachRouteAuth()).toBeNull();
});
