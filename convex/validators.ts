import { v } from "convex/values";
export const role = v.union(
  v.literal("batter"),
  v.literal("bowler"),
  v.literal("other"),
);
export const stage = v.union(
  v.literal("transcode"),
  v.literal("transcribe"),
  v.literal("plan"),
  v.literal("moment"),
  v.literal("subject"),
  v.literal("track"),
  v.literal("place"),
  v.literal("check"),
  v.literal("render"),
);
export const workerType = v.union(
  v.literal("agent"),
  v.literal("sub_agent"),
  v.literal("model"),
  v.literal("tool"),
  v.literal("rules"),
);
export const provider = v.union(
  v.literal("local"),
  v.literal("meta"),
  v.literal("fake"),
  v.literal("gemini"),
  v.literal("fireworks"),
  v.literal("baseten"),
);
export const point = v.object({ x: v.number(), y: v.number() });
export const box = v.object({
  x1: v.number(),
  y1: v.number(),
  x2: v.number(),
  y2: v.number(),
});
export const subject = v.object({
  frameMs: v.number(),
  point,
  role,
  selectedBy: v.literal("coach"),
  selectedAt: v.number(),
});
export const markType = v.union(
  v.literal("circle"),
  v.literal("arrow"),
  v.literal("highlight"),
  v.literal("label"),
);
export const anchor = v.union(
  v.literal("box_center"),
  v.literal("box_top"),
  v.literal("box_bottom"),
  v.literal("box_left"),
  v.literal("box_right"),
);
export const arrow = v.union(
  v.literal("left"),
  v.literal("right"),
  v.literal("above"),
  v.literal("below"),
);
export const span = v.object({
  turnId: v.string(),
  start: v.number(),
  end: v.number(),
});
export const neutral = v.union(
  v.literal("Batter"),
  v.literal("Bowler"),
  v.literal("Player"),
  v.literal("Remark"),
);
export const provenance = v.object({
  configVersion: v.number(),
  stageRunIds: v.record(
    v.union(
      v.literal("moment"),
      v.literal("subject"),
      v.literal("track"),
      v.literal("place"),
      v.literal("check"),
    ),
    v.string(),
  ),
  workers: v.record(
    v.union(
      v.literal("moment"),
      v.literal("subject"),
      v.literal("track"),
      v.literal("place"),
      v.literal("check"),
    ),
    v.string(),
  ),
  modelVersions: v.record(v.string(), v.string()),
  placedBy: v.union(v.literal("ai"), v.literal("coach")),
  candidate: v.union(v.string(), v.null()),
});
export const renderMode = v.union(v.literal("video"), v.literal("stills"));
export const trackMode = v.union(v.literal("video"), v.literal("still"));
export const source = v.union(v.literal("coach"), v.literal("ai_draft"));
export const focus = v.object({
  id: v.string(),
  title: v.string(),
  source,
  approved: v.boolean(),
  why: v.optional(v.string()),
  remarkIds: v.array(v.string()),
  editedByCoach: v.boolean(),
});
export const note = v.object({
  text: v.string(),
  source,
  approved: v.boolean(),
  why: v.optional(v.string()),
});
export const stillRef = v.object({ annotationId: v.string(), key: v.string() });
export const segmentRef = v.object({
  segmentId: v.string(),
  hash: v.string(),
  key: v.string(),
});
export const stageStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("skipped"),
  v.literal("fallback"),
  v.literal("needs_coach"),
);
export const jobKind = v.union(
  v.literal("pipeline"),
  v.literal("subject_retrack"),
  v.literal("remark_retrack"),
  v.literal("stage_retry"),
  v.literal("finalize"),
);
export const jobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("waiting_for_coach"),
  v.literal("cancelled"),
);
