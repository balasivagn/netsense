// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fixture from "../../../fixtures/synthetic/processing-status/coach-stages.json";
import { CoachStages, type CoachStagesJob } from "./coach-stages";

const labels = fixture.coachStages;
const job = fixture.runningJob as CoachStagesJob;

afterEach(cleanup);

describe("CoachStages", () => {
  it("uses only the supplied config labels and preserves their order", () => {
    render(<CoachStages coachStages={labels} job={job} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "○UploadPending",
      "○Hear your remarksPending",
      "●Match remarks to momentsIn progress",
      "○Follow your playerPending",
      "○Place and check marksPending",
      "○Prepare previewPending",
    ]);
    expect(screen.queryByText(/muse|sam|spark|worker/i)).toBeNull();
  });

  it("updates live progress and the current row without remounting", () => {
    const { rerender } = render(<CoachStages coachStages={labels} job={job} />);
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("0.25");
    rerender(<CoachStages coachStages={labels} job={{ ...job, coachStage: "Follow your player", progress: 0.5, progressLabel: "2 of 4" }} />);
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("0.5");
    expect(screen.getByText("2 of 4")).not.toBeNull();
    expect(screen.getByText("Follow your player").closest("li")?.getAttribute("data-stage-state")).toBe("current");
  });

  it("does not invent a progress value when the supplied value is missing or invalid", () => {
    const { rerender } = render(<CoachStages coachStages={labels} job={{ ...job, progress: undefined, progressLabel: undefined }} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(<CoachStages coachStages={labels} job={{ ...job, progress: Number.NaN }} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("distinguishes queued, running, completed and terminal rows without inferring waiting success", () => {
    const { rerender } = render(<CoachStages coachStages={labels} job={{ ...job, status: "queued", coachStage: "Upload" }} />);
    expect(screen.getByText("Upload").closest("li")?.getAttribute("data-stage-state")).toBe("current");
    rerender(<CoachStages coachStages={labels} job={{ ...job, status: "done" }} />);
    expect(screen.getAllByText("Completed")).toHaveLength(labels.length);
    rerender(<CoachStages coachStages={labels} job={{ ...job, status: "waiting_for_coach", coachStage: "Prepare preview" }} />);
    expect(screen.getByText("Prepare preview").closest("li")?.getAttribute("data-stage-state")).toBe("waiting");
    expect(screen.getByText("Upload").closest("li")?.getAttribute("data-stage-state")).toBe("pending");
  });

  it("keeps actionable and render terminal presentations parent-owned", () => {
    const terminal = (state: "action_needed" | "render_fallback") => <p>{state === "action_needed" ? "Open recovery screen" : "Use live marks"}</p>;
    const { rerender } = render(<CoachStages coachStages={labels} job={{ ...job, status: "failed", coachStage: "Follow your player" }} terminalState="action_needed" renderTerminal={terminal} />);
    expect(screen.getByText("Follow your player").closest("li")?.getAttribute("data-stage-state")).toBe("needs-attention");
    expect(screen.getByText("Open recovery screen")).not.toBeNull();
    rerender(<CoachStages coachStages={labels} job={{ ...job, status: "waiting_for_coach", coachStage: "Prepare preview" }} terminalState="render_fallback" renderTerminal={terminal} />);
    expect(screen.getByText("Use live marks")).not.toBeNull();
    expect(screen.queryByText("RENDER_FAIL")).toBeNull();
  });

  it("provides an announced status, accessible Back action, and wrapping hooks for long configured labels", () => {
    const longLabel = "A configured stage label that remains readable on a narrow phone screen without overflow";
    render(<CoachStages coachStages={[longLabel]} job={{ status: "running", coachStage: longLabel, progressLabel: "Current work" }} />);
    expect(screen.getByRole("status").textContent).toBe("Your draft is being prepared.");
    expect(screen.getByRole("link", { name: "Back to Sessions" }).getAttribute("href")).toBe("/sessions");
    expect(screen.getByText(longLabel).className).toContain("label");
  });
});
