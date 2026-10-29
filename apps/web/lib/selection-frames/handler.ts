import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { getCoachRouteAuth } from "../coach-route-auth";
import { getVideoStorage, LocalVideoStorage } from "../storage";
import { extract } from "./extract";
let activeRequests = 0;
let pendingAuth = 0;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function selectionFramesHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (activeRequests >= 4 || pendingAuth >= 4)
    return json({ error: "SELECTION_BUSY" }, 409);
  activeRequests++;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 90000);
  const signal = AbortSignal.any([controller.signal, request.signal]);
  try {
    const auth = await new Promise<
      Awaited<ReturnType<typeof getCoachRouteAuth>>
    >((resolve, reject) => {
      const abort = () => reject(Error("SELECTION_UNAVAILABLE"));
      signal.addEventListener("abort", abort, { once: true });
      pendingAuth++;
      void getCoachRouteAuth()
        .then(resolve, reject)
        .finally(() => {
          pendingAuth--;
          signal.removeEventListener("abort", abort);
        });
      if (signal.aborted) abort();
    });
    if (!auth) return json({ error: "UNAUTHENTICATED" }, 401);
    if (new URL(request.url).search || request.body)
      return json({ error: "INVALID_REQUEST" }, 400);
    signal.throwIfAborted();
    const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
      logger: false,
      fetch: async (url, init) => {
        const response = await fetch(url, {
          ...init,
          redirect: "error",
          signal,
        });
        const reader = response.body?.getReader();
        if (!reader) throw Error("SELECTION_UNAVAILABLE");
        const abort = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          while (true) {
            const next = await reader.read();
            signal.throwIfAborted();
            if (next.done) break;
            bytes += next.value.length;
            if (bytes > 32768) throw Error("SELECTION_UNAVAILABLE");
            chunks.push(next.value);
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
    const { id } = await context.params;
    const source = await client.query(api.selectionFrames.source, {
      sessionId: id as Id<"sessions">,
    });
    signal.throwIfAborted();
    const storage = getVideoStorage();
    if (!(storage instanceof LocalVideoStorage))
      throw Error("SELECTION_UNAVAILABLE");
    const frames = await extract(storage, source, signal);
    const selectionFrames = await Promise.all(
      frames.map(async ({ key, ...frame }) => ({
        ...frame,
        url: await storage.signGetUrl(key, 300),
      })),
    );
    signal.throwIfAborted();
    return json({ selectionFrames });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error && error.message === "SELECTION_BUSY"
            ? "SELECTION_BUSY"
            : "SELECTION_UNAVAILABLE",
      },
      409,
    );
  } finally {
    activeRequests--;
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
  }
}
