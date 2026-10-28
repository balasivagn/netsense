import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { verifyJobToken, signJobToken } from "./lib/jobToken";

const http = httpRouter();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const safeError = (status: number, code: string) => json({ error: code }, status);
const serviceSecret = () => process.env.CONVEX_SERVICE_SECRET;
const workerSecret = () => process.env.WORKER_TOKEN_SECRET;

async function body(request: Request): Promise<Record<string, unknown> | null> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(length) || length > 32_768) return null;
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function exact(record: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(record).length === keys.length && keys.every((key) => key in record); }
function closed(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in record) && Object.keys(record).every((key) => allowed.has(key));
}
function bearer(request: Request): string | null { const value = request.headers.get("authorization"); return value?.startsWith("Bearer ") ? value.slice(7) : null; }
function service(request: Request): boolean { const secret = serviceSecret(); return !!secret && bearer(request) === secret; }

const claim = httpAction(async (ctx, request) => {
  if (!service(request)) return safeError(401, "UNAUTHORIZED");
  const input = await body(request);
  if (!input || !exact(input, ["leaseOwner"]) || typeof input.leaseOwner !== "string") return safeError(400, "INVALID_REQUEST");
  if (!workerSecret()) return safeError(503, "WORKER_AUTH_UNAVAILABLE");
  try {
    const result = await ctx.runMutation(internal.svc.claim, { leaseOwner: input.leaseOwner });
    if (!result) return new Response(null, { status: 204 });
    const exp = Date.now() + result.timeoutS * 1000 + 300_000;
    const jobToken = await signJobToken({ jobId: result.jobId, sessionId: result.sessionId, exp }, workerSecret()!);
    return json({ job: { id: result.jobId, sessionId: result.sessionId }, config: result.config, jobToken, timeoutS: result.timeoutS });
  } catch { return safeError(400, "REQUEST_REJECTED"); }
});

function serviceMutation(path: string, handler: (ctx: Parameters<Parameters<typeof httpAction>[0]>[0], input: Record<string, unknown>) => Promise<unknown>) {
  http.route({ path, method: "POST", handler: httpAction(async (ctx, request) => { if (!service(request)) return safeError(401, "UNAUTHORIZED"); const input = await body(request); if (!input) return safeError(400, "INVALID_REQUEST"); try { await handler(ctx, input); return json({ ok: true }); } catch { return safeError(400, "REQUEST_REJECTED"); } }) });
}

http.route({ path: "/svc/jobs/claim", method: "POST", handler: claim });
serviceMutation("/svc/jobs/sandbox", (ctx, input) => exact(input, ["jobId", "sandboxId", "sandboxName", "driver"]) && typeof input.jobId === "string" && typeof input.sandboxId === "string" && typeof input.sandboxName === "string" && (input.driver === "local" || input.driver === "modal") ? ctx.runMutation(internal.svc.sandbox, { jobId: input.jobId as never, sandboxId: input.sandboxId, sandboxName: input.sandboxName, driver: input.driver }) : Promise.reject());
serviceMutation("/svc/jobs/released", (ctx, input) => (Object.keys(input).every((key) => ["jobId", "sandboxId", "terminatedBy", "exitCode"].includes(key)) && typeof input.jobId === "string" && typeof input.sandboxId === "string" && typeof input.terminatedBy === "string") ? ctx.runMutation(internal.svc.released, { jobId: input.jobId as never, sandboxId: input.sandboxId, terminatedBy: input.terminatedBy as never, ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode as never }) }) : Promise.reject());
serviceMutation("/svc/jobs/fail", (ctx, input) => exact(input, ["jobId", "errorCode"]) && typeof input.jobId === "string" && typeof input.errorCode === "string" ? ctx.runMutation(internal.svc.fail, { jobId: input.jobId as never, errorCode: input.errorCode as never }) : Promise.reject());

for (const [path, query] of [["/svc/jobs/stale", internal.svc.stale], ["/svc/sandboxes/open", internal.svc.openSandboxes]] as const) http.route({ path, method: "GET", handler: httpAction(async (ctx, request) => { if (!service(request)) return safeError(401, "UNAUTHORIZED"); try { return json(path.endsWith("stale") ? await ctx.runQuery(query, { staleSeconds: Number(process.env.HEARTBEAT_STALE_S ?? "90") }) : await ctx.runQuery(query, {})); } catch { return safeError(400, "REQUEST_REJECTED"); } }) });

async function worker(request: Request) { const secret = workerSecret(); const token = bearer(request); return secret && token && await verifyJobToken(token, secret) ? token : null; }
function workerMutation(path: string, required: readonly string[], optional: readonly string[], invoke: (ctx: Parameters<Parameters<typeof httpAction>[0]>[0], token: string, input: Record<string, unknown>) => Promise<unknown>) { http.route({ path, method: "POST", handler: httpAction(async (ctx, request) => { const token = await worker(request); if (!token) return safeError(401, "UNAUTHORIZED"); const input = await body(request); if (!input || !closed(input, required, optional)) return safeError(400, "INVALID_REQUEST"); try { await invoke(ctx, token, input); return json({ ok: true }); } catch { return safeError(403, "WORKER_REJECTED"); } }) }); }
http.route({ path: "/worker/job", method: "GET", handler: httpAction(async (ctx, request) => { const token = await worker(request); if (!token) return safeError(401, "UNAUTHORIZED"); const claims = await verifyJobToken(token, workerSecret()!); try { return json(await ctx.runQuery(internal.worker.read, { jobId: claims!.jobId as never })); } catch { return safeError(403, "WORKER_REJECTED"); } }) });
workerMutation("/worker/heartbeat", [], [], (ctx, token) => ctx.runMutation(internal.worker.heartbeat, { token }));
http.route({ path: "/worker/stageRuns/start", method: "POST", handler: httpAction(async (ctx, request) => {
  const token = await worker(request);
  const input = await body(request);
  if (!token) return safeError(401, "UNAUTHORIZED");
  if (!input || !closed(input, ["stage", "workerId", "attempt", "idempotencyKey", "inputHash"], ["remarkId", "promptHash", "candidate"])) return safeError(400, "INVALID_REQUEST");
  try { return json({ stageRunId: await ctx.runMutation(internal.worker.start, { token, ...input } as never) }); } catch { return safeError(403, "WORKER_REJECTED"); }
}) });
workerMutation("/worker/stageRuns/finish", ["stageRunId", "status", "samFrames", "inputTokens", "outputTokens", "costUsd"], ["outputRef", "errorCode"], (ctx, token, input) => ctx.runMutation(internal.worker.finish, { token, ...input } as never));
workerMutation("/worker/done", ["status"], ["errorCode"], (ctx, token, input) => ctx.runMutation(internal.worker.done, { token, ...input } as never));

export default http;
