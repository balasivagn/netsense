import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { canonical } from "../../../../packages/contracts/validateSchema";
import { validateTranscodeOutput } from "../../../../packages/contracts/gen/persistenceValidation";
import { getCoachRouteAuth } from "../coach-route-auth";
import { readObject, safeRef } from "../coach-media/handler";
import { getVideoStorage, LocalVideoStorage } from "../storage";
import { validateTrack } from "../overlay/track";
import { verifyRange } from "./verify";
let active = 0;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function bounded(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  signal: AbortSignal,
) {
  if (!body) throw Error("INVALID_REQUEST");
  const reader = body.getReader();
  const abort = () => void reader.cancel();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const n = await reader.read();
      signal.throwIfAborted();
      if (n.done) break;
      size += n.value.length;
      if (size > max) throw Error("INVALID_REQUEST");
      chunks.push(n.value);
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel();
  }
}
export async function approveReview(request: Request) {
  if (active >= 4) return json({ error: "REVIEW_BUSY" }, 409);
  active++;
  const expiresAt = Date.now() + 10000;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  let authPending = false;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      active--;
    }
  };
  try {
    signal.throwIfAborted();
    // Keep the concurrency slot until even a stalled auth operation settles.
    authPending = true;
    const authWork = getCoachRouteAuth().finally(() => {
      authPending = false;
      if (signal.aborted) release();
    });
    const auth = await Promise.race([
      authWork,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(Error("TIMEOUT")), {
          once: true,
        });
      }),
    ]);
    if (!auth) return json({ error: "UNAUTHENTICATED" }, 401);
    const args = JSON.parse(
      (await bounded(request.body, 32768, signal)).toString("utf8"),
    );
    if (
      !args ||
      Object.keys(args).sort().join(",") !==
        "annotationId,expectedRevision,expectedUpdatedAt" ||
      typeof args.annotationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(args.annotationId) ||
      !Number.isSafeInteger(args.expectedUpdatedAt) ||
      typeof args.expectedRevision !== "string" ||
      args.expectedRevision.length > 30000
    )
      return json({ error: "INVALID_REQUEST" }, 400);
    const boundedFetch: typeof fetch = async (url, init) => {
      signal.throwIfAborted();
      const r = await fetch(url, { ...init, signal, redirect: "error" });
      return new Response(await bounded(r.body, 1048576, signal), {
        status: r.status,
      });
    };
    const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
      logger: false,
      fetch: boundedFetch,
    });
    client.setAuth(auth.convexToken);
    const input = await client.query(api.review.approvalInput, {
      annotationId: args.annotationId as Id<"annotations">,
      expectedUpdatedAt: args.expectedUpdatedAt,
      expectedRevision: args.expectedRevision,
    });
    if (input.mode !== "note_only") {
      if (
        !input.artifact ||
        !safeRef(input.artifact, input.sessionId) ||
        !input.trackRef ||
        !safeRef(input.trackRef, input.sessionId)
      )
        throw Error("UNAVAILABLE");
      const storage = getVideoStorage();
      if (!(storage instanceof LocalVideoStorage)) throw Error("UNAVAILABLE"); // R2 UNTESTED.
      const output: unknown = JSON.parse(
        await readObject(storage, input.artifact, 1048576, signal),
      );
      validateTranscodeOutput(output);
      if (
        createHash("sha256").update(canonical({ output })).digest("hex") !==
          input.artifactHash ||
        output.durationMs !== input.durationMs ||
        output.width > 1920 ||
        output.height > 1080 ||
        output.fps > 60
      )
        throw Error("UNAVAILABLE");
      const track = validateTrack(
        JSON.parse(await readObject(storage, input.trackRef, 1048576, signal)),
        output.width,
        output.height,
        output.durationMs,
      );
      verifyRange(
        track,
        input.startMs,
        input.endMs,
        input.minMarkCoverage,
        input.mode,
        input.keyframeMs,
      );
    }
    signal.throwIfAborted();
    const site = process.env.CONVEX_SITE_URL,
      secret = process.env.CONVEX_SERVICE_SECRET;
    if (!site || !secret) throw Error("UNAVAILABLE");
    const response = await boundedFetch(
      `${site.replace(/\/$/, "")}/svc/review/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          annotationId: args.annotationId,
          expectedUpdatedAt: args.expectedUpdatedAt,
          coachId: input.coachId,
          state: input.state,
          expiresAt,
        }),
      },
    );
    if (!response.ok) throw Error("CONFLICT");
    return json({ ok: true });
  } catch {
    return json({ error: "REVIEW_RECHECK_REQUIRED" }, 409);
  } finally {
    if (!authPending) release();
  }
}
