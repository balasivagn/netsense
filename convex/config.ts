import { internalMutation, query } from "./_generated/server";
import { requireCoach } from "./lib/auth";
import defaults from "../config/defaults";

// Checked against the source contract in test:contracts. Pending defaults remain data, not code.

export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("pipeline_config")
      .withIndex("by_version", (q) => q.eq("version", defaults.version))
      .unique();
    if (existing) return existing._id; // Never patch a config, including versions already pinned by jobs.
    const active = await ctx.db
      .query("pipeline_config")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return ctx.db.insert("pipeline_config", {
      ...defaults,
      active: active.length === 0,
      createdAt: Date.now(),
    });
  },
});
export const active = query({
  args: {},
  handler: async (ctx) => {
    await requireCoach(ctx);
    return ctx.db
      .query("pipeline_config")
      .withIndex("by_active", (q) => q.eq("active", true))
      .unique();
  },
});
