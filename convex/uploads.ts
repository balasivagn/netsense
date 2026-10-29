// Internal completion boundary for the authenticated VM service (HTTP integration is T1.10).
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { enqueueReady } from "./jobs";
export const complete = internalMutation({
  args: {
    uploadId: v.id("uploads"),
    coachId: v.id("coaches"),
    verifiedBytes: v.number(),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const upload = await ctx.db.get(args.uploadId);
    if (!upload || upload.coachId !== args.coachId) throw Error("NOT_FOUND");
    const session = await ctx.db.get(upload.sessionId);
    if (!session || session.coachId !== args.coachId) throw Error("NOT_FOUND");
    if (
      !Number.isSafeInteger(args.verifiedBytes) ||
      args.verifiedBytes !== upload.bytesTotal
    )
      throw Error("UPLOAD_SIZE_MISMATCH");
    if (
      args.durationMs !== undefined &&
      (!Number.isSafeInteger(args.durationMs) ||
        args.durationMs < 0 ||
        (session.subject && session.subject.frameMs > args.durationMs))
    )
      throw Error("INVALID_DURATION");
    if (upload.status === "aborted" || upload.status === "failed")
      throw Error("INVALID_UPLOAD_STATE");
    if (upload.status !== "complete")
      await ctx.db.patch(upload._id, {
        status: "complete",
        bytesConfirmed: upload.bytesTotal,
        completedAt: Date.now(),
      });
    if (args.durationMs !== undefined)
      await ctx.db.patch(session._id, { durationMs: args.durationMs });
    return enqueueReady(ctx, session._id);
  },
});
