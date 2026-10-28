# L6 render handoff — T1.21

`RenderWorker(download=..., track_loader=..., object_exists=...)` is a typed
`render.ffmpeg@1` StageWorker, deliberately not registered by this lane. L5 must
provide bounded signed-URL downloading, a bounded track-file loader, and an
object existence check for session-scoped prior segment reuse; then construct it
only for the frozen `RenderInput` worker configuration. It returns `RenderOutput`
and never chooses an approval snapshot.

The renderer requires each supplied segment to exactly equal the deterministic
merge of annotations with gaps **less than** 1000ms. Its hash is SHA-256 of compact
sorted JSON `{startMs,endMs,annotations}`, where each annotation includes every
frozen `RenderInput.annotations` field (and therefore track refs). Segment IDs are
opaque because the frozen contract defines no segment-ID format. L5 must build
these values before calling the worker. `previousSegments` is reused only when the
pair `(segmentId, hash)` matches, the key is session-scoped and `object_exists`
confirms it.

Known frozen-contract limitation: `RenderInput` has no source/proxy checksum and
no track artifact digest, so a content hash cannot prove that bytes behind an
unchanged `trackFileRef` or `proxyKey` are unchanged. L5 should invalidate previous
segments whenever either referenced artifact is replaced. Final-job approval
selection and T1.26 wiring are intentionally not covered.

`fixtures/synthetic/overlay-geometry.json` is the geometry agreement for C16:
proxy-pixel units, exclusive x2/y2 boxes, half-up rounding, arrow side offsets and
half-open timing. The renderer does not interpolate missing track frames and does
not draw through TrackFile gaps or swaps.
