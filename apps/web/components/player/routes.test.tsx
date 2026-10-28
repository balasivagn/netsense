// @vitest-environment jsdom
// Actual route composition and Convex transactions; controlled Clerk/query/media seams, not browser E2E.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { getFunctionName, type FunctionReference } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import { reviewReady } from "../../../../convex/tests/reviewHelpers";
import type { Playback } from "../../lib/overlay/draw";
const state = vi.hoisted(() => ({
  id: "",
  user: "owner",
  login: "login",
  detail: undefined as unknown,
  playback: undefined as unknown,
  mutate: undefined as unknown,
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: state.user, sessionId: state.login }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: state.id }),
  useRouter: () => ({ push: state.push, replace: state.replace }),
}));
vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) =>
    args === "skip"
      ? undefined
      : getFunctionName(ref) === "coachSessions:detail"
        ? state.detail
        : state.playback,
  useMutation: (ref: FunctionReference<"mutation">) => (args: unknown) =>
    (state.mutate as (ref: unknown, args: unknown) => Promise<unknown>)(
      ref,
      args,
    ),
}));
vi.mock("../../lib/coach-media/client", () => ({ loadMedia: vi.fn() }));
import { loadMedia } from "../../lib/coach-media/client";
import Layout from "../../app/sessions/[id]/layout";
import PlaybackPage from "../../app/sessions/[id]/playback/page";
import ReviewPage from "../../app/sessions/[id]/review/page";
import { OverlayCanvas } from "./overlay-canvas";
let callbacks: Map<number, VideoFrameRequestCallback>;
let serial = 0;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.user = "owner";
  state.login = "login";
  vi.clearAllMocks();
});
async function harness() {
  const c = await reviewReady();
  state.id = c.sessionId;
  state.user = c.view.ownerUserId;
  state.playback = c.view;
  state.detail = await c.coach.query(api.coachSessions.detail, {
    sessionId: c.sessionId,
  });
  state.mutate = (ref: FunctionReference<"mutation">, args: never) =>
    c.coach.mutation(ref, args);
  callbacks = new Map();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (fn) {
    callbacks.set(++serial, fn);
    return serial;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
    callbacks.delete(id);
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.mocked(loadMedia).mockImplementation(async (_id, asset) =>
    asset.startsWith("track:")
      ? {
          track: { fps: 0, subjectOnly: true, frames: [], gaps: [], swaps: [] },
          trackId: c.view.tracks[0].trackId,
          width: 640,
          height: 360,
          durationMs: 2000,
        }
      : {
          url: `http://localhost/api/media/local/sessions/${c.sessionId}/${asset}`,
          expiresAt: Date.now() + 600000,
          width: 640,
          height: 360,
          durationMs: 2000,
        },
  );
  return {
    ...c,
    refresh: async () => {
      state.playback = await c.coach.query(api.playback.get, {
        sessionId: c.sessionId,
      });
    },
  };
}
test("playback prefers preview without canvas, stale delete uses proxy + overlay, seek and callback cleanup", async () => {
  const c = await harness();
  const ui = render(
    <Layout>
      <PlaybackPage />
    </Layout>,
  );
  await waitFor(() =>
    expect(ui.container.querySelector("video")?.src).toContain("preview"),
  );
  expect(ui.container.querySelector("canvas")).toBeNull();
  await c.coach.mutation(api.review.delete, { annotationId: c.id });
  await c.refresh();
  ui.rerender(
    <Layout>
      <PlaybackPage />
    </Layout>,
  );
  await waitFor(() =>
    expect(ui.container.querySelector("video")?.src).toContain("proxy"),
  );
  expect(ui.container.querySelector("canvas")).not.toBeNull();
  expect(callbacks.size).toBe(1);
  const words = (state.playback as Playback).remarks[0].words;
  fireEvent.click(screen.getByRole("button", { name: new RegExp(words) }));
  expect(ui.container.querySelector("video")?.currentTime).toBe(
    (state.playback as Playback).remarks[0].momentStartMs! / 1000,
  );
  const video = ui.container.querySelector("video")!;
  ui.unmount();
  expect(video.hasAttribute("src")).toBe(false);
  expect(callbacks.size).toBe(0);
});
test("actual review route approve/edit/delete/undo and separate correction persist through real transactions", async () => {
  const c = await harness();
  const ui = render(
    <Layout>
      <ReviewPage />
    </Layout>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
  await waitFor(async () =>
    expect(
      (await c.coach.query(api.playback.get, { sessionId: c.sessionId }))
        .annotations[0].status,
    ).toBe("approved"),
  );
  await c.refresh();
  ui.rerender(
    <Layout>
      <ReviewPage />
    </Layout>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Approved (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit / Move" }));
  fireEvent.change(screen.getByLabelText("Position"), {
    target: { value: "box_bottom" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save placement" }));
  await waitFor(async () =>
    expect(
      (await c.coach.query(api.playback.get, { sessionId: c.sessionId }))
        .annotations[0].placedBy,
    ).toBe("coach"),
  );
  await c.refresh();
  ui.rerender(
    <Layout>
      <ReviewPage />
    </Layout>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Needs you (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(async () =>
    expect(
      (await c.coach.query(api.playback.get, { sessionId: c.sessionId }))
        .annotations[0].status,
    ).toBe("deleted"),
  );
  await c.refresh();
  ui.rerender(
    <Layout>
      <ReviewPage />
    </Layout>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Undo delete" }));
  await waitFor(async () =>
    expect(
      (await c.coach.query(api.playback.get, { sessionId: c.sessionId }))
        .annotations[0].status,
    ).toBe("needs_you"),
  );
  fireEvent.click(
    screen.getAllByRole("button", { name: "Fix transcription" })[0],
  );
  const original = c.view.remarks[0].turns[0].text;
  fireEvent.change(screen.getByLabelText("Corrected words"), {
    target: { value: original + " " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(async () =>
    expect(
      (await c.coach.query(api.playback.get, { sessionId: c.sessionId }))
        .remarks[0].turns[0].correctedText,
    ).toBe(original + " "),
  );
  await c.refresh();
  ui.rerender(
    <Layout>
      <ReviewPage />
    </Layout>,
  );
  expect(screen.getByText("corrected by coach")).toBeTruthy();
  expect(screen.getAllByRole("blockquote")[0].textContent).toBe(
    c.view.remarks[0].words,
  );
});
test("late media response after login scope change cannot display prior coach media", async () => {
  await harness();
  let resolve!: (v: Awaited<ReturnType<typeof loadMedia>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof loadMedia>>>(
    (r) => (resolve = r),
  );
  vi.mocked(loadMedia).mockReturnValue(promise);
  const ui = render(
    <Layout>
      <PlaybackPage />
    </Layout>,
  );
  state.user = "";
  ui.rerender(
    <Layout>
      <PlaybackPage />
    </Layout>,
  );
  await act(async () =>
    resolve({
      url: "http://localhost/private-old",
      expiresAt: Date.now() + 60000,
      width: 640,
      height: 360,
      durationMs: 2000,
    }),
  );
  expect(ui.container.querySelector("video")).toBeNull();
  expect(callbacks.size).toBe(0);
});
test("frame callback observer and seek listener cleanup", async () => {
  const c = await harness();
  const v = document.createElement("video");
  const ui = render(
    <OverlayCanvas video={{ current: v }} data={c.view} tracks={{}} />,
  );
  expect(callbacks.size).toBe(1);
  ui.unmount();
  expect(callbacks.size).toBe(0);
});

test("preview decode failure switches to proxy with live canvas, never double draws", async () => {
  await harness();
  const ui = render(
    <Layout>
      <PlaybackPage />
    </Layout>,
  );
  await waitFor(() =>
    expect(ui.container.querySelector("video")?.src).toContain("preview"),
  );
  fireEvent.error(ui.container.querySelector("video")!);
  await waitFor(() =>
    expect(ui.container.querySelector("video")?.src).toContain("proxy"),
  );
  expect(ui.container.querySelector("canvas")).not.toBeNull();
});

test("stills keeps permanent banner, real persisted still strip, and unmarked video", async () => {
  const c = await harness();
  const ref = `sessions/${c.sessionId}/stills/${c.id}.jpg`;
  await c.t.run(async (ctx) => {
    await ctx.db.patch(c.sessionId, { renderMode: "stills" });
    const render = await ctx.db.query("renders").unique();
    await ctx.db.patch(render!._id, {
      mode: "stills",
      fileRef: undefined,
      stillRefs: [{ annotationId: c.id, key: ref }],
    });
  });
  await c.refresh();
  const ui = render(
    <Layout>
      <PlaybackPage />
    </Layout>,
  );
  await screen.findByAltText("Marked still frame");
  expect(screen.getByText("Still frames only")).toBeTruthy();
  expect(ui.container.querySelector("canvas")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Watch unmarked video" }));
  await waitFor(() =>
    expect(ui.container.querySelector("video")?.src).toContain("proxy"),
  );
  expect(screen.getByText("Still frames only")).toBeTruthy();
  expect(ui.container.querySelector("canvas")).toBeNull();
});

test("Hear coach uses original spans, stops at endpoint/unmount and hides typed audio", async () => {
  const c = await harness();
  const { HearCoach } = await import("./hear-coach");
  const audio = document.createElement("audio");
  const play = vi.spyOn(audio, "play").mockResolvedValue();
  const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
  vi.stubGlobal("Audio", function () {
    return audio;
  });
  const remark = c.view.remarks[0];
  const ui = render(<HearCoach sessionId={c.sessionId} remark={remark} />);
  fireEvent.click(screen.getByRole("button", { name: "Hear coach" }));
  await waitFor(() =>
    expect(vi.mocked(loadMedia)).toHaveBeenCalledWith(
      c.sessionId,
      "audio",
      expect.any(AbortSignal),
    ),
  );
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(remark.turns[0].startMs / 1000);
  expect(play).toHaveBeenCalledOnce();
  audio.currentTime = remark.turns[0].endMs / 1000;
  fireEvent.timeUpdate(audio);
  expect(pause).toHaveBeenCalled();
  ui.unmount();
  expect(audio.onloadedmetadata).toBeNull();
  render(
    <HearCoach
      sessionId={c.sessionId}
      remark={{ ...remark, source: "typed" }}
    />,
  );
  expect(screen.queryByRole("button", { name: "Hear coach" })).toBeNull();
});

test("simple review is configurable and limits editing to retiming", async () => {
  await harness();
  vi.stubEnv("FEATURE_REVIEW_MODE", "simple");
  try {
    render(
      <Layout>
        <ReviewPage />
      </Layout>,
    );
    expect(
      screen.queryByRole("navigation", { name: "Review tabs" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retime" }));
    expect(screen.getByLabelText("Start (milliseconds)")).toBeTruthy();
    expect(screen.queryByLabelText("Mark")).toBeNull();
    expect(screen.queryByLabelText("Label")).toBeNull();
  } finally {
    vi.unstubAllEnvs();
  }
});

test("direct coach switch hides cached old playback/review projection", async () => {
  await harness();
  const ui = render(
    <Layout>
      <ReviewPage />
    </Layout>,
  );
  expect(screen.getAllByRole("blockquote").length).toBeGreaterThan(0);
  state.user = "another-coach";
  ui.rerender(
    <Layout>
      <ReviewPage />
    </Layout>,
  );
  expect(screen.queryAllByRole("blockquote")).toHaveLength(0);
});

test("Hear coach does not skip original speech when its media clock stalls", async () => {
  const c = await harness();
  const { HearCoach } = await import("./hear-coach");
  const audio = document.createElement("audio");
  vi.spyOn(audio, "play").mockResolvedValue();
  const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
  vi.stubGlobal("Audio", function () { return audio; });
  render(<HearCoach sessionId={c.sessionId} remark={c.view.remarks[0]} />);
  fireEvent.click(screen.getByRole("button", { name: "Hear coach" }));
  await waitFor(() => expect(audio.onloadedmetadata).not.toBeNull());
  fireEvent.loadedMetadata(audio);
  vi.useFakeTimers();
  try {
    fireEvent.playing(audio);
    const turn = c.view.remarks[0].turns[0];
    await act(async () => { await vi.advanceTimersByTimeAsync(turn.endMs - turn.startMs + 100); });
    expect(pause).not.toHaveBeenCalled();
    fireEvent.waiting(audio);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(pause).not.toHaveBeenCalled();
    fireEvent.playing(audio);
    audio.currentTime = turn.endMs / 1000;
    fireEvent.timeUpdate(audio);
    expect(pause).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
