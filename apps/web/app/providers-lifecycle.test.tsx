// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  auth: { isLoaded: true, userId: "coach-a" as string | null, sessionId: "session-a" as string | null },
  convex: { isLoading: false, isAuthenticated: true },
  ensure: vi.fn(),
  clients: [] as { close: ReturnType<typeof vi.fn> }[],
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => state.auth }));
vi.mock("convex/react", () => ({
  ConvexReactClient: class {
    close = vi.fn(async () => undefined);
    constructor() { state.clients.push(this); }
  },
  useConvexAuth: () => state.convex,
  useMutation: () => state.ensure,
}));
vi.mock("convex/react-clerk", () => ({ ConvexProviderWithClerk: ({ children }: { children: ReactNode }) => children }));
import { AppProviders, CoachProvisioningGate } from "./providers";

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tree = () => <AppProviders><CoachProvisioningGate><p>Protected content</p></CoachProvisioningGate></AppProviders>;

beforeEach(() => {
  state.auth = { isLoaded: true, userId: "coach-a", sessionId: "session-a" };
  state.convex = { isLoading: false, isAuthenticated: true };
  state.clients.length = 0;
  state.ensure.mockReset();
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://convex.invalid");
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

test("children wait for server authentication and successful provisioning", async () => {
  const pending = deferred();
  state.ensure.mockReturnValue(pending.promise);
  state.convex = { isLoading: true, isAuthenticated: false };
  const view = render(tree());
  expect(state.ensure).not.toHaveBeenCalled();
  expect(screen.queryByText("Protected content")).toBeNull();
  state.convex = { isLoading: false, isAuthenticated: true };
  view.rerender(tree());
  expect(state.ensure).toHaveBeenCalledOnce();
  expect(screen.queryByText("Protected content")).toBeNull();
  await act(async () => pending.resolve());
  expect(screen.getByText("Protected content")).not.toBeNull();
  view.rerender(tree());
  expect(state.ensure).toHaveBeenCalledOnce();
});

test("account/session switch mounts a fresh client and never retains prior readiness", async () => {
  state.ensure.mockResolvedValue(undefined);
  const view = render(tree());
  await act(async () => undefined);
  expect(screen.getByText("Protected content")).not.toBeNull();
  const prior = state.clients[0];
  const pending = deferred();
  state.ensure.mockReturnValue(pending.promise);
  state.auth = { isLoaded: true, userId: "coach-b", sessionId: "session-b" };
  view.rerender(tree());
  expect(state.clients).toHaveLength(2);
  expect(screen.queryByText("Protected content")).toBeNull();
  await act(async () => undefined);
  expect(prior.close).toHaveBeenCalledOnce();
  await act(async () => pending.resolve());
  expect(screen.getByText("Protected content")).not.toBeNull();
  state.auth = { ...state.auth, sessionId: "session-b-new" };
  state.ensure.mockReturnValue(new Promise(() => undefined));
  view.rerender(tree());
  expect(state.clients).toHaveLength(3);
  expect(screen.queryByText("Protected content")).toBeNull();
});

test("late completion from a previous identity cannot unlock a new identity", async () => {
  const old = deferred();
  const current = deferred();
  state.ensure.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const view = render(tree());
  state.auth = { isLoaded: true, userId: "coach-b", sessionId: "session-b" };
  view.rerender(tree());
  await act(async () => old.resolve());
  expect(screen.queryByText("Protected content")).toBeNull();
  await act(async () => current.reject());
  expect(screen.getByRole("alert").textContent).toContain("couldn’t verify");
  expect(screen.queryByText("Protected content")).toBeNull();
});

test("logout immediately hides content and does not provision another coach", async () => {
  state.ensure.mockResolvedValue(undefined);
  const view = render(tree());
  await act(async () => undefined);
  state.auth = { isLoaded: true, userId: null, sessionId: null };
  view.rerender(tree());
  expect(screen.queryByText("Protected content")).toBeNull();
  expect(state.ensure).toHaveBeenCalledOnce();
});

test("Strict Mode replay does not close the mounted client; unmount closes it once", async () => {
  state.ensure.mockResolvedValue(undefined);
  const view = render(<StrictMode>{tree()}</StrictMode>);
  await act(async () => undefined);
  expect(state.clients.every(client => client.close.mock.calls.length === 0)).toBe(true);
  const active = state.clients[0];
  view.unmount();
  await act(async () => undefined);
  expect(active.close).toHaveBeenCalledOnce();
});
