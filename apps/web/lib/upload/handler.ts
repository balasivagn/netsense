import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import type { Doc, Id } from "../../../../convex/_generated/dataModel";
import {
  object,
  string,
  integer,
  nullable,
} from "../../../../convex/lib/httpInput";
import { getCoachRouteAuth } from "../coach-route-auth";
import { getVideoStorage } from "../storage";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const parts = (value: unknown) => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 32 ||
    new Set(value).size !== value.length
  )
    throw Error("INVALID_REQUEST");
  return value.map(integer);
};
// Bound both streamed bodies and the entire read, including stalled streams.
async function bounded(request: Request, limit = 32768): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw Error("INVALID_REQUEST");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > limit) throw Error("INVALID_REQUEST");
          chunks.push(next.value);
        }
        const all = new Uint8Array(length);
        let at = 0;
        for (const chunk of chunks) {
          all.set(chunk, at);
          at += chunk.length;
        }
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(all),
        );
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("TIMEOUT")), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function service(operation: string, body: unknown): Promise<unknown> {
  const site = process.env.CONVEX_SITE_URL;
  const secret = process.env.CONVEX_SERVICE_SECRET;
  if (!site || !secret) throw Error("SERVICE_UNAVAILABLE");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      `${site.replace(/\/$/, "")}/svc/uploads/${operation}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("UPLOAD_CONFLICT");
    }
    // Use the same bounded stream reader; AbortController also bounds response headers.
    return await bounded(
      new Request("http://upload.internal", {
        method: "POST",
        body: response.body,
        duplex: "half",
      } as RequestInit),
      262144,
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
export function uploadHandler(
  operation: "init" | "parts" | "confirm" | "complete" | "abort",
) {
  return async (
    request: Request,
    context?: { params: Promise<{ uploadId: string }> },
  ) => {
    try {
      const auth = await getCoachRouteAuth();
      if (!auth) return json({ error: "UNAUTHENTICATED" }, 401);
      const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
        logger: false,
        fetch: async (url, init) => {
          const response = await fetch(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          const body = await bounded(
            new Request("http://upload.internal", {
              method: "POST",
              body: response.body,
              duplex: "half",
            } as RequestInit),
            1048576,
          );
          return Response.json(body, { status: response.status });
        },
      });
      client.setAuth(auth.convexToken);
      const input = await bounded(request);
      if (operation === "init") {
        const a = object(input, {
          sessionId: string,
          fileName: string,
          mimeType: string,
          bytesTotal: integer,
          sha256: string,
        });
        if (
          a.bytesTotal < 1 ||
          a.bytesTotal > 2 * 1024 ** 3 ||
          !/^[a-f0-9]{64}$/.test(a.sha256) ||
          !["video/mp4", "video/quicktime", "video/webm"].includes(a.mimeType)
        )
          return json({ error: "INVALID_REQUEST" }, 400);
        const session = await client.query(api.sessions.get, {
          sessionId: a.sessionId as Id<"sessions">,
        });
        if (session.consentConfirmedAt === undefined)
          return json({ error: "CONSENT_REQUIRED" }, 409);
        const storage = getVideoStorage();
        if (storage.driver !== "local") throw Error("SERVICE_UNAVAILABLE"); // R2 UNTESTED; fail closed.
        const u = (await service("reserve", {
          sessionId: session._id,
          coachId: session.coachId,
          sha256: a.sha256,
          mimeType: a.mimeType,
          bytesTotal: a.bytesTotal,
          multipartUploadId: randomUUID(),
        })) as Doc<"uploads">;
        if (
          !u.multipartUploadId ||
          u.driver !== "local" ||
          u.storageKey !== `sessions/${session._id}/source/original`
        )
          throw Error("UPLOAD_CONFLICT");
        if (
          (u.status !== "in_progress" && u.status !== "complete") ||
          u.phase === "aborting"
        )
          throw Error("UPLOAD_CONFLICT");
        if (u.status === "in_progress" && !u.phase)
          await storage.initMultipart(
            u.storageKey,
            u.mimeType,
            u.multipartUploadId,
          );
        return json({
          uploadId: u._id,
          partSize: u.partSize,
          partCount: Math.ceil(u.bytesTotal / u.partSize),
          resumeFrom: u.partsConfirmed,
        });
      }
      const uploadId = (await context!.params).uploadId as Id<"uploads">;
      let u = await client.query(api.uploads.owned, { uploadId });
      const session = await client.query(api.sessions.get, {
        sessionId: u.sessionId,
      });
      if (session.consentConfirmedAt === undefined)
        return json({ error: "CONSENT_REQUIRED" }, 409);
      const storage = getVideoStorage();
      if (
        storage.driver !== "local" ||
        u.driver !== "local" ||
        !u.multipartUploadId ||
        u.storageKey !== `sessions/${session._id}/source/original`
      )
        throw Error("SERVICE_UNAVAILABLE");
      const owner = { uploadId, coachId: u.coachId };
      if (operation === "parts") {
        const a = object(input, { partNumbers: parts });
        if (
          u.status !== "in_progress" ||
          u.phase ||
          a.partNumbers.some(
            (n) => n < 1 || n > Math.ceil(u.bytesTotal / u.partSize),
          )
        )
          throw Error("UPLOAD_CONFLICT");
        await storage.initMultipart(
          u.storageKey,
          u.mimeType,
          u.multipartUploadId,
        );
        return json({
          urls: await storage.signPartUrls(
            u.storageKey,
            u.multipartUploadId,
            a.partNumbers,
            900,
          ),
        });
      }
      if (operation === "confirm") {
        const a = object(input, {
          partNumber: integer,
          etag: string,
          bytes: integer,
        });
        if (
          u.status !== "in_progress" ||
          u.phase ||
          a.partNumber < 1 ||
          a.partNumber > Math.ceil(u.bytesTotal / u.partSize)
        )
          throw Error("UPLOAD_CONFLICT");
        const actual = await storage.inspectPart!(
          u.storageKey,
          u.multipartUploadId,
          a.partNumber,
        );
        if (actual.bytes !== a.bytes || actual.etag !== a.etag)
          throw Error("UPLOAD_CONFLICT");
        return json(
          object(
            await service("confirm", {
              ...owner,
              partNumber: a.partNumber,
              ...actual,
            }),
            { bytesConfirmed: integer },
          ),
        );
      }
      object(input, {});
      u = (await service("begin", {
        ...owner,
        operation: operation === "complete" ? "completing" : "aborting",
      })) as Doc<"uploads">;
      if (operation === "abort") {
        if (u.status !== "aborted") {
          // Ensure reserved-but-not-yet-created uploads can also be cancelled.
          try {
            await storage.abortMultipart(u.storageKey, u.multipartUploadId!);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "UNKNOWN_UPLOAD")
              throw error;
            await storage.initMultipart(
              u.storageKey,
              u.mimeType,
              u.multipartUploadId,
            );
            await storage.abortMultipart(u.storageKey, u.multipartUploadId!);
          }
          await service("abort", owner);
        }
        return json({});
      }
      if (u.status !== "complete")
        await storage.completeMultipart(
          u.storageKey,
          u.multipartUploadId!,
          u.confirmedParts ?? [],
        );
      const head = await storage.head(u.storageKey);
      if (!head || head.bytes !== u.bytesTotal) throw Error("UPLOAD_CONFLICT");
      return json(
        object(
          await service("complete", { ...owner, verifiedBytes: head.bytes }),
          { jobId: nullable(string) },
        ),
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      return json(
        {
          error:
            code === "SERVICE_UNAVAILABLE"
              ? "SERVICE_UNAVAILABLE"
              : "UPLOAD_REJECTED",
        },
        code === "SERVICE_UNAVAILABLE" ? 503 : 409,
      );
    }
  };
}
