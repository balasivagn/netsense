import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { verifyJobToken, signJobToken } from "./lib/jobToken";
import { jobWire } from "./lib/lifecycle";
import {
  readBody,
  object,
  string,
  integer,
  number,
  optional,
  nullable,
  enumeration,
  id,
  parseError,
  parseStage,
  parseStageStatus,
} from "./lib/httpInput";

const http = httpRouter();
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const safeError = (status: number, code: string) =>
  json({ error: code }, status);
function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}
function service(request: Request): boolean {
  const secret = process.env.CONVEX_SERVICE_SECRET;
  return !!secret && bearer(request) === secret;
}
async function worker(request: Request) {
  const token = bearer(request);
  return token &&
    (await verifyJobToken(token, process.env.WORKER_TOKEN_SECRET ?? ""))
    ? token
    : null;
}

type Invoke = (
  ctx: ActionCtx,
  input: unknown,
  token: string,
) => Promise<unknown>;
function post(path: string, auth: "service" | "worker", invoke: Invoke) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const token =
        auth === "service"
          ? service(request)
            ? "service"
            : null
          : await worker(request);
      if (!token) return safeError(401, "UNAUTHORIZED");
      let input: unknown;
      try {
        input = await readBody(request);
      } catch {
        return safeError(400, "INVALID_REQUEST");
      }
      try {
        return json(await invoke(ctx, input, token));
      } catch {
        return safeError(
          auth === "worker" ? 403 : 400,
          auth === "worker" ? "WORKER_REJECTED" : "REQUEST_REJECTED",
        );
      }
    }),
  });
}
http.route({
  path: "/svc/jobs/claim",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!service(request)) return safeError(401, "UNAUTHORIZED");
    const secret = process.env.WORKER_TOKEN_SECRET;
    if (!secret) return safeError(503, "WORKER_AUTH_UNAVAILABLE");
    try {
      const input = object(await readBody(request), { leaseOwner: string });
      const result = await ctx.runMutation(internal.svc.claim, input);
      if (!result) return new Response(null, { status: 204 });
      const exp = result.job.heartbeatAt! + result.timeoutS * 1000 + 300_000;
      const jobToken = await signJobToken(
        { jobId: result.job._id, sessionId: result.job.sessionId, exp },
        secret,
      );
      return json({
        job: jobWire(result.job),
        config: result.config,
        jobToken,
        timeoutS: result.timeoutS,
      });
    } catch {
      return safeError(400, "REQUEST_REJECTED");
    }
  }),
});
post("/svc/jobs/sandbox", "service", async (ctx, input) => {
  await ctx.runMutation(
    internal.svc.sandbox,
    object(input, {
      jobId: id("jobs"),
      sandboxId: string,
      sandboxName: string,
      driver: enumeration(["local", "modal"]),
    }),
  );
  return { ok: true };
});
post("/svc/jobs/released", "service", async (ctx, input) => {
  await ctx.runMutation(
    internal.svc.released,
    object(input, {
      jobId: id("jobs"),
      sandboxId: string,
      terminatedBy: enumeration(["orchestrator", "sweeper", "timeout", "self"]),
      exitCode: optional(nullable(integer)),
    }),
  );
  return { ok: true };
});
post("/svc/jobs/fail", "service", async (ctx, input) => {
  await ctx.runMutation(
    internal.svc.fail,
    object(input, { jobId: id("jobs"), errorCode: parseError }),
  );
  return { ok: true };
});
for (const path of ["/svc/jobs/stale", "/svc/sandboxes/open"])
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      if (!service(request)) return safeError(401, "UNAUTHORIZED");
      try {
        if (path.endsWith("open"))
          return json(await ctx.runQuery(internal.svc.openSandboxes, {}));
        const staleSeconds = Number(process.env.HEARTBEAT_STALE_S ?? "90");
        if (!Number.isFinite(staleSeconds) || staleSeconds <= 0)
          return safeError(503, "INVALID_STALE_CONFIG");
        return json(await ctx.runQuery(internal.svc.stale, { staleSeconds }));
      } catch {
        return safeError(400, "REQUEST_REJECTED");
      }
    }),
  });
http.route({
  path: "/worker/job",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = await worker(request);
    if (!token) return safeError(401, "UNAUTHORIZED");
    try {
      return json(await ctx.runQuery(internal.worker.read, { token }));
    } catch {
      return safeError(403, "WORKER_REJECTED");
    }
  }),
});
post("/worker/heartbeat", "worker", async (ctx, input, token) => {
  object(input, {});
  await ctx.runMutation(internal.worker.heartbeat, { token });
  return { ok: true };
});
post("/worker/stageRuns/start", "worker", async (ctx, input, token) => {
  const args = object(input, {
    stage: parseStage,
    workerId: string,
    attempt: integer,
    idempotencyKey: string,
    inputHash: string,
    remarkId: optional(string),
    promptHash: optional(string),
    candidate: optional(string),
  });
  return {
    stageRunId: await ctx.runMutation(internal.worker.start, {
      token,
      ...args,
    }),
  };
});
post("/worker/stageRuns/finish", "worker", async (ctx, input, token) => {
  const args = object(input, {
    stageRunId: id("stageRuns"),
    status: parseStageStatus,
    samFrames: integer,
    inputTokens: integer,
    outputTokens: integer,
    costUsd: number,
    outputRef: optional(string),
    errorCode: optional(parseError),
  });
  await ctx.runMutation(internal.worker.finish, { token, ...args });
  return { ok: true };
});
post("/worker/done", "worker", async (ctx, input, token) => {
  const args = object(input, {
    status: enumeration(["waiting_for_coach", "failed", "done"]),
    errorCode: optional(parseError),
  });
  await ctx.runMutation(internal.worker.done, { token, ...args });
  return { ok: true };
});
export default http;
