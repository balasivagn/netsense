# L1 Screen 12 handoff

T1.13's reusable `CoachStages` component is ready for the authenticated status route.

```tsx
<CoachStages
  coachStages={config.coachStages}
  job={{
    status: job.status,
    coachStage: job.coachStage,
    progress: job.progress,
    progressLabel: job.progressLabel,
  }}
  terminalState={terminalState}
  renderTerminal={(state) => /* parent-owned Screen 13–16 or render fallback */ null}
/>
```

`coachStages` must be the job's pinned `pipeline_config.coachStages`, not a browser-side default. The component accepts exactly the six (or later-configured) labels supplied by its parent and preserves their order.

`progress` is the current normalised `0..1` roll-up written by `stageRuns`; the component hides the native progress bar for missing, non-finite, or out-of-range values. `progressLabel` is rendered only as React plaintext. It is never parsed as a count or converted into a made-up percentage.

The current job projection has no per-coach-row completion fields. Accordingly, the component marks every row complete only when `job.status === "done"`; during queued/running/waiting/failed/cancelled states it marks only the supplied `coachStage` as current, waiting, or needing attention and leaves every other row pending. It does not infer earlier-row success or that `waiting_for_coach` means a complete draft.

For parent routing, set `terminalState="action_needed"` and supply `renderTerminal` for Screens 13–16, or set `terminalState="render_fallback"` for the parent-owned live-overlay fallback. Error codes, retry controls, internal attempts, worker IDs, provider/model names, raw errors, and logs are intentionally outside this component.

T1.13 remains **PARTIAL**: the live authenticated route, Convex query/subscription, and Playwright fake-pipeline coverage are parent work. Visual/device checks are **UNTESTED**.
