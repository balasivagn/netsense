// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { coachProvisioningPlan } from "./providers";

describe("coach provisioning bootstrap", () => {
  it("waits until Clerk and Convex have authenticated the same browser session", () => {
    expect(
      coachProvisioningPlan({
        clerkLoaded: false,
        convexLoading: true,
        clerkUserId: null,
        convexAuthenticated: false,
      }),
    ).toBe("wait");
    expect(
      coachProvisioningPlan({
        clerkLoaded: true,
        convexLoading: true,
        clerkUserId: "coach_1",
        convexAuthenticated: false,
      }),
    ).toBe("wait");
    expect(
      coachProvisioningPlan({
        clerkLoaded: true,
        convexLoading: false,
        clerkUserId: "coach_1",
        convexAuthenticated: true,
      }),
    ).toBe("provision");
  });

  it("fails closed on sign-out or when Convex rejects the Clerk identity", () => {
    expect(
      coachProvisioningPlan({
        clerkLoaded: true,
        convexLoading: false,
        clerkUserId: null,
        convexAuthenticated: false,
      }),
    ).toBe("unavailable");
    expect(
      coachProvisioningPlan({
        clerkLoaded: true,
        convexLoading: false,
        clerkUserId: "coach_2",
        convexAuthenticated: false,
      }),
    ).toBe("unavailable");
  });
});
