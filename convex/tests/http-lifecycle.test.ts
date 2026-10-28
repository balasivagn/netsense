import { afterEach, describe, expect, test } from "vitest";
import { ready } from "./helpers";

const serviceHeaders = () => ({ authorization: "Bearer route-test-service", "content-type": "application/json" });
const post = (path: string, value: unknown, headers: HeadersInit = serviceHeaders()) => ({ method: "POST", headers, body: JSON.stringify(value) });
const previous = { service: process.env.CONVEX_SERVICE_SECRET, worker: process.env.WORKER_TOKEN_SECRET };
afterEach(() => { process.env.CONVEX_SERVICE_SECRET = previous.service; process.env.WORKER_TOKEN_SECRET = previous.worker; });

describe("HTTP lifecycle routes", () => {
  test("fails closed then claims a job and records sandbox lifecycle", async () => {
    const { t, jobId } = await ready();
    process.env.CONVEX_SERVICE_SECRET = "route-test-service";
    process.env.WORKER_TOKEN_SECRET = "route-test-worker";
    expect((await t.fetch("/svc/jobs/claim", post("", { leaseOwner: "orchestrator-1" }, { "content-type": "application/json" }))).status).toBe(401);
    const claimed = await t.fetch("/svc/jobs/claim", post("", { leaseOwner: "orchestrator-1" }));
    expect(claimed.status).toBe(200);
    const payload = await claimed.json() as { job: { id: string }; jobToken: string };
    expect(payload.job.id).toBe(jobId);
    expect(payload.jobToken).toContain(".");
    expect((await t.fetch("/svc/jobs/claim", post("", { leaseOwner: "orchestrator-2" }))).status).toBe(204);
    expect((await t.fetch("/svc/jobs/sandbox", post("", { jobId, sandboxId: "local-1", sandboxName: "test-run", driver: "local" }))).status).toBe(200);
    expect((await t.fetch("/svc/jobs/sandbox", post("", { jobId, sandboxId: "local-2", sandboxName: "test-run", driver: "local" }))).status).toBe(400);
    expect((await t.fetch("/svc/sandboxes/open", { headers: serviceHeaders() })).status).toBe(200);
    expect((await t.fetch("/svc/jobs/released", post("", { jobId, sandboxId: "local-1", terminatedBy: "self", exitCode: 0 }))).status).toBe(200);
    expect((await t.fetch("/svc/sandboxes/open", { headers: serviceHeaders() })).status).toBe(200);
  });

  test("worker token authorizes heartbeat, starts and finishes a stage, and rejects a modified token", async () => {
    const { t } = await ready();
    process.env.CONVEX_SERVICE_SECRET = "route-test-service";
    process.env.WORKER_TOKEN_SECRET = "route-test-worker";
    const claim = await t.fetch("/svc/jobs/claim", post("", { leaseOwner: "orchestrator-1" }));
    const { jobToken } = await claim.json() as { jobToken: string };
    const headers = { authorization: `Bearer ${jobToken}`, "content-type": "application/json" };
    expect((await t.fetch("/worker/heartbeat", { method: "POST", headers, body: "{}" })).status).toBe(200);
    const hash = "a".repeat(64);
    const started = await t.fetch("/worker/stageRuns/start", { method: "POST", headers, body: JSON.stringify({ stage: "transcode", workerId: "transcode.ffmpeg@1", attempt: 1, idempotencyKey: hash, inputHash: hash }) });
    expect(started.status).toBe(200);
    const { stageRunId } = await started.json() as { stageRunId: string };
    expect((await t.fetch("/worker/stageRuns/finish", { method: "POST", headers, body: JSON.stringify({ stageRunId, status: "done", outputRef: "sessions/invalid/output", samFrames: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }) })).status).toBe(403);
    expect((await t.fetch("/worker/heartbeat", { method: "POST", headers: { ...headers, authorization: `Bearer ${jobToken}x` }, body: "{}" })).status).toBe(401);
  });
});
