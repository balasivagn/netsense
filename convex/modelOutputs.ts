// Generated from model-output schemas. Do not edit.
import { v } from "convex/values";
export const PlanModelOutput = v.object({
  coachSpeaker: v.string(),
  remarks: v.array(
    v.object({
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
    }),
  ),
  focusDrafts: v.array(
    v.object({
      title: v.string(),
      why: v.string(),
      remarkIndexes: v.array(v.number()),
    }),
  ),
  practiceDrafts: v.array(
    v.object({
      title: v.string(),
      why: v.string(),
      remarkIndexes: v.array(v.number()),
    }),
  ),
  noteDraft: v.object({ text: v.string(), why: v.string() }),
});
export const MomentModelOutput = v.object({
  startIdx: v.number(),
  endIdx: v.number(),
  keyIdx: v.number(),
  alternates: v.array(v.object({ startIdx: v.number(), endIdx: v.number() })),
  why: v.string(),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
});
export const SubjectModelOutput = v.object({
  boxNumber: v.number(),
  why: v.string(),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
});
export const PlaceModelOutput = v.object({
  marks: v.array(
    v.object({
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
        v.literal("left"),
        v.literal("right"),
        v.literal("above"),
        v.literal("below"),
        v.literal("none"),
      ),
      startOffsetMs: v.number(),
      endOffsetMs: v.number(),
      label: v.object({
        kind: v.union(v.literal("coach_span"), v.literal("neutral")),
        span: v.object({
          turnId: v.string(),
          start: v.number(),
          end: v.number(),
        }),
        neutral: v.union(
          v.literal("Batter"),
          v.literal("Bowler"),
          v.literal("Player"),
          v.literal("Remark"),
          v.literal("none"),
        ),
      }),
    }),
  ),
  why: v.string(),
});
export const CriticModelOutput = v.object({
  pass: v.boolean(),
  reason: v.string(),
});
export const NextFocusModelOutput = v.object({
  title: v.string(),
  why: v.string(),
  remarkIds: v.array(v.string()),
});
export const modelOutput = v.union(
  PlanModelOutput,
  MomentModelOutput,
  SubjectModelOutput,
  PlaceModelOutput,
  CriticModelOutput,
  NextFocusModelOutput,
);
