import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { verifyJobToken } from "./lib/jobToken";
import type { Id } from "./_generated/dataModel";

const http = httpRouter();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string) => json({ error: code }, status);
async function body(request: Request): Promise<Record<string, unknown> | null> { try { const value: unknown = await request.json(); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; } }
function bearer(request: Request) { const value = request.headers.get("authorization"); return value?.startsWith("Bearer ") ? value.slice(7) : null; }
async function service(request: Request) { const token = bearer(request); return !!token && !!process.env.CONVEX_SERVICE_SECRET && token === process.env.CONVEX_SERVICE_SECRET; }
async function worker(request: Request) { const token = bearer(request); if (!token || !process.env.WORKER_TOKEN_SECRET) throw Error("UNAUTHORIZED"); return verifyJobToken(token, process.env.WORKER_TOKEN_SECRET); }
function workerRoute(path: string, mutation: unknown) { http.route({ path, method: "POST", handler: httpAction(async (ctx, request) => { try { const token = await worker(request); const payload = await body(request); if (!payload || payload.jobId !== undefined || payload.sessionId !== undefined) return failure(400, "CONTRACT_INVALID"); await ctx.runMutation(mutation as never, { ...payload, jobId: token.jobId as Id<"jobs">, sessionId: token.sessionId as Id<"sessions"> } as never); return json({ ok: true }); } catch (error) { return failure(401, error instanceof Error && error.message === "UNAUTHORIZED" ? "UNAUTHORIZED" : "WORKER_REJECTED"); } }) }); }

http.route({ path: "/svc/jobs/claim", method: "POST", handler: httpAction(async (ctx, request) => { if (!(await service(request))) return failure(401, "UNAUTHORIZED"); const value = await body(request); if (!value || typeof value.leaseOwner !== "string") return failure(400, "CONTRACT_INVALID"); const job = await ctx.runMutation(internal.jobs.claim, { leaseOwner: value.leaseOwner }); return job ? json(job) : new Response(null, { status: 204 }); }) });
for (const [path, mutation] of [["/svc/jobs/sandbox", internal.svc.sandbox], ["/svc/jobs/released", internal.svc.released], ["/svc/jobs/fail", internal.svc.fail]] as const) http.route({ path, method: "POST", handler: httpAction(async (ctx, request) => { if (!(await service(request))) return failure(401, "UNAUTHORIZED"); const value = await body(request); if (!value) return failure(400, "CONTRACT_INVALID"); try { await ctx.runMutation(mutation, value as never); return json({ ok: true }); } catch { return failure(400, "SERVICE_REJECTED"); } }) });
http.route({ path: "/svc/jobs/stale", method: "GET", handler: httpAction(async (ctx, request) => { if (!(await service(request))) return failure(401, "UNAUTHORIZED"); const stale = Number(new URL(request.url).searchParams.get("heartbeatStaleMs") ?? 30_000); return Number.isFinite(stale) && stale >= 0 ? json(await ctx.runQuery(internal.svc.stale, { heartbeatStaleMs: stale })) : failure(400, "CONTRACT_INVALID"); }) });
http.route({ path: "/svc/sandboxes/open", method: "GET", handler: httpAction(async (ctx, request) => !(await service(request)) ? failure(401, "UNAUTHORIZED") : json(await ctx.runQuery(internal.svc.openSandboxes, {})) ) });
http.route({ path: "/worker/job", method: "GET", handler: httpAction(async (ctx, request) => { try { const token = await worker(request); return json(await ctx.runQuery(internal.worker.job, { jobId: token.jobId as Id<"jobs">, sessionId: token.sessionId as Id<"sessions"> })); } catch { return failure(401, "WORKER_REJECTED"); } }) });
workerRoute("/worker/heartbeat", internal.worker.heartbeat);
workerRoute("/worker/stageRuns/start", internal.worker.start);
workerRoute("/worker/stageRuns/finish", internal.worker.finish);
workerRoute("/worker/persist/turns", internal.worker.persistTurns);
workerRoute("/worker/persist/plan", internal.worker.persistPlan);
workerRoute("/worker/persist/moment", internal.worker.persistMoment);
workerRoute("/worker/persist/target", internal.worker.persistTarget);
workerRoute("/worker/persist/track", internal.worker.persistTrack);
workerRoute("/worker/persist/marks", internal.worker.persistMarks);
workerRoute("/worker/persist/verdicts", internal.worker.persistVerdicts);
workerRoute("/worker/done", internal.worker.done);
export default http;
