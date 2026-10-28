# L4 browser upload client handoff — T1.06 partial

## Exports

- `sha256Blob(blob, { chunkSize, signal, onProgress })` computes a streaming SHA-256 from Blob slices; it never buffers the whole clip.
- `MultipartUploadController` is the stateful browser controller. Construct it with the coach/session IDs, the picked File/Blob, `createUploadTransport()`, and `browserRecoveryStore()`.
- `createUploadTransport()` is the closed same-origin client for the five server endpoints from `L4_UPLOAD_HANDOFF.md`. Signed PUTs use `credentials: "omit"` and `redirect: "error"`.

## Screen integration

1. After the existing consent call succeeds, construct the controller and subscribe with `onEvent`.
2. Call `start()` after the file pick. Render only `snapshot.confirmedBytes` / `bytesTotal`; do not add local PUT bytes to progress.
3. Screen 08 calls `pause()` to stop hashing, PUTs, confirmations and retry waits. On Resume call `resume()`; it hashes again, re-initializes, and trusts `resumeFrom` from the server.
4. Route to screen 07a once state is `ready_to_complete`. Call `complete()` only from that explicit UI action; its nullable `jobId` means the upload awaits the subject tap.
5. The UI owns the cancel-confirmation dialog. Only its confirmed action calls `cancel()`; this sends `POST {}` to abort and clears recovery metadata.

Recovery metadata is scoped to coach/session and contains only source identity plus upload ID. It contains no signed URL, credentials, or part URL. A re-picked file is re-hashed before any part PUT; a mismatch is `UPLOAD_CHECKSUM`.

## Limits and integration gap

Part retries default to 2/8/30 seconds and are bounded. Whole-upload failures are exposed as `wholeUploadAttempts`, but the current five-endpoint server has no persisted whole-upload failure-attempt field. Screens may show `Upload failed` after three controller-recorded failures for the current browser lifetime; cross-reload persistence needs an explicit backend contract and is not invented here. R2 signed-PUT behavior remains **UNTESTED**; local PUT JSON plus ETag is covered by tests.
