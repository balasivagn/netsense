import { afterEach, beforeEach, expect, vi } from "vitest";
import { ready, data } from "./helpers";
import fixture from "../../fixtures/synthetic/persistence/core.json";
import type { Id, Doc } from "../_generated/dataModel";

let service: string;
export let secret: string;
beforeEach(() => {
  service = crypto.randomUUID();
  secret = crypto.randomUUID();
  vi.stubEnv("CONVEX_SERVICE_SECRET", service);
  vi.stubEnv("WORKER_TOKEN_SECRET", secret);
});
afterEach(() => vi.unstubAllEnvs());
export const post = (body: unknown, token: string): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
type Stage = Doc<"stageRuns">["stage"];
export async function running() {
  const c = await ready();
  const claim = await c.t.fetch(
    "/svc/jobs/claim",
    post({ leaseOwner: data.leaseOwner }, service),
  );
  expect(claim.status).toBe(200);
  const { jobToken: token, config } = await claim.json();
  const f: typeof fixture = JSON.parse(
    JSON.stringify(fixture).replaceAll("$SESSION", `sessions/${c.sessionId}`),
  );
  let serial = 0;
  const runs: Record<string, Id<"stageRuns">> = {};
  async function start(stage: Stage, remarkId?: string) {
    const response = await c.t.fetch(
      "/worker/stageRuns/start",
      post(
        {
          stage,
          workerId: config.stages.find(
            (s: { stage: string }) => s.stage === stage,
          ).workerId,
          attempt: 1,
          idempotencyKey: (++serial).toString(16).padStart(64, "0"),
          inputHash: data.run.inputHash,
          ...(remarkId ? { remarkId } : {}),
        },
        token,
      ),
    );
    expect(response.status).toBe(200);
    const id = (await response.json()).stageRunId as Id<"stageRuns">;
    runs[stage] = id;
    return id;
  }
  const persist = (
    name: string,
    id: Id<"stageRuns">,
    output: unknown,
    metadata: Record<string, unknown> = {},
  ) =>
    c.t.fetch(
      `/worker/persist/${name}`,
      post({ stageRunId: id, output, ...metadata }, token),
    );
  async function finish(id: Id<"stageRuns">) {
    const res = await c.t.fetch(
      "/worker/stageRuns/finish",
      post(
        {
          ...data.finish,
          stageRunId: id,
          outputRef: `sessions/${c.sessionId}/artifacts/${id}.json`,
        },
        token,
      ),
    );
    expect(res.status).toBe(200);
  }
  async function step(
    stage: Stage,
    name: keyof typeof fixture,
    remarkId?: string,
    metadata: Record<string, unknown> = {},
  ) {
    const id = await start(stage, remarkId);
    const res = await persist(name, id, f[name], metadata);
    expect(res.status, await res.clone().text()).toBe(200);
    await finish(id);
    return id;
  }
  // Anchor uses the same target endpoint as per-remark subject output.
  async function base() {
    await step("transcode", "transcode");
    await step("transcribe", "turns");
    await step("plan", "plan");
    const anchor = await start("subject");
    expect((await persist("target", anchor, f.anchor)).status).toBe(200);
    await finish(anchor);
    await step("moment", "moment", "synthetic-r1");
    await step("subject", "target", "synthetic-r1");
    await step("track", "track", "synthetic-r1", {
      cacheKey: data.run.inputHash,
    });
  }
  async function provenance(place: Id<"stageRuns">) {
    const rows = await c.t.run(async (ctx) =>
      Promise.all(
        [runs.moment, runs.subject, runs.track, place].map((id) =>
          ctx.db.get(id),
        ),
      ),
    );
    return {
      configVersion: 1,
      stageRunIds: Object.fromEntries(rows.map((r) => [r!.stage, r!._id])),
      workers: Object.fromEntries(rows.map((r) => [r!.stage, r!.workerId])),
      modelVersions: Object.fromEntries(
        rows
          .filter((r) => r!.modelVersion)
          .map((r) => [r!.stage, r!.modelVersion]),
      ),
      placedBy: "ai",
      candidate: null,
    };
  }
  return {
    ...c,
    token,
    f,
    config,
    runs,
    start,
    persist,
    finish,
    step,
    base,
    provenance,
  };
}
