import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import { ready, data } from "./helpers";
test("two concurrent claims have exactly one winner and increment attempt once", async () => {
  const { t, jobId } = await ready();
  const results = await Promise.all([
    t.mutation(internal.jobs.claim, { leaseOwner: data.leaseOwner }),
    t.mutation(internal.jobs.claim, { leaseOwner: data.leaseOwner + "-2" }),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const job = await t.run((ctx) => ctx.db.get(jobId));
  expect(job?.status).toBe("running");
  expect(job?.attempt).toBe(1);
  expect(job?.leaseUntil).toBeGreaterThan(job?.heartbeatAt ?? Infinity);
});
test("claim uses pinned config and seed never overwrites used version", async () => {
  const { t, jobId } = await ready();
  const config = await t.run(async (ctx) => {
    const old = (await ctx.db.query("pipeline_config").collect())[0];
    await ctx.db.patch(old._id, { active: false });
    const { _id, _creationTime, ...copy } = old;
    void _id;
    void _creationTime;
    await ctx.db.insert("pipeline_config", {
      ...copy,
      version: 2,
      active: true,
      limits: { ...copy.limits, jobLeaseS: 5 },
    });
    return old;
  });
  await t.mutation(internal.config.seed, {});
  const claimed = await t.mutation(internal.jobs.claim, {
    leaseOwner: data.leaseOwner,
  });
  expect(claimed?._id).toBe(jobId);
  expect(claimed?.configVersion).toBe(1);
  expect(claimed!.leaseUntil! - claimed!.heartbeatAt!).toBe(
    config.limits.jobLeaseS * 1000,
  );
  expect((await t.run((ctx) => ctx.db.get(config._id)))?.active).toBe(false);
});
test("exhausted attempts and blank lease owner cannot claim", async () => {
  const { t, jobId } = await ready();
  await expect(
    t.mutation(internal.jobs.claim, { leaseOwner: " " }),
  ).rejects.toThrow("INVALID_LEASE_OWNER");
  await t.run((ctx) => ctx.db.patch(jobId, { attempt: 3 }));
  expect(
    await t.mutation(internal.jobs.claim, { leaseOwner: data.leaseOwner }),
  ).toBeNull();
});
