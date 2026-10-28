# L6 transcode handoff — T1.12

`TranscodeWorker` is `transcode.ffmpeg@1`, a `StageWorker` tool implementation.
It validates both frozen contracts, streams only the storage-provided signed URL
into a temporary file, and verifies declared byte count plus SHA-256 before it
ever invokes ffprobe, ffmpeg, or publishes a derivative.

All source and derivative keys are canonical paths scoped to
`sessions/{sessionId}/`. The worker publishes only the normalized proxy, m4a,
WAV chunks, JPEG keyframes, and their JSON index. It makes no Convex writes and
does not persist a stage output; the parent DAG owns that boundary.

The default download uses a signed HTTP URL from `ctx.storage.get_url`; tests
inject the iterator transport, so network behavior is isolated at that boundary.
Temporary files are removed in `finally`. HEVC/MOV processing is marked
**UNTESTED** when the local ffmpeg build lacks `libx265`; the synthetic generator
records that capability explicitly.

Parent review added typed `StageWorker` conformance, deadline checks before
download/signing and between chunks/tools/uploads, bounded socket stalls, and
safe error mapping for transport failures. A default download accepts HTTP(S)
only; socket reads time out after at most one second without progress (the DAG
owns retries). Injected transports must also bound their blocking I/O. No raw
transport exception is returned in stage results. Canonical key checks reject
encoded paths, backslashes and control characters before requesting a URL.

The full network/storage client, upload retry behavior and DAG integration remain
pending. Tests exercise actual local ffmpeg for MP4, WebM and HEVC/MOV, plus an
in-memory HTTP response boundary; no live storage or vendor API was called.
