import { createHash } from "node:crypto";
import { canonical } from "../../../../packages/contracts/validateSchema";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { getCoachRouteAuth } from "../coach-route-auth";
import { getVideoStorage, LocalVideoStorage } from "../storage";
import { validateTranscodeOutput } from "../../../../packages/contracts/gen/persistenceValidation";
import { validateTrack } from "../overlay/track";
let active = 0,
  pendingAuth = 0;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export function safeRef(key: string, id: string) {
  return (
    key.startsWith(`sessions/${id}/`) &&
    key
      .split("/")
      .every(
        (p) =>
          /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/.test(p) &&
          p !== "." &&
          p !== "..",
      )
  );
}
export async function readObject(
  storage: LocalVideoStorage,
  key: string,
  max: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const r = await storage.openRange(key, null);
  const abort = () => r.stream.destroy(Error("MEDIA_UNAVAILABLE"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    if (r.size > max) throw Error("MEDIA_UNAVAILABLE");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of r.stream) {
      signal.throwIfAborted();
      const b = c as Buffer;
      size += b.length;
      if (size > max) throw Error("MEDIA_UNAVAILABLE");
      chunks.push(b);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", abort);
    r.stream.destroy();
  }
}
export async function mediaSign(request: Request) {
  if (active >= 4 || pendingAuth >= 4)
    return json({ error: "MEDIA_BUSY" }, 409);
  active++;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  try {
    signal.throwIfAborted();
    pendingAuth++;
    const authPromise = getCoachRouteAuth().finally(() => pendingAuth--);
    const auth = await Promise.race([
      authPromise,
      new Promise<never>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(Error("MEDIA_UNAVAILABLE")),
          { once: true },
        ),
      ),
    ]);
    if (!auth) return json({ error: "UNAUTHENTICATED" }, 401);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "INVALID_REQUEST" }, 400);
    let size = 0;
    const chunks: Uint8Array[] = [];
    const abort = () => void reader.cancel();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      while (true) {
        const n = await reader.read();
        signal.throwIfAborted();
        if (n.done) break;
        size += n.value.length;
        if (size > 4096) throw Error("INVALID_REQUEST");
        chunks.push(n.value);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel();
    }
    const args: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !args ||
      typeof args !== "object" ||
      Object.keys(args).sort().join(",") !== "asset,sessionId"
    )
      return json({ error: "INVALID_REQUEST" }, 400);
    const { sessionId, asset } = args as { sessionId: string; asset: string };
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ||
      typeof asset !== "string" ||
      asset.length > 180
    )
      return json({ error: "INVALID_REQUEST" }, 400);
    const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
      logger: false,
      fetch: async (url, init) => {
        const response = await fetch(url, {
          ...init,
          signal,
          redirect: "error",
        });
        const reader = response.body?.getReader();
        if (!reader) throw Error("MEDIA_UNAVAILABLE");
        const chunks: Uint8Array[] = [];
        let size = 0;
        const abort = () => void reader.cancel();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          while (true) {
            const n = await reader.read();
            signal.throwIfAborted();
            if (n.done) break;
            size += n.value.length;
            if (size > 1048576) throw Error("MEDIA_UNAVAILABLE");
            chunks.push(n.value);
          }
          return new Response(Buffer.concat(chunks), {
            status: response.status,
          });
        } finally {
          signal.removeEventListener("abort", abort);
          await reader.cancel();
        }
      },
    });
    client.setAuth(auth.convexToken);
    const data = await client.query(api.playback.get, {
      sessionId: sessionId as Id<"sessions">,
    });
    // Authorization and the closed asset selector precede every storage operation.
    if (
      !["proxy", "audio", "preview"].includes(asset) &&
      !data.preview?.stillRefs.some(
        (s) => asset === `still:${s.annotationId}`,
      ) &&
      !data.tracks.some((t) => asset === `track:${t.remarkId}`)
    )
      return json({ error: "NOT_FOUND" }, 404);
    if (!data.artifact || !safeRef(data.artifact, sessionId))
      throw Error("MEDIA_UNAVAILABLE");
    const storage = getVideoStorage();
    if (!(storage instanceof LocalVideoStorage))
      throw Error("MEDIA_UNAVAILABLE"); // R2 UNTESTED/unimplemented.
    const ttl = Number(process.env.SIGNED_URL_TTL_SECONDS || 600);
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 3600)
      throw Error("MEDIA_UNAVAILABLE");
    const output: unknown = JSON.parse(
      await readObject(storage, data.artifact, 1048576, signal),
    );
    validateTranscodeOutput(output);
    if (
      createHash("sha256").update(canonical({ output })).digest("hex") !==
      data.artifactHash
    )
      throw Error("MEDIA_UNAVAILABLE");
    if (
      output.durationMs !== data.durationMs ||
      output.width > 1920 ||
      output.height > 1080 ||
      output.fps > 60 ||
      !safeRef(output.proxyKey, sessionId) ||
      !safeRef(output.audioM4aKey, sessionId)
    )
      throw Error("MEDIA_UNAVAILABLE");
    let key: string | undefined;
    if (asset === "proxy") key = output.proxyKey;
    else if (asset === "audio") key = output.audioM4aKey;
    else if (asset === "preview")
      key = data.preview?.mode === "video" ? data.preview.fileRef : undefined;
    else if (asset.startsWith("still:"))
      key = data.preview?.stillRefs.find(
        (s) => asset === `still:${s.annotationId}`,
      )?.key;
    else if (asset.startsWith("track:")) {
      const ts = data.tracks.filter(
        (t) =>
          asset === `track:${t.remarkId}` &&
          data.annotations.some(
            (a) =>
              a.trackId === t.trackId &&
              a.remarkId === t.remarkId &&
              a.status !== "deleted",
          ),
      );
      if (ts.length !== 1) throw Error("MEDIA_UNAVAILABLE");
      key = ts[0].fileRef;
      if (!safeRef(key, sessionId)) throw Error("MEDIA_UNAVAILABLE");
      const track = validateTrack(
        JSON.parse(await readObject(storage, key, 1048576, signal)),
        output.width,
        output.height,
        output.durationMs,
      );
      return json({
        url: await storage.signGetUrl(key, ttl),
        expiresAt: Date.now() + ttl * 1000,
        track,
        trackId: ts[0].trackId,
        width: output.width,
        height: output.height,
        durationMs: output.durationMs,
      });
    }
    if (!key || !safeRef(key, sessionId)) throw Error("MEDIA_UNAVAILABLE");
    // openRange checks O_NOFOLLOW, regular file and captures an inode before signing.
    const r = await storage.openRange(key, null);
    r.stream.destroy();
    const url = await storage.signGetUrl(key, ttl);
    signal.throwIfAborted();
    return json({
      url,
      expiresAt: Date.now() + ttl * 1000,
      width: output.width,
      height: output.height,
      durationMs: output.durationMs,
    });
  } catch {
    return json({ error: "MEDIA_UNAVAILABLE" }, 409);
  } finally {
    active--;
  }
}
