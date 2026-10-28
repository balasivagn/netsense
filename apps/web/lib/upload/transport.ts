import type { InitResponse, SignedPart, UploadTransport } from "./multipart";

type Fetcher = typeof fetch;
const MAX_JSON_BYTES = 32 * 1024;
class UploadResponseError extends Error {}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UploadResponseError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
};
const string = (value: unknown) => { if (typeof value !== "string") throw new UploadResponseError("INVALID_RESPONSE"); return value; };
const integer = (value: unknown) => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new UploadResponseError("INVALID_RESPONSE"); return value; };
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new UploadResponseError("UPLOAD_REJECTED");
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) throw new UploadResponseError("INVALID_RESPONSE");
  try { return object(JSON.parse(text)); } catch { throw new UploadResponseError("INVALID_RESPONSE"); }
}
function signedUrl(raw: string): URL {
  const url = new URL(raw, typeof location === "undefined" ? undefined : location.href);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && typeof location !== "undefined" && url.origin === location.origin) return url;
  throw new UploadResponseError("INVALID_RESPONSE");
}

/** Same-origin API transport; signed PUTs deliberately omit cookies and auth. */
export function createUploadTransport(fetcher: Fetcher = fetch): UploadTransport {
  const post = async (path: string, body: unknown, signal: AbortSignal) => json(await fetcher(path, { method: "POST", credentials: "same-origin", redirect: "error", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return {
    async initialize(input, signal): Promise<InitResponse> {
      const value = await post("/api/uploads", input, signal);
      if (!Array.isArray(value.resumeFrom)) throw new UploadResponseError("INVALID_RESPONSE");
      return { uploadId: string(value.uploadId), partSize: integer(value.partSize), partCount: integer(value.partCount), resumeFrom: value.resumeFrom.map(integer) };
    },
    async signParts(uploadId, partNumbers, signal): Promise<SignedPart[]> {
      const value = await post(`/api/uploads/${encodeURIComponent(uploadId)}/parts`, { partNumbers }, signal);
      if (!Array.isArray(value.urls)) throw new UploadResponseError("INVALID_RESPONSE");
      return value.urls.map((item) => { const entry = object(item); const url = string(entry.url); signedUrl(url); return { partNumber: integer(entry.partNumber), url, expiresAt: integer(entry.expiresAt) }; });
    },
    async put(rawUrl, part, mimeType, signal) {
      const url = signedUrl(rawUrl);
      const response = await fetcher(url, { method: "PUT", body: part, credentials: "omit", redirect: "error", signal, headers: { "Content-Type": mimeType } });
      const value = await json(response);
      const etag = string(value.etag);
      const responseEtag = response.headers.get("ETag");
      if (!responseEtag || responseEtag.replace(/^"|"$/g, "") !== etag.replace(/^"|"$/g, "")) throw new UploadResponseError("INVALID_RESPONSE");
      return { etag, bytes: integer(value.bytes) };
    },
    async confirm(uploadId, input, signal) { const value = await post(`/api/uploads/${encodeURIComponent(uploadId)}/parts/confirm`, input, signal); return { bytesConfirmed: integer(value.bytesConfirmed) }; },
    async complete(uploadId, signal) { const value = await post(`/api/uploads/${encodeURIComponent(uploadId)}/complete`, {}, signal); if (!(typeof value.jobId === "string" || value.jobId === null)) throw new UploadResponseError("INVALID_RESPONSE"); return { jobId: value.jobId }; },
    async abort(uploadId, signal) { await post(`/api/uploads/${encodeURIComponent(uploadId)}/abort`, {}, signal); },
  };
}
