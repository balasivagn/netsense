# L1 subject picker handoff

This component slice implements screen 07a only. It does not own a route, upload, authentication, persistence, selection-frame extraction, job gating, or E2E coverage.

```ts
<SubjectPicker
  file={localFileOrNull}
  role={session.subjectRole}
  selectionFrames={serverFrames} // [{ idx, ms, url }] only after the parent obtains them
  confirmationState={"idle" | "pending" | "error"}
  confirmationError={setSubjectError}
  onConfirm={({ frameMs, point, role }) => setSubject({ frameMs, point, role })}
  onRetake={() => chooseAnotherClip()}
  onRequestPickAfterUpload={() => requestSelectionFramesAfterCompletedUpload()}
/>
```

`onConfirm` deliberately excludes `selectedBy`, timestamps, identity, and auth claims: the authenticated backend sets those. `confirmationState="pending"` disables duplicate confirmation. A parent must surface `JOB_IN_PROGRESS` or any other `setSubject` error through `confirmationError`.

For a decode failure, the component asks the parent for the approved post-upload fallback and offers **Pick after upload**. It does not claim frame extraction exists and does not upload or fetch media itself. Once the parent provides real server selection frames, their supplied `ms` values are preserved.
