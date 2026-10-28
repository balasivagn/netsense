// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Screen06CaptureControls } from "./screen06-capture-controls";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function renderControls(props: Partial<ComponentProps<typeof Screen06CaptureControls>> = {}) {
  const onConfirmConsent = props.onConfirmConsent ?? vi.fn(async () => undefined);
  const onFileSelected = props.onFileSelected ?? vi.fn(async () => undefined);
  const view = render(
    <Screen06CaptureControls
      onConfirmConsent={onConfirmConsent}
      onFileSelected={onFileSelected}
      scopeKey="coach-a/session-a"
      {...props}
    />,
  );
  return { ...view, onConfirmConsent, onFileSelected };
}

function consentCheckbox() {
  return screen.getByRole("checkbox", { name: "Everyone filmed in this clip is an adult and agreed to be filmed." });
}

function cameraInput() {
  return screen.getByLabelText("Open camera", { selector: "input" }) as HTMLInputElement;
}

function cameraRollInput() {
  return screen.getByLabelText("Pick clip", { selector: "input" }) as HTMLInputElement;
}

async function confirmConsent() {
  fireEvent.click(consentCheckbox());
  await act(async () => undefined);
}

function dispatchFile(input: HTMLInputElement, file: File) {
  fireEvent.change(input, { target: { files: [file] } });
}

afterEach(cleanup);

describe("Screen06CaptureControls", () => {
  it("starts unticked with both file actions disabled", () => {
    renderControls();
    expect((consentCheckbox() as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Open camera" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Pick clip" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps file actions disabled while consent is pending, then enables them on success", async () => {
    const consent = deferred();
    const { onConfirmConsent } = renderControls({ onConfirmConsent: vi.fn(() => consent.promise) });
    fireEvent.click(consentCheckbox());
    expect(onConfirmConsent).toHaveBeenCalledTimes(1);
    expect((consentCheckbox() as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("button", { name: "Open camera" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => consent.resolve());
    expect((screen.getByRole("button", { name: "Open camera" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Pick clip" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("returns to an unticked retryable state when consent fails", async () => {
    const failed = deferred();
    const retry = deferred();
    const onConfirmConsent = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    renderControls({ onConfirmConsent });
    fireEvent.click(consentCheckbox());
    await act(async () => failed.reject());
    expect((consentCheckbox() as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("We could not confirm this. Please try again.");
    fireEvent.click(consentCheckbox());
    expect(onConfirmConsent).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve());
    expect((screen.getByRole("button", { name: "Pick clip" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not re-enable actions when consent is unticked while confirmation is pending", async () => {
    const consent = deferred();
    renderControls({ onConfirmConsent: vi.fn(() => consent.promise) });
    fireEvent.click(consentCheckbox());
    fireEvent.click(consentCheckbox());
    await act(async () => consent.resolve());
    expect((consentCheckbox() as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Open camera" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ignores late consent and file completions after a scope change or unmount", async () => {
    const consent = deferred();
    const selection = deferred();
    const afterUnmount = deferred();
    const onFileSelected = vi.fn().mockReturnValueOnce(selection.promise).mockReturnValueOnce(afterUnmount.promise);
    const { rerender, unmount } = renderControls({
      onConfirmConsent: vi.fn(() => consent.promise),
      onFileSelected,
    });
    fireEvent.click(consentCheckbox());
    rerender(<Screen06CaptureControls onConfirmConsent={vi.fn(async () => undefined)} onFileSelected={onFileSelected} scopeKey="coach-b/session-b" />);
    await act(async () => consent.resolve());
    expect((consentCheckbox() as HTMLInputElement).checked).toBe(false);
    await confirmConsent();
    dispatchFile(cameraInput(), new File(["synthetic-video-bytes"], "synthetic-clip.mp4", { type: "video/mp4" }));
    rerender(<Screen06CaptureControls onConfirmConsent={vi.fn(async () => undefined)} onFileSelected={onFileSelected} scopeKey="coach-c/session-c" />);
    await act(async () => selection.resolve());
    expect((screen.getByRole("button", { name: "Open camera" }) as HTMLButtonElement).disabled).toBe(true);
    await confirmConsent();
    dispatchFile(cameraInput(), new File(["synthetic-video-bytes"], "synthetic-clip.mp4", { type: "video/mp4" }));
    unmount();
    await act(async () => afterUnmount.resolve());
  });

  it("resets local gating on an explicit CONSENT_REQUIRED upload error", async () => {
    const { rerender, onConfirmConsent, onFileSelected } = renderControls();
    await confirmConsent();
    expect((screen.getByRole("button", { name: "Open camera" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<Screen06CaptureControls onConfirmConsent={onConfirmConsent} onFileSelected={onFileSelected} scopeKey="coach-a/session-a" uploadError="CONSENT_REQUIRED" />);
    expect((consentCheckbox() as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Please confirm before uploading.");
    expect((screen.getByRole("button", { name: "Open camera" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses distinct camera and camera-roll input attributes", () => {
    renderControls();
    expect(cameraInput().getAttribute("accept")).toBe("video/*");
    expect(cameraInput().getAttribute("capture")).toBe("environment");
    expect(cameraRollInput().getAttribute("accept")).toBe("video/*");
    expect(cameraRollInput().hasAttribute("capture")).toBe(false);
  });

  it("dispatches a synthetic selected file only after consent and supports selecting it repeatedly", async () => {
    const { onFileSelected } = renderControls();
    const clip = new File(["synthetic-video-bytes"], "synthetic-clip.mp4", { type: "video/mp4" });
    dispatchFile(cameraInput(), clip);
    expect(onFileSelected).not.toHaveBeenCalled();
    await confirmConsent();
    dispatchFile(cameraInput(), clip);
    await act(async () => undefined);
    dispatchFile(cameraInput(), clip);
    await act(async () => undefined);
    expect(onFileSelected).toHaveBeenNthCalledWith(1, clip, "camera");
    expect(onFileSelected).toHaveBeenNthCalledWith(2, clip, "camera");
  });

  it("does nothing when the picker is cancelled and recovers from an async selection failure", async () => {
    const selected = deferred();
    const onFileSelected = vi.fn(() => selected.promise);
    renderControls({ onFileSelected });
    await confirmConsent();
    fireEvent.change(cameraRollInput(), { target: { files: [] } });
    expect(onFileSelected).not.toHaveBeenCalled();
    dispatchFile(cameraRollInput(), new File(["synthetic-video-bytes"], "synthetic-clip.mp4", { type: "video/mp4" }));
    expect((screen.getByRole("button", { name: "Pick clip" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => selected.reject());
    expect(screen.getByRole("alert").textContent).toContain("We could not use that clip. Please try again.");
    expect((screen.getByRole("button", { name: "Pick clip" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
