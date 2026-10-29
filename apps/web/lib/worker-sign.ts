import { verifyJobToken } from "../../../convex/lib/jobToken";
import type { VideoStorage } from "./storage";

export const WORKER_SIGN_BODY_LIMIT = 32_768;
export const WORKER_SIGN_RESPONSE_LIMIT = 1_048_576;
export const WORKER_SIGN_UPSTREAM_TIMEOUT_MS = 5_000;
const MAX_OPS = 32;
const MAX_SIGNED_URL_TTL_SECONDS = 3_600;

type WorkerClaims = { jobId: string; sessionId: string; exp: number };
type WorkerJob = {
  id: string;
  sessionId: string;
  status: "running";
  leaseUntil: number;
};
type SignOperation = {
  op: "get" | "put";
  key: string;
  contentType?: string;
};

export type WorkerSignDependencies = {
  env: {
    WORKER_TOKEN_SECRET?: string;
    CONVEX_SITE_URL?: string;
    SIGNED_URL_TTL_SECONDS?: string;
  };
  storage: VideoStorage | (() => VideoStorage);
  fetch: typeof fetch;
  now?: () => number;
  upstreamTimeoutMs?: number;
};

class SignFailure extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "INVALID_REQUEST"
      | "UNAUTHORIZED"
      | "WORKER_REJECTED"
      | "WORKER_UNAVAILABLE",
  ) {
    super(code);
  }
}

function noStore(value: { error: string }, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length);
  return token && !/\s/.test(token) ? token : null;
}

async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  timeout: Promise<never> | undefined = undefined,
): Promise<Uint8Array> {
  if (!body) throw new SignFailure(400, "INVALID_REQUEST");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const next = await (timeout === undefined
        ? reader.read()
        : Promise.race([reader.read(), timeout]));
      if (next.done) {
        complete = true;
        break;
      }
      length += next.value.byteLength;
      if (length > limit) throw new SignFailure(400, "INVALID_REQUEST");
      chunks.push(next.value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseOperations(value: unknown, sessionId: string): SignOperation[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SignFailure(400, "INVALID_REQUEST");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("ops" in record) || !Array.isArray(record.ops))
    throw new SignFailure(400, "INVALID_REQUEST");
  if (!record.ops.length || record.ops.length > MAX_OPS)
    throw new SignFailure(400, "INVALID_REQUEST");
  return record.ops.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SignFailure(400, "INVALID_REQUEST");
    const op = value as Record<string, unknown>;
    const allowed = op.op === "put" ? ["op", "key", "contentType"] : ["op", "key"];
    if (
      Object.keys(op).length !== allowed.length ||
      Object.keys(op).some((key) => !allowed.includes(key)) ||
      (op.op !== "get" && op.op !== "put") ||
      typeof op.key !== "string" ||
      !canonicalSessionKey(op.key, sessionId)
    )
      throw new SignFailure(400, "INVALID_REQUEST");
    if (op.op === "put") {
      if (typeof op.contentType !== "string" || !safeContentType(op.contentType))
        throw new SignFailure(400, "INVALID_REQUEST");
      return { op: "put", key: op.key, contentType: op.contentType };
    }
    return { op: "get", key: op.key };
  });
}

function canonicalSessionKey(key: string, sessionId: string): boolean {
  const prefix = `sessions/${sessionId}/`;
  if (!key.startsWith(prefix) || key.length === prefix.length) return false;
  if (key.includes("%") || key.includes("\\") || key.includes("?") || key.includes("#") || hasControlCharacter(key))
    return false;
  return key.split("/").every(
    (part) => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part),
  );
}

function safeContentType(contentType: string): boolean {
  return (
    contentType.length <= 200 &&
    !hasControlCharacter(contentType) &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"]*"))*$/.test(
      contentType,
    )
  );
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function configuredTtl(value: string | undefined): number {
  const ttl = value === undefined ? 600 : Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_SIGNED_URL_TTL_SECONDS)
    throw new SignFailure(503, "WORKER_UNAVAILABLE");
  return ttl;
}

function workerJob(value: unknown): WorkerJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const job = (value as { job?: unknown }).job;
  if (!job || typeof job !== "object" || Array.isArray(job)) return null;
  const record = job as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.sessionId === "string" &&
    record.status === "running" &&
    typeof record.leaseUntil === "number" &&
    Number.isSafeInteger(record.leaseUntil)
  )
    ? {
        id: record.id,
        sessionId: record.sessionId,
        status: "running",
        leaseUntil: record.leaseUntil,
      }
    : null;
}

async function latestLiveJob(
  deps: WorkerSignDependencies,
  token: string,
  claims: WorkerClaims,
): Promise<WorkerJob> {
  let endpoint: URL;
  try {
    endpoint = new URL("/worker/job", deps.env.CONVEX_SITE_URL);
    if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password)
      throw Error("invalid endpoint");
  } catch {
    throw new SignFailure(503, "WORKER_UNAVAILABLE");
  }
  const timeout = deps.upstreamTimeoutMs ?? WORKER_SIGN_UPSTREAM_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new SignFailure(503, "WORKER_UNAVAILABLE");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SignFailure(503, "WORKER_UNAVAILABLE"));
    }, timeout);
  });
  try {
    const response = await Promise.race([
      deps.fetch(endpoint, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      }),
      timedOut,
    ]);
    if (!response.ok || response.redirected || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new SignFailure(
        response.status === 401 || response.status === 403 ? 403 : 503,
        response.status === 401 || response.status === 403 ? "WORKER_REJECTED" : "WORKER_UNAVAILABLE",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readLimited(response.body, WORKER_SIGN_RESPONSE_LIMIT, timedOut),
        ),
      );
    } catch (error) {
      if (error instanceof SignFailure && error.status === 503) throw error;
      throw new SignFailure(503, "WORKER_UNAVAILABLE");
    }
    const job = workerJob(parsed);
    if (
      !job ||
      job.id !== claims.jobId ||
      job.sessionId !== claims.sessionId ||
      job.leaseUntil <= (deps.now ?? Date.now)()
    )
      throw new SignFailure(403, "WORKER_REJECTED");
    return job;
  } catch (error) {
    if (error instanceof SignFailure) throw error;
    throw new SignFailure(503, "WORKER_UNAVAILABLE");
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}

export function createWorkerSignHandler(deps: WorkerSignDependencies) {
  return async function post(request: Request): Promise<Response> {
    try {
      const now = (deps.now ?? Date.now)();
      const token = bearer(request);
      const secret = deps.env.WORKER_TOKEN_SECRET;
      const claims = token && secret ? await verifyJobToken(token, secret, now) : null;
      if (!token || !claims) throw new SignFailure(401, "UNAUTHORIZED");
      const declaredLength = request.headers.get("content-length");
      if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) || Number(declaredLength) > WORKER_SIGN_BODY_LIMIT)
      )
        throw new SignFailure(400, "INVALID_REQUEST");
      let body: unknown;
      try {
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await readLimited(request.body, WORKER_SIGN_BODY_LIMIT),
          ),
        );
      } catch (error) {
        if (error instanceof SignFailure) throw error;
        throw new SignFailure(400, "INVALID_REQUEST");
      }
      const operations = parseOperations(body, claims.sessionId);
      const job = await latestLiveJob(deps, token, claims);
      const availableSeconds = Math.floor(
        (Math.min(claims.exp, job.leaseUntil) - (deps.now ?? Date.now)()) / 1000,
      );
      const ttl = Math.min(configuredTtl(deps.env.SIGNED_URL_TTL_SECONDS), availableSeconds);
      if (ttl < 1) throw new SignFailure(403, "WORKER_REJECTED");
      const latestExpiry = Math.min(claims.exp, job.leaseUntil);
      const storage =
        typeof deps.storage === "function" ? deps.storage() : deps.storage;
      // Only local signing has a verified expiry representation. R2 is pending.
      if (storage.driver !== "local") throw new SignFailure(503, "WORKER_UNAVAILABLE");
      const urls = await Promise.all(
        operations.map(async (operation) => {
          const url = operation.op === "get"
            ? await storage.signGetUrl(operation.key, ttl)
            : await storage.signPutUrl(operation.key, operation.contentType!, ttl);
          const expiration = new URL(url).searchParams.get("exp");
          const expiresAt = expiration && /^\d+$/.test(expiration)
            ? Number(expiration) * 1000 : Number.NaN;
          if (!Number.isSafeInteger(expiresAt) || expiresAt > latestExpiry)
            throw new SignFailure(503, "WORKER_UNAVAILABLE");
          return { op: operation.op, key: operation.key, url, expiresAt };
        }),
      );
      // Never expose a batch that expired while storage was signing it.
      if (urls.some((item) => item.expiresAt <= (deps.now ?? Date.now)()))
        throw new SignFailure(403, "WORKER_REJECTED");
      return Response.json(
        { urls },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof SignFailure) return noStore({ error: error.code }, error.status);
      return noStore({ error: "WORKER_UNAVAILABLE" }, 503);
    }
  };
}
