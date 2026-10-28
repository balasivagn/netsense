# L6 checker handoff — T1.20

Base: `d0b3aafb8f493754380317711be8e25c1a988fd5` (parent adapter fixes on the
unmerged L5 candidate; dependencies PR #3 and foundation PR #1 remain pending).

## Delivered boundary

`CheckRulesWorker` in `runner/netsense_runner/stages/s7_check.py` implements
the frozen stage metadata `check.rules@1`, `check`, `rules`, `CheckInput` and
`CheckOutput`.  Construct it as:

```python
CheckRulesWorker(track_file_loader, CheckerConfig(min_mark_coverage=0.6), subject_role)
```

`track_file_loader: Callable[[str], bytes]` is intentionally supplied by the
parent runner's signed-storage path; this worker has no HTTP client and never
writes Convex.  `subject_role` is optional because the frozen `CheckInput` has
no role.  If it is not supplied, neutral labels fail rather than inferring a
role.  The parent should pass the pinned session `batter`, `bowler`, or `other`
role when it has it.  `CheckerConfig` is constructor-injected, has defaults
`min_mark_coverage=0.6` and `label_max_utf16_units=60`, and has no environment
override.

The loader bytes are UTF-8 decoded and validated with `validate_contract` as a
`TrackFile`; malformed tracks, non-`subjectOnly` input, reversed/zero-area or
non-finite boxes, invalid gaps, and duplicate transcript turn IDs are rejected
with a safe stage failure (`SEG_BAD_INPUT`).  No raw track or transcript is
logged.  A `player_missing` output is a `needs_coach` result: swap has
`SUBJECT_SWAP`, otherwise `SUBJECT_NOT_FOUND`.

## Time and coverage convention

All ranges are half-open: `[startMs, endMs)`.  A mark must have positive length
and lie wholly in its moment.  Frames and swap entries at exactly `endMs` do not
apply to that mark.  For positive fps, expected observations are
`ceil((end-start) * fps / 1000)`.  Only unique, valid frame timestamps inside
the mark count, and a declared gap excludes an observation.  Thus unsorted data
is harmless, duplicate timestamps cannot improve coverage, sparse data remains
low coverage, and no box is extrapolated into missing time.  For `fps == 0`, a
single valid frame inside the mark is required; an empty still track never
passes.  Empty/zero-length marks are `outside_moment`.

The pure session helper is `should_route_to_stills(remarks, stills_threshold)`.
It accepts `TrackedRemark(kind, error_code)`, excludes `note_only` and
`general_note`, requires a finite threshold in `[0, 1]`, and returns true only
when the tracked `SEG_NO_TRACK`/`SEG_BAD_INPUT` proportion reaches it.  It does
not mutate mode/config or force stills; the future DAG owns that choice.

## Integration pending

L5/T1.09 should call the worker after stage-boundary validation and use its
returned `StageResult`; it owns persistence and per-remark isolation.  No
schema changes were made.
