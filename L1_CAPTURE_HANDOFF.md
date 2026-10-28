# L1 Screen 06 capture-controls handoff

This branch supplies only the presentational, stateful Screen 06 component at
`apps/web/components/capture/screen06-capture-controls.tsx`. It is a partial UI
slice for T1.37/T1.06, not the complete tasks.

## Exported boundary

```ts
type CaptureMode = "camera" | "camera_roll";

type Screen06CaptureControlsProps = {
  scopeKey: string;
  onConfirmConsent(): Promise<void>;
  onFileSelected(file: File, captureMode: CaptureMode): void | Promise<void>;
  uploadError?: "CONSENT_REQUIRED" | null;
};
```

`scopeKey` must change whenever either authenticated coach identity or session
identity changes. That clears the local checkbox state and invalidates late
promise completions. The component starts unticked for every scope.

The record route must pass `onConfirmConsent` that calls the existing
`sessions.confirmConsent` mutation for the current session. It must also pass
the upload controller's current error as `uploadError`; when its value is
`CONSENT_REQUIRED`, this component unticks and displays exactly `Please confirm
before uploading.` The component deliberately does not provide a revoke call:
unticking only closes local file-picker gating; the persisted confirmation is
immutable server-side.

After `onFileSelected`, the parent owns the existing upload controller,
including hashing, upload, decode/subject-selection flow, progress and routing.
The component holds a picked `File` only for the duration of the callback and
never reads, hashes, uploads or decodes it. It supplies `"camera"` for the
`capture="environment"` picker and `"camera_roll"` for the regular picker.

## Included coverage

The component tests cover initial/pending/success/failure consent, untick while
pending, scope reset and unmount late completions, `CONSENT_REQUIRED`, both
picker attributes, synthetic dispatch after confirmation, repeat selection,
picker cancellation and recoverable selection failure. They do not claim real
camera, login, controller integration or E2E coverage.
