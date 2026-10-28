import { v } from "convex/values";
import { query } from "./_generated/server";
import { ownedSession } from "./lib/auth";

// Read only: selection never creates a job or any pipeline output.
export const source = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ownedSession(ctx, sessionId);
    if (session.consentConfirmedAt === undefined)
      throw Error("CONSENT_REQUIRED");
    const uploads = await ctx.db
      .query("uploads")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .collect();
    const upload = uploads.length === 1 ? uploads[0] : undefined;
    if (
      !upload ||
      upload.coachId !== session.coachId ||
      upload.status !== "complete" ||
      upload.phase === "aborting" ||
      upload.bytesConfirmed !== upload.bytesTotal ||
      upload.driver !== "local" ||
      upload.storageKey !== `sessions/${sessionId}/source/original` ||
      !Number.isSafeInteger(upload.bytesTotal) ||
      upload.bytesTotal < 1 ||
      upload.bytesTotal > 2 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(upload.sha256)
    )
      throw Error("SOURCE_UNAVAILABLE");
    return {
      key: upload.storageKey,
      sha256: upload.sha256,
      bytes: upload.bytesTotal,
    };
  },
});
