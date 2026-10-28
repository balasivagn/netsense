import { mutation } from "./_generated/server";
import { ensureCoach } from "./lib/auth";
export const ensure = mutation({
  args: {},
  handler: async (ctx) => (await ensureCoach(ctx))._id,
});
