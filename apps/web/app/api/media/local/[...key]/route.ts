import { Readable } from "node:stream";
import { getVideoStorage, LocalVideoStorage, StorageError } from "../../../../../lib/storage";

export const runtime = "nodejs";

type Context = { params: Promise<{ key: string[] }> };

function failure(error: unknown): Response {
  if (error instanceof StorageError) {
    const headers = error.status === 416 ? { "Content-Range": "bytes */*" } : undefined;
    return new Response(error.message, { status: error.status, headers });
  }
  return new Response("Storage unavailable", { status: 500 });
}

async function local(): Promise<LocalVideoStorage> {
  const storage = getVideoStorage();
  if (!(storage instanceof LocalVideoStorage)) throw new StorageError("LOCAL_STORAGE_DISABLED", 404);
  return storage;
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const key = (await context.params).key.join("/");
    const storage = await local();
    const signed = await storage.verifySignedRequest(request, key);
    const result = await storage.writeSignedPut(request, signed);
    return Response.json({ etag: result.etag, bytes: result.bytes }, { headers: { ETag: result.etag } });
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const key = (await context.params).key.join("/");
    const storage = await local();
    await storage.verifySignedRequest(request, key);
    const result = await storage.openRange(key, request.headers.get("range"));
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Content-Length": String(result.end - result.start + 1),
      "Content-Type": result.contentType ?? "application/octet-stream",
      "Content-Disposition": "inline",
    });
    if (result.partial) headers.set("Content-Range", `bytes ${result.start}-${result.end}/${result.size}`);
    return new Response(Readable.toWeb(result.stream) as ReadableStream, { status: result.partial ? 206 : 200, headers });
  } catch (error) {
    return failure(error);
  }
}
