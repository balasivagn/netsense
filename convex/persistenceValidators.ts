// Generated from JSON Schemas. Do not edit.
import { v } from "convex/values";
export const TranscodeOutput = v.object({
  proxyKey: v.string(),
  audioWavKeys: v.array(
    v.object({ key: v.string(), offsetMs: v.number(), durationMs: v.number() }),
  ),
  audioM4aKey: v.string(),
  durationMs: v.number(),
  width: v.number(),
  height: v.number(),
  fps: v.number(),
  frameCount: v.number(),
  keyframeIndexKey: v.string(),
  sha256Verified: v.literal(true),
});
export const TranscribeOutput = v.object({
  turns: v.array(
    v.object({
      turnId: v.string(),
      startMs: v.number(),
      endMs: v.number(),
      speaker: v.string(),
      text: v.string(),
    }),
  ),
  audioDurationMs: v.number(),
  providerSessionIds: v.array(v.string()),
});
export const PlanOutput = v.object({
  remarks: v.array(
    v.object({
      remarkId: v.string(),
      turnIds: v.array(v.string()),
      aboutSubject: v.union(
        v.literal("yes"),
        v.literal("no"),
        v.literal("unclear"),
        v.literal("general"),
      ),
      kind: v.union(
        v.literal("feedback"),
        v.literal("instruction"),
        v.literal("praise"),
        v.literal("other"),
      ),
      aboutHint: v.string(),
      atMs: v.number(),
      coachWords: v.string(),
    }),
  ),
  fanOut: v.array(
    v.object({
      remarkId: v.string(),
      stages: v.array(
        v.union(
          v.literal("moment"),
          v.literal("subject"),
          v.literal("track"),
          v.literal("place"),
          v.literal("check"),
        ),
      ),
    }),
  ),
  drafts: v.object({
    focus: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        why: v.string(),
        remarkIds: v.array(v.string()),
        source: v.literal("ai_draft"),
        approved: v.literal(false),
        editedByCoach: v.literal(false),
      }),
    ),
    practice: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        why: v.string(),
        remarkIds: v.array(v.string()),
        source: v.literal("ai_draft"),
        approved: v.literal(false),
        editedByCoach: v.literal(false),
      }),
    ),
    note: v.union(
      v.object({
        text: v.string(),
        why: v.string(),
        source: v.literal("ai_draft"),
        approved: v.literal(false),
      }),
      v.null(),
    ),
  }),
});
export const MomentOutput = v.object({
  remarkId: v.string(),
  startMs: v.number(),
  endMs: v.number(),
  keyframeMs: v.number(),
  keyframeIdx: v.number(),
  candidates: v.array(v.object({ startMs: v.number(), endMs: v.number() })),
  why: v.string(),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
});
export const SubjectAnchorOutput = v.object({
  anchorBox: v.object({
    x1: v.number(),
    y1: v.number(),
    x2: v.number(),
    y2: v.number(),
  }),
  anchorFrameMs: v.number(),
  referenceCropKey: v.string(),
  confidence: v.number(),
});
export const SubjectOutput = v.object({
  remarkId: v.string(),
  target: v.object({
    role: v.union(v.literal("batter"), v.literal("bowler"), v.literal("other")),
    promptBox: v.object({
      x1: v.number(),
      y1: v.number(),
      x2: v.number(),
      y2: v.number(),
    }),
    promptPoint: v.union(v.object({ x: v.number(), y: v.number() }), v.null()),
    frameMs: v.number(),
  }),
  method: v.union(
    v.literal("anchor_reuse"),
    v.literal("reid_model"),
    v.literal("coach_tap"),
  ),
  why: v.string(),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
  candidatesCount: v.number(),
});
export const TrackOutput = v.object({
  remarkId: v.string(),
  trackId: v.string(),
  role: v.union(v.literal("batter"), v.literal("bowler"), v.literal("other")),
  mode: v.union(v.literal("video"), v.literal("still")),
  fileRef: v.string(),
  maskRef: v.union(v.string(), v.null()),
  coverage: v.number(),
  framesBilled: v.number(),
  cacheHit: v.boolean(),
  swapSuspected: v.boolean(),
  reassociations: v.number(),
});
export const PlaceOutput = v.object({
  remarkId: v.string(),
  marks: v.array(
    v.object({
      markId: v.string(),
      markType: v.union(
        v.literal("circle"),
        v.literal("arrow"),
        v.literal("highlight"),
        v.literal("label"),
      ),
      anchor: v.union(
        v.literal("box_center"),
        v.literal("box_top"),
        v.literal("box_bottom"),
        v.literal("box_left"),
        v.literal("box_right"),
      ),
      arrowFrom: v.union(
        v.union(
          v.literal("left"),
          v.literal("right"),
          v.literal("above"),
          v.literal("below"),
        ),
        v.null(),
      ),
      startMs: v.number(),
      endMs: v.number(),
      labelSpan: v.union(
        v.object({ turnId: v.string(), start: v.number(), end: v.number() }),
        v.null(),
      ),
      labelText: v.string(),
      neutralLabel: v.union(
        v.union(
          v.literal("Batter"),
          v.literal("Bowler"),
          v.literal("Player"),
          v.literal("Remark"),
        ),
        v.null(),
      ),
    }),
  ),
  why: v.string(),
});
export const CheckOutput = v.object({
  remarkId: v.string(),
  verdicts: v.array(
    v.object({
      markId: v.string(),
      pass: v.boolean(),
      reason: v.union(
        v.literal("ok"),
        v.literal("no_player"),
        v.literal("subject_swap"),
        v.literal("low_coverage"),
        v.literal("outside_moment"),
        v.literal("label_mismatch"),
        v.literal("label_too_long"),
      ),
    }),
  ),
  remarkStatus: v.union(v.literal("ok"), v.literal("player_missing")),
});
export const RenderOutput = v.object({
  kind: v.union(v.literal("preview"), v.literal("final")),
  mode: v.union(v.literal("video"), v.literal("stills")),
  fileRef: v.union(v.string(), v.null()),
  stillRefs: v.array(v.object({ annotationId: v.string(), key: v.string() })),
  segmentRefs: v.array(
    v.object({ segmentId: v.string(), hash: v.string(), key: v.string() }),
  ),
  durationMs: v.number(),
});
export const Provenance = v.object({
  configVersion: v.number(),
  stageRunIds: v.record(v.string(), v.string()),
  workers: v.record(v.string(), v.string()),
  modelVersions: v.record(v.string(), v.string()),
  placedBy: v.union(v.literal("ai"), v.literal("coach")),
  candidate: v.union(v.string(), v.null()),
});
