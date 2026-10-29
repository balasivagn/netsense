import { v } from "convex/values";
import {
  mutation,
  query,
  internalMutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { canonical } from "../packages/contracts/validateSchema";
import { ownedSession } from "./lib/auth";
import { markType, anchor, arrow, span, neutral } from "./validators";
import { projectPlayback } from "./playback";
import { sliceCoachSpan } from "../packages/contracts/utf16";

async function item(
  ctx: QueryCtx,
  id: Id<"annotations">,
  owner?: Id<"coaches">,
) {
  const a = await ctx.db.get(id);
  if (!a) throw Error("NOT_FOUND");
  const s = owner
    ? await ctx.db.get(a.sessionId)
    : await ownedSession(ctx, a.sessionId);
  if (!s || (owner && s.coachId !== owner)) throw Error("NOT_FOUND");
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
  ctx: QueryCtx,
  x: Awaited<ReturnType<typeof item>>,
  a: Doc<"annotations">,
  observationsWillBeChecked = false,
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
        (observationsWillBeChecked ||
          t.coverage >= config.params.minMarkCoverage) &&
        (r.mode !== "tracked" || t.mode === "video"),
    ) ||
    (!observationsWillBeChecked && a.placedBy === "ai" && !a.checkVerdict?.pass)
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
  args: {
    annotationId: v.id("annotations"),
    expectedUpdatedAt: v.optional(v.number()),
    expectedRevision: v.optional(v.string()),
    ...placement,
  },
  handler: async (ctx, args) => {
    const x = await item(ctx, args.annotationId);
    if (
      args.expectedRevision !== undefined &&
      (await projectPlayback(ctx, x.s._id)).revision !== args.expectedRevision
    )
      throw Error("REVIEW_CONFLICT");
    if (
      args.expectedUpdatedAt !== undefined &&
      args.expectedUpdatedAt !== x.a.updatedAt
    )
      throw Error("REVIEW_CONFLICT");
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
    const {
      annotationId,
      mode,
      expectedUpdatedAt: _expected,
      expectedRevision: _revision,
      ...fields
    } = args;
    void _expected;
    void _revision;
    const modeChanged = mode !== undefined && mode !== x.r.mode;
    const changed =
      modeChanged ||
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
      labelSpan: args.labelSpan,
      neutralLabel: args.neutralLabel,
      arrowFrom: args.arrowFrom,
      labelText,
      placedBy: changed ? ("coach" as const) : x.a.placedBy,
    };
    await valid(
      ctx,
      { ...x, r: { ...x.r, mode: mode ?? x.r.mode } },
      next,
      true,
    );
    if (modeChanged) {
      // Mode belongs to the remark, so every sibling placement changes too.
      // Clear affected approvals; each mark still requires individual approval.
      await ctx.db.patch(x.r._id, { mode });
      const siblings = await ctx.db
        .query("annotations")
        .withIndex("by_sessionId_status", (q) => q.eq("sessionId", x.s._id))
        .collect();
      for (const sibling of siblings) {
        if (
          sibling._id === annotationId ||
          sibling.coachId !== x.s.coachId ||
          sibling.remarkId !== x.r.remarkId ||
          sibling.status === "deleted"
        )
          continue;
        await ctx.db.patch(sibling._id, {
          status: "needs_you",
          approvedAt: undefined,
          updatedAt: await changedAt(ctx, sibling),
        });
      }
    }
    const updatedAt = await changedAt(ctx, x.a);
    await ctx.db.patch(annotationId, {
      ...fields,
      labelSpan: args.labelSpan,
      neutralLabel: args.neutralLabel,
      arrowFrom: args.arrowFrom,
      labelText,
      placedBy: next.placedBy,
      status: "needs_you",
      approvedAt: undefined,
      updatedAt,
    });
    return {
      updatedAt,
      revision: (await projectPlayback(ctx, x.s._id)).revision,
    };
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
    await valid(ctx, x, { ...x.a, ...p, placedBy: "coach" }, true);
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

// No browser-supplied coverage or verdict enters either function. Only the
// service HTTP action can call commitVerified after checking actual local bytes.
async function verificationState(
  ctx: QueryCtx,
  annotationId: Id<"annotations">,
  owner?: Id<"coaches">,
) {
  const x = await item(ctx, annotationId, owner);
  if (x.a.status === "deleted") throw Error("DELETED");
  await valid(ctx, x, x.a, true);
  const config = await ctx.db
    .query("pipeline_config")
    .withIndex("by_version", (q) =>
      q.eq("version", x.a.provenance.configVersion),
    )
    .unique();
  if (!config) throw Error("INVALID_MARK");
  const job = x.s.latestJobId ? await ctx.db.get(x.s.latestJobId) : null;
  const trackRunId = x.a.provenance.stageRunIds.track;
  const trackRun = trackRunId
    ? await ctx.db.get(trackRunId as Id<"stageRuns">)
    : null;
  const trackJob = trackRun ? await ctx.db.get(trackRun.jobId) : null;
  const tracks = (
    await ctx.db
      .query("tracks")
      .withIndex("by_trackId", (q) => q.eq("trackId", x.a.trackId ?? ""))
      .collect()
  ).filter(
    (t) =>
      t.coachId === x.s.coachId &&
      t.sessionId === x.s._id &&
      t.remarkId === x.r.remarkId &&
      t.role === x.s.subjectRole &&
      t.fileRef === trackRun?.persistedTrackBinding?.fileRef,
  );
  if (x.r.mode !== "note_only" && tracks.length !== 1)
    throw Error("TRACK_UNAVAILABLE");
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", x.s._id))
    .collect();
  const sources = [];
  for (const j of jobs) {
    if (j.coachId !== x.s.coachId) continue;
    const runs = await ctx.db
      .query("stageRuns")
      .withIndex("by_jobId_stage", (q) =>
        q.eq("jobId", j._id).eq("stage", "transcode"),
      )
      .collect();
    sources.push(
      ...runs.filter(
        (r) =>
          r.coachId === x.s.coachId &&
          r.sessionId === x.s._id &&
          r.status === "done" &&
          r.persistedOutputHash &&
          r.outputRef,
      ),
    );
  }
  sources.sort(
    (a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0) || a._id.localeCompare(b._id),
  );
  const source = sources[0] ?? null;
  // Hash whole authoritative documents, including receipts, pinned config and
  // source/subject/job binding. Only the digest and required inputs leave Convex.
  const bytes = new TextEncoder().encode(
    canonical({ ...x, config, job, trackRun, trackJob, tracks, source }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const state = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return {
    x,
    state,
    input: {
      coachId: x.s.coachId,
      sessionId: x.s._id,
      updatedAt: x.a.updatedAt,
      startMs: x.a.startMs,
      endMs: x.a.endMs,
      mode: x.r.mode,
      keyframeMs: x.r.keyframeMs,
      durationMs: x.s.durationMs,
      trackRef: tracks[0]?.fileRef,
      trackMode: tracks[0]?.mode,
      artifact: source?.outputRef,
      artifactHash: source?.persistedOutputHash,
      minMarkCoverage: config.params.minMarkCoverage,
    },
  };
}
export const approvalInput = query({
  args: {
    annotationId: v.id("annotations"),
    expectedUpdatedAt: v.number(),
    expectedRevision: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verificationState(ctx, args.annotationId);
    if (
      result.x.a.updatedAt !== args.expectedUpdatedAt ||
      (await projectPlayback(ctx, result.x.s._id)).revision !==
        args.expectedRevision
    )
      throw Error("REVIEW_CONFLICT");
    return { ...result.input, state: result.state };
  },
});
export const commitVerified = internalMutation({
  args: {
    annotationId: v.id("annotations"),
    coachId: v.id("coaches"),
    state: v.string(),
    expectedUpdatedAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (
      !Number.isSafeInteger(args.expiresAt) ||
      args.expiresAt <= Date.now() ||
      args.expiresAt > Date.now() + 10000
    )
      throw Error("REVIEW_EXPIRED");
    const result = await verificationState(
      ctx,
      args.annotationId,
      args.coachId,
    );
    if (
      result.state !== args.state ||
      result.x.a.updatedAt !== args.expectedUpdatedAt
    )
      throw Error("REVIEW_CONFLICT");
    // Exact retries on an already-approved revision are read-only. A retry of a
    // consumed draft revision fails closed; a fresh read can safely retry it.
    if (result.x.a.status === "approved") return { ok: true };
    await ctx.db.patch(args.annotationId, {
      status: "approved",
      approvedAt: Date.now(),
      updatedAt: await changedAt(ctx, result.x.a),
    });
    return { ok: true };
  },
});
