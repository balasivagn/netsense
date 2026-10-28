import type { InitResponse, SignedPart, UploadTransport } from "./multipart";

const MAX_JSON_BYTES = 32 * 1024;
const invalid = () => new Error("INVALID_RESPONSE");
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw invalid();
  return value as Record<string, unknown>;
};
const string = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32)
  )
    throw invalid();
  return value;
};
const identifier = (value: unknown) => {
  const result = string(value);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw invalid();
  return result;
};
const integer = (value: unknown) => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 5 * 1024 ** 3
  )
    throw invalid();
  return value;
};
function signedUrl(raw: string): URL {
  if (typeof raw !== "string" || !raw.length || raw.length > 8192)
    throw invalid();
  let url: URL;
  try {
    url = new URL(
      raw,
      typeof location === "undefined" ? undefined : location.href,
    );
  } catch {
    throw invalid();
  }
  if (url.username || url.password || url.hash) throw invalid();
  if (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      typeof location !== "undefined" &&
      url.origin === location.origin)
  )
    return url;
  throw invalid();
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Upload interrupted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) {
        done = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_JSON_BYTES || chunks.length >= MAX_JSON_BYTES)
        throw invalid();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw invalid();
    }
    if (!response.ok) {
      // Only this public code is actionable. Never expose arbitrary server text.
      const code = string(object(value, ["error"]).error);
      throw Error(
        response.status === 409 && code === "CONSENT_REQUIRED"
          ? "CONSENT_REQUIRED"
          : "UPLOAD_REJECTED",
      );
    }
    return value;
  } finally {
    if (!done) await abortable(reader.cancel(), signal).catch(() => undefined);
    reader.releaseLock();
  }
}

/** Deadline includes headers and streamed body; PUTs never inherit credentials. */
export function createUploadTransport(
  fetcher: typeof fetch = fetch,
  options: { timeoutMs?: number; putTimeoutMs?: number } = {},
): UploadTransport {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const putTimeoutMs = options.putTimeoutMs ?? 120_000;
  if (
    ![timeoutMs, putTimeoutMs].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 600_000,
    )
  )
    throw Error("INVALID_TIMEOUT");
  const request = async (
    url: string | URL,
    init: RequestInit,
    parent: AbortSignal,
    timeout: number,
  ) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) abort();
    const timer = setTimeout(abort, timeout);
    try {
      controller.signal.throwIfAborted();
      const response = await abortable(
        fetcher(url, { ...init, redirect: "error", signal: controller.signal }),
        controller.signal,
      );
      const value = await json(response, controller.signal);
      return { response, value };
    } catch (error) {
      if (controller.signal.aborted)
        throw new DOMException("Upload interrupted", "AbortError");
      if (
        error instanceof Error &&
        ["INVALID_RESPONSE", "CONSENT_REQUIRED", "UPLOAD_REJECTED"].includes(
          error.message,
        )
      )
        throw error;
      // Discard raw fetch errors: they can contain signed URLs or server detail.
      // eslint-disable-next-line preserve-caught-error
      throw Error("UPLOAD_REJECTED");
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    }
  };
  const post = async (
    path: string,
    body: unknown,
    signal: AbortSignal,
    keys: string[],
  ) =>
    object(
      (
        await request(
          path,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          signal,
          timeoutMs,
        )
      ).value,
      keys,
    );
  return {
    async initialize(input, signal): Promise<InitResponse> {
      const value = await post("/api/uploads", input, signal, [
        "uploadId",
        "partSize",
        "partCount",
        "resumeFrom",
      ]);
      if (!Array.isArray(value.resumeFrom) || value.resumeFrom.length > 10000)
        throw invalid();
      const partSize = integer(value.partSize),
        partCount = integer(value.partCount);
      const resumeFrom = value.resumeFrom.map(integer);
      if (
        !partSize ||
        partSize > 8 * 1024 ** 2 ||
        !partCount ||
        partCount > 10000 ||
        partCount !== Math.ceil(input.bytesTotal / partSize) ||
        new Set(resumeFrom).size !== resumeFrom.length ||
        resumeFrom.some((n) => n < 1 || n > partCount)
      )
        throw invalid();
      return {
        uploadId: identifier(value.uploadId),
        partSize,
        partCount,
        resumeFrom,
      };
    },
    async signParts(uploadId, partNumbers, signal): Promise<SignedPart[]> {
      const value = await post(
        `/api/uploads/${encodeURIComponent(uploadId)}/parts`,
        { partNumbers },
        signal,
        ["urls"],
      );
      if (
        !Array.isArray(value.urls) ||
        value.urls.length !== partNumbers.length ||
        value.urls.length > 32
      )
        throw invalid();
      const urls = value.urls.map((item) => {
        const entry = object(item, ["partNumber", "url", "expiresAt"]);
        if (typeof entry.url !== "string") throw invalid();
        signedUrl(entry.url);
        if (
          typeof entry.expiresAt !== "number" ||
          !Number.isSafeInteger(entry.expiresAt) ||
          entry.expiresAt <= Date.now() ||
          entry.expiresAt > Date.now() + 24 * 3600_000
        )
          throw invalid();
        return {
          partNumber: integer(entry.partNumber),
          url: entry.url,
          expiresAt: entry.expiresAt,
        };
      });
      if (
        new Set(urls.map((v) => v.partNumber)).size !== urls.length ||
        urls.some((v) => !partNumbers.includes(v.partNumber))
      )
        throw invalid();
      return urls;
    },
    async put(rawUrl, part, mimeType, signal) {
      const { response, value: raw } = await request(
        signedUrl(rawUrl),
        {
          method: "PUT",
          body: part,
          credentials: "omit",
          headers: { "Content-Type": mimeType },
        },
        signal,
        putTimeoutMs,
      );
      const value = object(raw, ["etag", "bytes"]);
      const etag = string(value.etag);
      const responseEtag = response.headers.get("ETag");
      if (
        !responseEtag ||
        responseEtag.replace(/^"|"$/g, "") !== etag.replace(/^"|"$/g, "") ||
        integer(value.bytes) !== part.size
      )
        throw invalid();
      return { etag, bytes: integer(value.bytes) };
    },
    async confirm(uploadId, input, signal) {
      const value = await post(
        `/api/uploads/${encodeURIComponent(uploadId)}/parts/confirm`,
        input,
        signal,
        ["bytesConfirmed"],
      );
      return { bytesConfirmed: integer(value.bytesConfirmed) };
    },
    async complete(uploadId, signal) {
      const value = await post(
        `/api/uploads/${encodeURIComponent(uploadId)}/complete`,
        {},
        signal,
        ["jobId"],
      );
      return { jobId: value.jobId === null ? null : identifier(value.jobId) };
    },
    async abort(uploadId, signal) {
      await post(
        `/api/uploads/${encodeURIComponent(uploadId)}/abort`,
        {},
        signal,
        [],
      );
    },
  };
}
