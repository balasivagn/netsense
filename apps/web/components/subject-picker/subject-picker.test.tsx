// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/video/grab-frame", () => ({ grabFrame: vi.fn(() => Promise.reject(new Error("decode failed"))) }));
import { grabFrame, type GrabbedFrame } from "../../lib/video/grab-frame";
import { SubjectPicker } from "./subject-picker";

const selectionFrames = [
  { idx: 4, ms: 1240, url: "https://example.invalid/frame.jpg" },
  { idx: 8, ms: 2480, url: "https://example.invalid/frame-2.jpg" },
];

function renderPicker(props: Partial<ComponentProps<typeof SubjectPicker>> = {}) {
  const onConfirm = vi.fn();
  render(<SubjectPicker onConfirm={onConfirm} onRetake={vi.fn()} role="batter" selectionFrames={selectionFrames} {...props} />);
  const image = screen.getByAltText("Selected video frame");
  Object.defineProperties(image, { naturalWidth: { value: 400, configurable: true }, naturalHeight: { value: 200, configurable: true } });
  fireEvent.load(image);
  const target = screen.getByRole("button", { name: "Tap the player to follow" });
  target.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON() { return {}; } });
  return { onConfirm, target };
}

afterEach(() => { cleanup(); vi.mocked(grabFrame).mockReset(); vi.mocked(grabFrame).mockRejectedValue(new Error("decode failed")); });

describe("SubjectPicker", () => {
  it("starts without a subject and confirms the normalized remote-frame payload after a tap", async () => {
    const user = userEvent.setup();
    const { onConfirm, target } = renderPicker();
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Role: Batter")).not.toBeNull();
    expect(screen.getByText("Tap the player to follow. Other people in the video are ignored.")).not.toBeNull();
    fireEvent.pointerUp(target, { clientX: 100, clientY: 100 });
    expect(screen.getAllByLabelText("Selected player")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith({ frameMs: 1240, point: { x: 0.5, y: 0.5 }, role: "batter" });
  });

  it("suppresses a duplicate confirmation while the parent reports pending", async () => {
    const user = userEvent.setup();
    const { onConfirm, target } = renderPicker({ confirmationState: "pending" });
    fireEvent.pointerUp(target, { clientX: 100, clientY: 100 });
    const confirm = screen.getByRole("button", { name: "Confirming…" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clears a stale tap when a supplied selection frame changes", async () => {
    const user = userEvent.setup();
    const { target } = renderPicker();
    fireEvent.pointerUp(target, { clientX: 100, clientY: 100 });
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "0:02" }));
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Selected player")).toBeNull();
  });

  it("offers the parent-owned upload fallback when local decode fails", async () => {
    const fallback = vi.fn();
    render(<SubjectPicker file={new File(["bad"], "clip.mov")} onConfirm={vi.fn()} onRequestPickAfterUpload={fallback} onRetake={vi.fn()} role="other" />);
    await screen.findByRole("button", { name: "Pick after upload" });
    expect(fallback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pick after upload" }));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Pick after upload" })).not.toBeNull();
  });
});

function setTargetBounds() {
  const target = screen.getByRole("button", { name: "Tap the player to follow" });
  target.getBoundingClientRect = () => new DOMRect(0, 0, 200, 200);
  return target;
}
const localFrame: GrabbedFrame = { frameMs: 0, durationMs: 3000, width: 400, height: 200, url: "data:image/jpeg;base64,first" };

it("places a marker within the contained image and recomputes it on resize", () => {
  const { target } = renderPicker();
  fireEvent.pointerUp(target, { clientX: 100, clientY: 50 });
  const marker = screen.getByLabelText("Selected player");
  expect(marker.style.top).toBe("25%");
  expect(marker.style.left).toBe("50%");
  target.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
  fireEvent(window, new Event("resize"));
  expect(marker.style.top).toBe("0%");
});

it("invalidates a tap immediately while a replacement local frame decodes", async () => {
  let finish: (frame: GrabbedFrame) => void = () => { throw new Error("Missing deferred decode"); };
  vi.mocked(grabFrame).mockResolvedValueOnce(localFrame).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<SubjectPicker file={new File(["video"], "clip.mp4")} role="batter" onConfirm={vi.fn()} onRetake={vi.fn()} />);
  await screen.findByAltText("Selected video frame");
  fireEvent.pointerUp(setTargetBounds(), { clientX: 100, clientY: 100 });
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole("slider"), { target: { value: "1000" } });
  expect(screen.queryByAltText("Selected video frame")).toBeNull();
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish({ ...localFrame, frameMs: 1000, url: "data:image/jpeg;base64,second" }));
  expect(screen.queryByLabelText("Selected player")).toBeNull();
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
});

it("ignores a late decode from a replaced file and callback identity changes", async () => {
  let finishOld: (frame: GrabbedFrame) => void = () => { throw new Error("Missing deferred decode"); };
  vi.mocked(grabFrame).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce({ ...localFrame, url: "data:image/jpeg;base64,newfile" });
  const newFile = new File(["video"], "second.mp4");
  const props = { role: "batter" as const, onConfirm: vi.fn(), onRetake: vi.fn() };
  const { rerender } = render(<SubjectPicker {...props} file={new File(["video"], "first.mp4")} />);
  rerender(<SubjectPicker {...props} file={newFile} onRequestPickAfterUpload={() => undefined} />);
  await screen.findByAltText("Selected video frame");
  rerender(<SubjectPicker {...props} file={newFile} onRequestPickAfterUpload={() => undefined} />);
  await act(async () => finishOld(localFrame));
  expect(screen.getByAltText("Selected video frame").getAttribute("src")).toBe("data:image/jpeg;base64,newfile");
  expect(grabFrame).toHaveBeenCalledTimes(2);
});

it("clears confirmation when an image fails and prevents selecting its stale dimensions", () => {
  const { target } = renderPicker();
  fireEvent.pointerUp(target, { clientX: 100, clientY: 100 });
  fireEvent.error(screen.getByAltText("Selected video frame"));
  fireEvent.pointerUp(target, { clientX: 100, clientY: 100 });
  expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(true);
});
