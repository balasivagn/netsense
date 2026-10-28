import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ownedSession, requireCoach } from "./lib/auth";
import { enqueueReady } from "./jobs";
const owner = { uploadId: v.id("uploads"), coachId: v.id("coaches") };
async function checked(
  ctx: MutationCtx,
  uploadId: Id<"uploads">,
  coachId: Id<"coaches">,
) {
  const u = await ctx.db.get(uploadId);
  const s = u && (await ctx.db.get(u.sessionId));
  if (!u || !s || u.coachId !== coachId || s.coachId !== coachId)
    throw Error("NOT_FOUND");
  if (s.consentConfirmedAt === undefined) throw Error("CONSENT_REQUIRED");
  return u;
}
export const owned = query({
  args: { uploadId: v.id("uploads") },
  handler: async (ctx, args) => {
    const coach = await requireCoach(ctx);
    const row = await ctx.db.get(args.uploadId);
    if (!row || row.coachId !== coach._id) throw Error("NOT_FOUND");
    await ownedSession(ctx, row.sessionId);
    return row;
  },
});
export const reserve = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    coachId: v.id("coaches"),
    sha256: v.string(),
    mimeType: v.string(),
    bytesTotal: v.number(),
    multipartUploadId: v.string(),
  },
  handler: async (ctx, a) => {
    const s = await ctx.db.get(a.sessionId);
    if (!s || s.coachId !== a.coachId) throw Error("NOT_FOUND");
    if (s.consentConfirmedAt === undefined) throw Error("CONSENT_REQUIRED");
    if (
      !Number.isSafeInteger(a.bytesTotal) ||
      a.bytesTotal < 1 ||
      a.bytesTotal > 5 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !["video/mp4", "video/quicktime", "video/webm"].includes(a.mimeType) ||
      !/^[a-f0-9-]{36}$/.test(a.multipartUploadId)
    )
      throw Error("INVALID_REQUEST");
    const rows = await ctx.db
      .query("uploads")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", s._id))
      .collect();
    const existing = rows.find((u) => u.sha256 === a.sha256);
    if (existing) {
      if (
        existing.bytesTotal !== a.bytesTotal ||
        existing.mimeType !== a.mimeType
      )
        throw Error("UPLOAD_CONFLICT");
      return existing;
    }
    if (rows.length) throw Error("UPLOAD_CONFLICT");
    const id = await ctx.db.insert("uploads", {
      ...a,
      storageKey: `sessions/${s._id}/source/original`,
      driver: "local",
      partSize: 8 * 1024 ** 2,
      partsConfirmed: [],
      confirmedParts: [],
      bytesConfirmed: 0,
      status: "in_progress",
      attempts: 0,
      createdAt: Date.now(),
    });
    return (await ctx.db.get(id))!;
  },
});
export const confirm = internalMutation({
  args: {
    ...owner,
    partNumber: v.number(),
    etag: v.string(),
    bytes: v.number(),
  },
  handler: async (ctx, a) => {
    const u = await checked(ctx, a.uploadId, a.coachId);
    if (u.status !== "in_progress" || u.phase)
      throw Error("INVALID_UPLOAD_STATE");
    const count = Math.ceil(u.bytesTotal / u.partSize);
    const expected =
      a.partNumber === count
        ? u.bytesTotal - (count - 1) * u.partSize
        : u.partSize;
    if (
      !Number.isSafeInteger(a.partNumber) ||
      a.partNumber < 1 ||
      a.partNumber > count ||
      a.bytes !== expected ||
      !/^[a-f0-9]{64}$/.test(a.etag)
    )
      throw Error("PART_MISMATCH");
    const parts = u.confirmedParts ?? [];
    const old = parts.find((p) => p.partNumber === a.partNumber);
    if (old && (old.bytes !== a.bytes || old.etag !== a.etag))
      throw Error("PART_CONFLICT");
    if (!old)
      parts.push({ partNumber: a.partNumber, etag: a.etag, bytes: a.bytes });
    parts.sort((a, b) => a.partNumber - b.partNumber);
    const bytesConfirmed = parts.reduce((n, p) => n + p.bytes, 0);
    await ctx.db.patch(u._id, {
      confirmedParts: parts,
      partsConfirmed: parts.map((p) => p.partNumber),
      bytesConfirmed,
    });
    return { bytesConfirmed };
  },
});
export const begin = internalMutation({
  args: {
    ...owner,
    operation: v.union(v.literal("completing"), v.literal("aborting")),
  },
  handler: async (ctx, a) => {
    const u = await checked(ctx, a.uploadId, a.coachId);
    if (
      (u.status === "complete" && a.operation === "completing") ||
      (u.status === "aborted" && a.operation === "aborting")
    )
      return u;
    if (u.status !== "in_progress" || (u.phase && u.phase !== a.operation))
      throw Error("INVALID_UPLOAD_STATE");
    if (
      a.operation === "completing" &&
      (u.bytesConfirmed !== u.bytesTotal ||
        u.confirmedParts?.length !== Math.ceil(u.bytesTotal / u.partSize))
    )
      throw Error("MISSING_PART");
    await ctx.db.patch(u._id, { phase: a.operation });
    return { ...u, phase: a.operation };
  },
});
export const abort = internalMutation({
  args: owner,
  handler: async (ctx, a) => {
    const u = await checked(ctx, a.uploadId, a.coachId);
    if (u.status === "aborted") return {};
    if (u.phase !== "aborting" || u.status !== "in_progress")
      throw Error("INVALID_UPLOAD_STATE");
    await ctx.db.patch(u._id, { status: "aborted" });
    return {};
  },
});
export const complete = internalMutation({
  args: {
    ...owner,
    verifiedBytes: v.number(),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const u = await checked(ctx, a.uploadId, a.coachId);
    if (
      u.status !== "complete" &&
      (u.status !== "in_progress" || u.phase !== "completing")
    )
      throw Error("INVALID_UPLOAD_STATE");
    if (a.verifiedBytes !== u.bytesTotal) throw Error("UPLOAD_SIZE_MISMATCH");
    if (a.durationMs !== undefined) {
      const session = (await ctx.db.get(u.sessionId))!;
      if (
        !Number.isSafeInteger(a.durationMs) ||
        a.durationMs < 0 ||
        (session.subject && session.subject.frameMs > a.durationMs)
      )
        throw Error("INVALID_DURATION");
      await ctx.db.patch(session._id, { durationMs: a.durationMs });
    }
    if (u.status !== "complete")
      await ctx.db.patch(u._id, {
        status: "complete",
        completedAt: Date.now(),
      });
    return enqueueReady(ctx, u.sessionId);
  },
});
