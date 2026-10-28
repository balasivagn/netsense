import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureCoach, requireCoach } from "./lib/auth";
export const add = mutation({
  args: { label: v.string(), contactMasked: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const coach = await ensureCoach(ctx);
    const label = args.label.trim();
    if (!label || label.length > 120) throw Error("INVALID_LABEL");
    return ctx.db.insert("students", {
      coachId: coach._id,
      label,
      contactMasked: args.contactMasked,
      createdAt: Date.now(),
    });
  },
});
export const list = query({
  args: {},
  handler: async (ctx) => {
    const coach = await requireCoach(ctx);
    return ctx.db
      .query("students")
      .withIndex("by_coachId", (q) => q.eq("coachId", coach._id))
      .collect();
  },
});
