import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedSession } from "./lib/auth";
import { markType, anchor, arrow, span, neutral } from "./validators";
import { sliceCoachSpan } from "../packages/contracts/utf16";

async function item(ctx: MutationCtx, id: Id<"annotations">) {
  const a = await ctx.db.get(id);
  if (!a) throw Error("NOT_FOUND");
  const s = await ownedSession(ctx, a.sessionId);
  if (a.coachId !== s.coachId) throw Error("NOT_FOUND");
  const j = s.latestJobId ? await ctx.db.get(s.latestJobId) : null;
  if (
    j &&
    (j.coachId !== s.coachId ||
      j.sessionId !== s._id ||
      ["queued", "running"].includes(j.status))
  )
    throw Error("JOB_IN_PROGRESS");
  const r = (
    await ctx.db
      .query("remarks")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
      .collect()
  ).find((r) => r.coachId === s.coachId && r.remarkId === a.remarkId);
  if (!r) throw Error("NOT_FOUND");
  return { a, s, r };
}
// Strictly exceed the last render timestamp even when transactions share a millisecond.
async function changedAt(ctx: MutationCtx, a: Doc<"annotations">) {
  const renders = await ctx.db
    .query("renders")
    .withIndex("by_sessionId_kind", (q) =>
      q.eq("sessionId", a.sessionId).eq("kind", "preview"),
    )
    .collect();
  return Math.max(
    Date.now(),
    a.updatedAt + 1,
    ...renders
      .filter((r) => r.coachId === a.coachId)
      .map((r) => r.createdAt + 1),
  );
}
async function valid(
  ctx: MutationCtx,
  x: Awaited<ReturnType<typeof item>>,
  a: Doc<"annotations">,
) {
  const { s, r } = x;
  if (
    a.role !== s.subjectRole ||
    !Number.isSafeInteger(a.startMs) ||
    !Number.isSafeInteger(a.endMs) ||
    a.startMs < (r.momentStartMs ?? Infinity) ||
    a.endMs > (r.momentEndMs ?? -1) ||
    a.endMs <= a.startMs ||
    a.endMs > (s.durationMs ?? 0)
  )
    throw Error("INVALID_MARK");
  if (a.labelSpan) {
    if (a.neutralLabel || !r.turnIds.includes(a.labelSpan.turnId))
      throw Error("INVALID_LABEL");
    const t = await ctx.db
      .query("transcriptTurns")
      .withIndex("by_sessionId_turnId", (q) =>
        q.eq("sessionId", s._id).eq("turnId", a.labelSpan!.turnId),
      )
      .unique();
    if (!t || t.coachId !== s.coachId) throw Error("INVALID_LABEL");
    const copied = sliceCoachSpan(t.text, a.labelSpan.start, a.labelSpan.end);
    const word = (s: string) => /[\p{L}\p{N}\p{M}_]/u.test(s);
    if (
      copied !== a.labelText ||
      (word([...t.text.slice(0, a.labelSpan.start)].at(-1) ?? "") &&
        word([...copied][0] ?? "")) ||
      (word([...copied].at(-1) ?? "") &&
        word([...t.text.slice(a.labelSpan.end)][0] ?? ""))
    )
      throw Error("INVALID_LABEL");
  } else {
    const label =
      s.subjectRole === "batter"
        ? "Batter"
        : s.subjectRole === "bowler"
          ? "Bowler"
          : "Player";
    const ordered = (
      await ctx.db
        .query("remarks")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
        .collect()
    )
      .filter((r) => r.coachId === s.coachId)
      .sort((a, b) => a.atMs - b.atMs || (a.remarkId < b.remarkId ? -1 : 1));
    if (!(
      (a.neutralLabel === label && a.labelText === label) ||
      (a.neutralLabel === "Remark" &&
        a.labelText ===
          `Remark ${ordered.findIndex((x) => x._id === r._id) + 1}`)
    ))
      throw Error("INVALID_LABEL");
  }
  const config = await ctx.db
    .query("pipeline_config")
    .withIndex("by_version", (q) => q.eq("version", a.provenance.configVersion))
    .unique();
  if (
    !config ||
    !config.params.allowedMarkTypes.includes(a.markType) ||
    a.labelText.length > Math.min(60, config.params.labelMaxChars)
  )
    throw Error("INVALID_MARK");
  if (r.mode === "note_only") return;
  const latest = s.latestJobId ? await ctx.db.get(s.latestJobId) : null;
  const trackRunId = a.provenance.stageRunIds.track;
  const trackRun = trackRunId
    ? await ctx.db.get(trackRunId as Id<"stageRuns">)
    : null;
  const runJob = trackRun ? await ctx.db.get(trackRun.jobId) : null;
  if (
    !trackRun ||
    !runJob ||
    runJob.coachId !== s.coachId ||
    runJob.sessionId !== s._id ||
    !trackRun.persistedOutputHash ||
    trackRun.coachId !== s.coachId ||
    trackRun.sessionId !== s._id ||
    trackRun.remarkId !== r.remarkId ||
    trackRun.stage !== "track" ||
    (latest?.kind === "subject_retrack" && trackRun.jobId !== latest._id) ||
    trackRun.status !== "done" ||
    trackRun.persistedTrackBinding?.trackId !== a.trackId ||
    (trackRun.startedAt ?? 0) < (s.subject?.selectedAt ?? Infinity)
  )
    throw Error("TRACK_UNAVAILABLE");
  if (
    r.mode === "still_frame" &&
    (r.keyframeMs === undefined ||
      r.keyframeMs < a.startMs ||
      r.keyframeMs >= a.endMs)
  )
    throw Error("INVALID_MARK");
  const tracks = await ctx.db
    .query("tracks")
    .withIndex("by_trackId", (q) => q.eq("trackId", a.trackId ?? ""))
    .collect();
  if (
    s.subjectStatus !== "anchored" ||
    r.aboutSubject !== "yes" ||
    !tracks.some(
      (t) =>
        t.coachId === s.coachId &&
        t.sessionId === s._id &&
        t.remarkId === r.remarkId &&
        t.role === s.subjectRole &&
        t.fileRef === trackRun.persistedTrackBinding?.fileRef &&
        t.coverage >= config.params.minMarkCoverage &&
        (r.mode !== "tracked" || t.mode === "video"),
    ) ||
    (a.placedBy === "ai" && !a.checkVerdict?.pass)
  )
    throw Error("TRACK_UNAVAILABLE");
}
export const approve = mutation({
  args: { annotationId: v.id("annotations") },
  handler: async (ctx, { annotationId }) => {
    const x = await item(ctx, annotationId);
    if (x.a.status === "deleted") throw Error("DELETED");
    await valid(ctx, x, x.a);
    // Track rows contain summary coverage, not frame observations. A retimed
    // mark cannot inherit the original checker verdict for a different range.
    if (
      x.r.mode !== "note_only" &&
      (!x.a.checkVerdict?.pass ||
        !x.a.aiPlacement ||
        x.a.startMs !== x.a.aiPlacement.startMs ||
        x.a.endMs !== x.a.aiPlacement.endMs)
    )
      throw Error("PLACEMENT_CHECK_REQUIRED");
    await ctx.db.patch(annotationId, {
      status: "approved",
      approvedAt: Date.now(),
      updatedAt: await changedAt(ctx, x.a),
    });
  },
});
const placement = {
  mode: v.optional(
    v.union(
      v.literal("tracked"),
      v.literal("still_frame"),
      v.literal("note_only"),
    ),
  ),
  markType,
  anchor,
  arrowFrom: v.optional(arrow),
  startMs: v.number(),
  endMs: v.number(),
  labelSpan: v.optional(span),
  neutralLabel: v.optional(neutral),
};
export const edit = mutation({
  args: { annotationId: v.id("annotations"), ...placement },
  handler: async (ctx, args) => {
    const x = await item(ctx, args.annotationId);
    if (x.a.status === "deleted") throw Error("DELETED");
    let labelText: string;
    if (args.labelSpan) {
      const t = await ctx.db
        .query("transcriptTurns")
        .withIndex("by_sessionId_turnId", (q) =>
          q.eq("sessionId", x.s._id).eq("turnId", args.labelSpan!.turnId),
        )
        .unique();
      if (!t || t.coachId !== x.s.coachId) throw Error("INVALID_LABEL");
      labelText = sliceCoachSpan(
        t.text,
        args.labelSpan.start,
        args.labelSpan.end,
      );
    } else {
      const rs = (
        await ctx.db
          .query("remarks")
          .withIndex("by_sessionId", (q) => q.eq("sessionId", x.s._id))
          .collect()
      )
        .filter((r) => r.coachId === x.s.coachId)
        .sort((a, b) => a.atMs - b.atMs || (a.remarkId < b.remarkId ? -1 : 1));
      labelText =
        args.neutralLabel === "Remark"
          ? `Remark ${rs.findIndex((r) => r._id === x.r._id) + 1}`
          : (args.neutralLabel ?? "");
    }
    const { annotationId, mode, ...fields } = args;
    const changed =
      JSON.stringify([
        fields.markType,
        fields.anchor,
        fields.arrowFrom,
        fields.startMs,
        fields.endMs,
        labelText,
      ]) !==
      JSON.stringify([
        x.a.markType,
        x.a.anchor,
        x.a.arrowFrom,
        x.a.startMs,
        x.a.endMs,
        x.a.labelText,
      ]);
    const next = {
      ...x.a,
      ...fields,
      labelText,
      placedBy: changed ? ("coach" as const) : x.a.placedBy,
    };
    await valid(ctx, { ...x, r: { ...x.r, mode: mode ?? x.r.mode } }, next);
    if (mode) await ctx.db.patch(x.r._id, { mode });
    await ctx.db.patch(annotationId, {
      ...fields,
      labelSpan: args.labelSpan,
      neutralLabel: args.neutralLabel,
      arrowFrom: args.arrowFrom,
      labelText,
      placedBy: next.placedBy,
      status: "needs_you",
      approvedAt: undefined,
      updatedAt: await changedAt(ctx, x.a),
    });
  },
});
export const move = mutation({
  args: {
    annotationId: v.id("annotations"),
    anchor,
    startMs: v.number(),
    endMs: v.number(),
  },
  handler: async (ctx, args) => {
    const x = await item(ctx, args.annotationId);
    if (x.a.status === "deleted") throw Error("DELETED");
    const { annotationId, ...p } = args;
    await valid(ctx, x, { ...x.a, ...p, placedBy: "coach" });
    await ctx.db.patch(annotationId, {
      ...p,
      placedBy: "coach",
      status: "needs_you",
      approvedAt: undefined,
      updatedAt: await changedAt(ctx, x.a),
    });
  },
});
const remove = mutation({
  args: { annotationId: v.id("annotations") },
  handler: async (ctx, { annotationId }) => {
    const x = await item(ctx, annotationId);
    await ctx.db.patch(annotationId, {
      status: "deleted",
      approvedAt: undefined,
      updatedAt: await changedAt(ctx, x.a),
    });
  },
});
export { remove as delete };
export const undoDelete = mutation({
  args: { annotationId: v.id("annotations") },
  handler: async (ctx, { annotationId }) => {
    const x = await item(ctx, annotationId);
    if (x.a.status !== "deleted") throw Error("NOT_DELETED");
    await ctx.db.patch(annotationId, {
      status: "needs_you",
      approvedAt: undefined,
      updatedAt: await changedAt(ctx, x.a),
    });
  },
});
export const correctTurn = mutation({
  args: {
    sessionId: v.id("sessions"),
    turnId: v.string(),
    correctedText: v.string(),
  },
  handler: async (ctx, args) => {
    const s = await ownedSession(ctx, args.sessionId);
    if (!args.correctedText.trim() || args.correctedText.length > 10000)
      throw Error("INVALID_TEXT");
    const t = await ctx.db
      .query("transcriptTurns")
      .withIndex("by_sessionId_turnId", (q) =>
        q.eq("sessionId", s._id).eq("turnId", args.turnId),
      )
      .unique();
    if (!t || t.coachId !== s.coachId) throw Error("NOT_FOUND");
    await ctx.db.patch(t._id, {
      correctedText: args.correctedText,
      correctedAt: Date.now(),
    });
  },
});
