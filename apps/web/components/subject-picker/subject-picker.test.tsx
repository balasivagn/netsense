// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/video/grab-frame", () => ({ grabFrame: vi.fn(() => Promise.reject(new Error("decode failed"))) }));
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

afterEach(() => cleanup());

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
    await waitFor(() => expect(fallback).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Pick after upload" })).not.toBeNull();
  });
});
