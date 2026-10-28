import { v } from "convex/values";
import { query, mutation, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { ownedSession, requireCoach } from "./lib/auth";

async function project(ctx: QueryCtx, session: Doc<"sessions">) {
  const student = await ctx.db.get(session.studentId);
  const job = session.latestJobId
    ? await ctx.db.get(session.latestJobId)
    : null;
  // Verify every join, even though writers also enforce these relationships.
  const latest =
    job?.sessionId === session._id && job.coachId === session.coachId
      ? job
      : null;
  const config = latest
    ? await ctx.db
        .query("pipeline_config")
        .withIndex("by_version", (q) => q.eq("version", latest.configVersion))
        .unique()
    : null;
  const uploads = await ctx.db
    .query("uploads")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
    .collect();
  const upload = uploads.find((u) => u.coachId === session.coachId);
  return {
    id: session._id,
    studentLabel: student?.coachId === session.coachId ? student.label : null,
    subjectRole: session.subjectRole,
    subjectSet: !!session.subject,
    captureMode: session.captureMode,
    status: session.status,
    renderMode: session.renderMode,
    isDemoFallback: session.isDemoFallback,
    uploadFailures: session.uploadFailures ?? 0,
    upload: upload
      ? {
          complete: upload.status === "complete",
          status: upload.status,
          bytesConfirmed: upload.bytesConfirmed,
          bytesTotal: upload.bytesTotal,
        }
      : null,
    job: latest
      ? {
          id: latest._id,
          status: latest.status,
          coachStage: latest.coachStage,
          progress: latest.progress,
          progressLabel: latest.progressLabel,
          errorCode: latest.errorCode,
          coachStages: config?.coachStages ?? [],
        }
      : null,
  };
}
export const list = query({
  args: {},
  handler: async (ctx) => {
    const coach = await requireCoach(ctx);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_coachId_createdAt", (q) => q.eq("coachId", coach._id))
      .order("desc")
      .collect();
    return Promise.all(sessions.map((s) => project(ctx, s)));
  },
});
export const detail = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) =>
    project(ctx, await ownedSession(ctx, args.sessionId)),
});

// Server-issued generation, one active whole-upload attempt per session. No client total.
export const beginAttempt = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const s = await ownedSession(ctx, args.sessionId);
    if (!s.captureMode) throw Error("CAPTURE_MODE_REQUIRED");
    if (s.consentConfirmedAt === undefined) throw Error("CONSENT_REQUIRED");
    const uploads = await ctx.db
      .query("uploads")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
      .collect();
    if (
      (s.uploadFailures ?? 0) >= 3 &&
      !uploads.some((u) => u.status === "complete")
    )
      throw Error("UPLOAD_FAILED");
    if (s.uploadAttemptActive) return s.uploadAttempt!;
    const attempt = (s.uploadAttempt ?? 0) + 1;
    await ctx.db.patch(s._id, {
      uploadAttempt: attempt,
      uploadAttemptActive: true,
    });
    return attempt;
  },
});
export const failAttempt = mutation({
  args: { sessionId: v.id("sessions"), attempt: v.number() },
  handler: async (ctx, args) => {
    const s = await ownedSession(ctx, args.sessionId);
    const uploads = await ctx.db
      .query("uploads")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
      .collect();
    if (uploads.some((u) => u.status === "complete" || u.status === "aborted"))
      return;
    if (!s.uploadAttemptActive || s.uploadAttempt !== args.attempt) return;
    await ctx.db.patch(s._id, {
      uploadAttemptActive: false,
      uploadFailures: Math.min(3, (s.uploadFailures ?? 0) + 1),
    });
  },
});
