import { expect, test } from "vitest";
import { api } from "../_generated/api";
import { data, setup } from "./helpers";

test("coach bootstrap is identity-scoped and creates no row while signed out", async () => {
  const { t, coach, other } = await setup();

  await expect(t.mutation(api.coaches.ensure, {})).rejects.toThrow(
    "UNAUTHENTICATED",
  );
  expect(await coach.mutation(api.coaches.ensure, {})).toBe(
    await coach.mutation(api.coaches.ensure, {}),
  );
  expect(await other.mutation(api.coaches.ensure, {})).not.toBe(
    await coach.mutation(api.coaches.ensure, {}),
  );
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("coaches")
        .withIndex("by_clerkUserId", (q) =>
          q.eq("clerkUserId", data.identity.subject),
        )
        .unique(),
    ),
  ).not.toBeNull();
});
