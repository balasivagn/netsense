import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureCoach, requireCoach, ownedSession } from "./lib/auth";
import { role, point, renderMode } from "./validators";
import { enqueueReady, enqueueJob } from "./jobs";
export const create = mutation({
  args: {
    studentId: v.id("students"),
    subjectRole: role,
    captureMode: v.union(
      v.literal("camera"),
      v.literal("camera_roll"),
      v.literal("in_page"),
    ),
  },
  handler: async (ctx, args) => {
    const coach = await ensureCoach(ctx);
    const student = await ctx.db.get(args.studentId);
    if (!student || student.coachId !== coach._id) throw Error("NOT_FOUND");
    const config = await ctx.db
      .query("pipeline_config")
      .withIndex("by_active", (q) => q.eq("active", true))
      .unique();
    if (!config) throw Error("CONFIG_MISSING");
    return ctx.db.insert("sessions", {
      ...args,
      coachId: coach._id,
      subjectStatus: "needed",
      renderMode: config.params.renderModeDefault,
      isDemoFallback: false,
      status: "draft",
      createdAt: Date.now(),
    });
  },
});
export const list = query({
  args: {},
  handler: async (ctx) => {
    const coach = await requireCoach(ctx);
    return ctx.db
      .query("sessions")
      .withIndex("by_coachId_createdAt", (q) => q.eq("coachId", coach._id))
      .order("desc")
      .collect();
  },
});
export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: (ctx, args) => ownedSession(ctx, args.sessionId),
});
export const setRenderMode = mutation({
  args: { sessionId: v.id("sessions"), renderMode },
  handler: async (ctx, args) => {
    await ownedSession(ctx, args.sessionId);
    await ctx.db.patch(args.sessionId, { renderMode: args.renderMode });
  },
});
export const confirmConsent = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    if (
      session.consentConfirmedAt !== undefined ||
      session.consentConfirmedBy !== undefined
    )
      return;
    // ownedSession has already required an authenticated, registered coach.
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw Error("UNAUTHENTICATED");
    await ctx.db.patch(session._id, {
      consentConfirmedAt: Date.now(),
      consentConfirmedBy: identity.subject,
    });
  },
});
export const setSubject = mutation({
  args: { sessionId: v.id("sessions"), frameMs: v.number(), point, role },
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId);
    if (
      !Number.isSafeInteger(args.frameMs) ||
      args.frameMs < 0 ||
      (session.durationMs !== undefined && args.frameMs > session.durationMs) ||
      !Number.isFinite(args.point.x) ||
      !Number.isFinite(args.point.y) ||
      args.point.x < 0 ||
      args.point.x > 1 ||
      args.point.y < 0 ||
      args.point.y > 1 ||
      args.role !== session.subjectRole
    )
      throw Error("INVALID_SUBJECT");
    const old = session.subject;
    if (
      session.subjectStatus !== "anchor_failed" &&
      old &&
      old.frameMs === args.frameMs &&
      old.point.x === args.point.x &&
      old.point.y === args.point.y &&
      old.role === args.role
    )
      return session.latestJobId ?? null;
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    // Avoid stale workers overwriting a new subject. A queued pipeline may safely read the updated tap.
    if (
      jobs.some(
        (j) =>
          j.status === "running" ||
          (j.status === "queued" && j.kind !== "pipeline"),
      )
    )
      throw Error("JOB_IN_PROGRESS");
    await ctx.db.patch(session._id, {
      subject: {
        frameMs: args.frameMs,
        point: args.point,
        role: args.role,
        selectedBy: "coach",
        selectedAt: Date.now(),
      },
      subjectStatus: "set",
      subjectAnchor: undefined,
    });
    if (jobs.some((j) => j.kind === "pipeline" && j.status !== "queued")) {
      const marks = await ctx.db
        .query("annotations")
        .withIndex("by_sessionId_status", (q) => q.eq("sessionId", session._id))
        .collect();
      for (const mark of marks)
        if (mark.placedBy === "ai" && mark.status !== "deleted")
          await ctx.db.patch(mark._id, {
            status: "needs_you",
            approvedAt: undefined,
            updatedAt: Date.now(),
          });
      return enqueueJob(ctx, session, "subject_retrack");
    }
    return enqueueReady(ctx, session._id);
  },
});
