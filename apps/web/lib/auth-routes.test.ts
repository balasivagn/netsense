import { describe, expect, it } from "vitest";
import { isCoachApiPath, isCoachPagePath } from "./auth-routes";

describe("coach auth route classification", () => {
  it("protects coach pages and only the future coach browser APIs", () => {
    expect(isCoachPagePath("/sessions")).toBe(true);
    expect(isCoachPagePath("/sessions/a/status")).toBe(true);
    expect(isCoachApiPath("/api/uploads")).toBe(true);
    expect(isCoachApiPath("/api/uploads/start")).toBe(true);
    expect(isCoachApiPath("/api/media/sign")).toBe(true);
  });

  it("does not mistake the proxy matcher for API authorization", () => {
    expect(isCoachApiPath("/api/worker/sign")).toBe(false);
    expect(isCoachApiPath("/api/media/local/session/file.mp4")).toBe(false);
    expect(isCoachApiPath("/api/l/token/code")).toBe(false);
    expect(isCoachPagePath("/l/token")).toBe(false);
    expect(isCoachPagePath("/sign-in")).toBe(false);
  });
});
