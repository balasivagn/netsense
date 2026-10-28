import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ownedSession } from "./lib/auth";

// This closed projection is shared with the authenticated media allowlist.
export async function projectPlayback(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
) {
  const s = await ownedSession(ctx, sessionId);
  const coach = await ctx.db.get(s.coachId);
  if (!coach) throw Error("NOT_FOUND");
  const job = s.latestJobId ? await ctx.db.get(s.latestJobId) : null;
  if (job && (job.sessionId !== s._id || job.coachId !== s.coachId))
    throw Error("NOT_FOUND");
  const remarks = (
    await ctx.db
      .query("remarks")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
      .collect()
  )
    .filter((r) => r.coachId === s.coachId)
    .sort((a, b) => a.atMs - b.atMs || (a.remarkId < b.remarkId ? -1 : 1));
  const turns = (
    await ctx.db
      .query("transcriptTurns")
      .withIndex("by_sessionId_turnId", (q) => q.eq("sessionId", s._id))
      .collect()
  ).filter((t) => t.coachId === s.coachId);
  const annotations = (
    await ctx.db
      .query("annotations")
      .withIndex("by_sessionId_status", (q) => q.eq("sessionId", s._id))
      .collect()
  ).filter(
    (a) =>
      a.coachId === s.coachId && remarks.some((r) => r.remarkId === a.remarkId),
  );
  const allTracks = (
    await ctx.db
      .query("tracks")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
      .collect()
  ).filter(
    (t) =>
      t.coachId === s.coachId &&
      t.role === s.subjectRole &&
      remarks.some((r) => r.remarkId === t.remarkId),
  );
  const tracks = [];
  for (const t of allTracks) {
    const bound = annotations.filter(
      (a) => a.trackId === t.trackId && a.remarkId === t.remarkId,
    );
    let current = false;
    for (const a of bound) {
      const runId = a.provenance.stageRunIds.track;
      const run = runId ? await ctx.db.get(runId as Id<"stageRuns">) : null;
      const runJob = run ? await ctx.db.get(run.jobId) : null;
      if (
        run &&
        runJob &&
        runJob.coachId === s.coachId &&
        runJob.sessionId === s._id &&
        run.persistedOutputHash &&
        run.coachId === s.coachId &&
        run.sessionId === s._id &&
        run.remarkId === t.remarkId &&
        run.stage === "track" &&
        (job?.kind !== "subject_retrack" || run.jobId === job._id) &&
        run.status === "done" &&
        run.persistedTrackBinding?.trackId === t.trackId &&
        run.persistedTrackBinding.fileRef === t.fileRef &&
        (run.startedAt ?? 0) >= (s.subject?.selectedAt ?? Infinity)
      )
        current = true;
    }
    if (current) tracks.push(t);
  }
  const renders = (
    await ctx.db
      .query("renders")
      .withIndex("by_sessionId_kind", (q) =>
        q.eq("sessionId", s._id).eq("kind", "preview"),
      )
      .collect()
  ).filter(
    (r) =>
      r.coachId === s.coachId && r.jobId === job?._id && r.status === "ready",
  );
  // A new subject or any coach edit makes mutable baked media unsafe immediately.
  const preview = renders
    .sort((a, b) => b.createdAt - a.createdAt)
    .find(
      (r) =>
        s.subjectStatus === "anchored" &&
        (!s.subject || s.subject.selectedAt <= r.createdAt) &&
        annotations.every((a) => a.updatedAt <= r.createdAt),
    );
  const runs = job
    ? await ctx.db
        .query("stageRuns")
        .withIndex("by_jobId_stage", (q) =>
          q.eq("jobId", job._id).eq("stage", "transcode"),
        )
        .collect()
    : [];
  // Retracks reuse the completed source artifact from an earlier owned job.
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
    .collect();
  for (const j of jobs) {
    if (j.coachId !== s.coachId || j._id === job?._id) continue;
    runs.push(
      ...(await ctx.db
        .query("stageRuns")
        .withIndex("by_jobId_stage", (q) =>
          q.eq("jobId", j._id).eq("stage", "transcode"),
        )
        .collect()),
    );
  }
  const artifactRun = runs
    .filter(
      (r) =>
        r.coachId === s.coachId &&
        r.sessionId === s._id &&
        r.status === "done" &&
        r.persistedOutputHash &&
        r.outputRef,
    )
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
    .collect();
  const lesson = lessons.find((l) => l.coachId === s.coachId);
  return {
    ownerUserId: coach.clerkUserId,
    suggestions: [...(lesson?.focusPoints ?? []), ...(lesson?.practice ?? [])]
      .filter((x) => x.source === "ai_draft")
      .map((x) => ({
        id: x.id,
        title: x.title,
        why: x.why,
        approved: x.approved,
      })),
    id: s._id,
    role: s.subjectRole,
    subjectStatus: s.subjectStatus,
    renderMode: s.renderMode,
    durationMs: s.durationMs,
    isDemoFallback: s.isDemoFallback,
    busy: job?.status === "queued" || job?.status === "running",
    artifact: artifactRun?.outputRef ?? null,
    artifactHash: artifactRun?.persistedOutputHash ?? null,
    remarks: remarks.map((r) => {
      const linked = r.turnIds.map((id) => turns.find((t) => t.turnId === id));
      if (linked.some((t) => !t)) throw Error("NOT_FOUND");
      return {
        id: r.remarkId,
        source: r.source,
        atMs: r.atMs,
        mode: r.mode,
        status: r.status,
        aboutSubject: r.aboutSubject,
        momentStartMs: r.momentStartMs,
        momentEndMs: r.momentEndMs,
        keyframeMs: r.keyframeMs,
        words: linked.map((t) => t!.text).join(" "),
        turns: linked.map((t) => ({
          id: t!.turnId,
          text: t!.text,
          correctedText: t!.correctedText,
          startMs: t!.startMs,
          endMs: t!.endMs,
        })),
      };
    }),
    annotations: annotations.map((a) => ({
      id: a._id,
      remarkId: a.remarkId,
      markType: a.markType,
      anchor: a.anchor,
      arrowFrom: a.arrowFrom,
      role: a.role,
      startMs: a.startMs,
      endMs: a.endMs,
      labelSpan: a.labelSpan,
      neutralLabel: a.neutralLabel,
      labelText: a.labelText,
      trackId: a.trackId,
      why: a.why,
      status: a.status,
      placedBy: a.placedBy,
      checkVerdict: a.checkVerdict,
      checkedRange: a.aiPlacement
        ? { startMs: a.aiPlacement.startMs, endMs: a.aiPlacement.endMs }
        : null,
      updatedAt: a.updatedAt,
    })),
    tracks: tracks.map((t) => ({
      remarkId: t.remarkId,
      trackId: t.trackId,
      role: t.role,
      mode: t.mode,
      coverage: t.coverage,
      fileRef: t.fileRef,
    })),
    preview: preview
      ? {
          fileRef: preview.fileRef,
          mode: preview.mode,
          stillRefs: preview.stillRefs.filter((ref) =>
            annotations.some(
              (a) => a._id === ref.annotationId && a.status !== "deleted",
            ),
          ),
        }
      : null,
    revision: JSON.stringify([
      s.subject?.selectedAt,
      job?._id,
      annotations.map((a) => [a._id, a.updatedAt, a.status]),
      renders.map((r) => r._id),
    ]),
  };
}
export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: (ctx, args) => projectPlayback(ctx, args.sessionId),
});
