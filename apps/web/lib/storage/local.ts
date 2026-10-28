import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { VideoStorage } from "./types";

const MAX_TTL_SECONDS = 3600;
const SESSION_PREFIX = "sessions/";

type UploadState = {
  key: string;
  contentType: string;
  status: "in_progress" | "complete" | "aborted";
};

export type SignedMediaRequest = {
  method: "GET" | "PUT";
  key: string;
  exp: number;
  contentType?: string;
  uploadId?: string;
  partNumber?: number;
};

export type LocalStorageOptions = {
  rootDir: string;
  signingSecret: string;
  baseUrl?: string;
  now?: () => number;
};

export class StorageError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function validKey(key: string): string[] {
  if (!key.startsWith(SESSION_PREFIX) || key.includes("%") || key.includes("\\") || key.includes("\0"))
    throw new StorageError("INVALID_STORAGE_KEY");
  const pieces = key.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === ".."))
    throw new StorageError("INVALID_STORAGE_KEY");
  return pieces;
}

function validPartNumber(partNumber: number): void {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1)
    throw new StorageError("INVALID_PART_NUMBER");
}

function validUploadId(uploadId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId))
    throw new StorageError("INVALID_UPLOAD_ID");
}

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new StorageError("INVALID_SIGNATURE", 403);
  }
}

export class LocalVideoStorage implements VideoStorage {
  readonly driver = "local" as const;
  private readonly rootDir: string;
  private readonly secret: Buffer;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(options: LocalStorageOptions) {
    if (!options.rootDir) throw new StorageError("LOCAL_STORAGE_DIR_REQUIRED", 500);
    if (!options.signingSecret) throw new StorageError("MEDIA_URL_SIGNING_SECRET_REQUIRED", 500);
    this.rootDir = path.resolve(options.rootDir);
    this.secret = Buffer.from(options.signingSecret);
    this.baseUrl = (options.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
    this.now = options.now ?? Date.now;
  }

  private async target(key: string): Promise<string> {
    const pieces = validKey(key);
    await mkdir(this.rootDir, { recursive: true });
    const rootStat = await lstat(this.rootDir);
    if (rootStat.isSymbolicLink()) throw new StorageError("STORAGE_SYMLINK_ESCAPE", 403);
    let current = this.rootDir;
    for (const piece of pieces) {
      current = path.join(current, piece);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new StorageError("STORAGE_SYMLINK_ESCAPE", 403);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const target = path.resolve(this.rootDir, ...pieces);
    if (!target.startsWith(`${this.rootDir}${path.sep}`)) throw new StorageError("INVALID_STORAGE_KEY");
    return target;
  }

  private partsRoot(key: string): string {
    return `${key}.parts`;
  }

  private async statePath(key: string, uploadId: string): Promise<string> {
    validUploadId(uploadId);
    return this.target(`${this.partsRoot(key)}/${uploadId}.json`);
  }

  private async partPath(key: string, uploadId: string, partNumber: number): Promise<string> {
    validUploadId(uploadId);
    validPartNumber(partNumber);
    return this.target(`${this.partsRoot(key)}/${uploadId}/${partNumber}`);
  }

  private async readState(key: string, uploadId: string): Promise<UploadState> {
    const statePath = await this.statePath(key, uploadId);
    try {
      const state = JSON.parse(await readFile(statePath, "utf8")) as UploadState;
      if (state.key !== key || !state.contentType || !["in_progress", "complete", "aborted"].includes(state.status))
        throw new StorageError("INVALID_UPLOAD_STATE");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StorageError("UNKNOWN_UPLOAD", 404);
      throw error;
    }
  }

  private async saveState(key: string, uploadId: string, state: UploadState): Promise<void> {
    const target = await this.statePath(key, uploadId);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, target);
  }

  private signature(request: SignedMediaRequest): string {
    return createHmac("sha256", this.secret)
      .update([request.method, request.key, request.exp, request.contentType ?? "", request.uploadId ?? "", request.partNumber ?? ""].join("\n"))
      .digest("base64url");
  }

  private signedUrl(request: SignedMediaRequest): string {
    const query = new URLSearchParams({ exp: String(request.exp), sig: this.signature(request) });
    if (request.contentType) query.set("ct", encode(request.contentType));
    if (request.uploadId) query.set("uploadId", request.uploadId);
    if (request.partNumber) query.set("partNumber", String(request.partNumber));
    return `${this.baseUrl}/api/media/local/${request.key.split("/").map(encodeURIComponent).join("/")}?${query}`;
  }

  private expiry(ttlS: number): number {
    if (!Number.isSafeInteger(ttlS) || ttlS < 1 || ttlS > MAX_TTL_SECONDS)
      throw new StorageError("INVALID_SIGNED_URL_TTL");
    return Math.floor(this.now() / 1000) + ttlS;
  }

  async initMultipart(key: string, contentType: string): Promise<{ uploadId: string }> {
    if (!contentType || contentType.length > 200 || /[\r\n]/.test(contentType)) throw new StorageError("INVALID_CONTENT_TYPE");
    const object = await this.target(key);
    try {
      await stat(object);
      throw new StorageError("OBJECT_ALREADY_EXISTS", 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const uploadId = randomUUID();
    await this.saveState(key, uploadId, { key, contentType, status: "in_progress" });
    await mkdir(path.dirname(await this.partPath(key, uploadId, 1)), { recursive: true });
    return { uploadId };
  }

  async signPartUrls(key: string, uploadId: string, partNumbers: number[], ttlS: number) {
    const state = await this.readState(key, uploadId);
    if (state.status !== "in_progress") throw new StorageError("INVALID_UPLOAD_STATE", 409);
    if (!partNumbers.length || new Set(partNumbers).size !== partNumbers.length) throw new StorageError("INVALID_PART_NUMBERS");
    const exp = this.expiry(ttlS);
    return partNumbers.map((partNumber) => {
      validPartNumber(partNumber);
      return { partNumber, url: this.signedUrl({ method: "PUT", key, exp, contentType: state.contentType, uploadId, partNumber }), expiresAt: exp * 1000 };
    });
  }

  async completeMultipart(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const state = await this.readState(key, uploadId);
    if (state.status === "complete") return;
    if (state.status !== "in_progress" || !parts.length || new Set(parts.map((part) => part.partNumber)).size !== parts.length)
      throw new StorageError("INVALID_UPLOAD_STATE", 409);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    for (const part of ordered) {
      validPartNumber(part.partNumber);
      const actual = await this.partEtag(key, uploadId, part.partNumber);
      if (!timingSafeEqual(Buffer.from(actual), Buffer.from(part.etag))) throw new StorageError("PART_ETAG_MISMATCH", 409);
    }
    const object = await this.target(key);
    await mkdir(path.dirname(object), { recursive: true });
    const temporary = `${object}.${uploadId}.assembling`;
    try {
      const destination = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      for (const part of ordered) await pipeline(createReadStream(await this.partPath(key, uploadId, part.partNumber)), destination, { end: false });
      destination.end();
      await new Promise<void>((resolve, reject) => destination.once("finish", resolve).once("error", reject));
      try {
        await link(temporary, object);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new StorageError("OBJECT_ALREADY_EXISTS", 409);
      }
      await this.saveState(key, uploadId, { ...state, status: "complete" });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const state = await this.readState(key, uploadId);
    if (state.status === "complete") throw new StorageError("INVALID_UPLOAD_STATE", 409);
    const parts = await this.target(`${this.partsRoot(key)}/${uploadId}`);
    await rm(parts, { recursive: true, force: true });
    await this.saveState(key, uploadId, { ...state, status: "aborted" });
  }

  async head(key: string): Promise<{ bytes: number; contentType?: string } | null> {
    const object = await this.target(key);
    try {
      const metadata = await stat(object);
      if (!metadata.isFile()) return null;
      return { bytes: metadata.size, contentType: await this.contentTypeFor(key) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async signGetUrl(key: string, ttlS: number, opts?: { contentDisposition?: "inline" }): Promise<string> {
    void opts;
    if (!(await this.head(key))) throw new StorageError("OBJECT_NOT_FOUND", 404);
    return this.signedUrl({ method: "GET", key, exp: this.expiry(ttlS) });
  }

  async signPutUrl(key: string, contentType: string, ttlS: number): Promise<string> {
    if (!contentType || /[\r\n]/.test(contentType)) throw new StorageError("INVALID_CONTENT_TYPE");
    await this.target(key);
    return this.signedUrl({ method: "PUT", key, contentType, exp: this.expiry(ttlS) });
  }

  async delete(keyOrPrefix: string): Promise<void> {
    const target = await this.target(keyOrPrefix.replace(/\/$/, ""));
    await rm(target, { recursive: true, force: true });
    await rm(`${target}.parts`, { recursive: true, force: true });
  }

  async verifySignedRequest(request: Request, key: string): Promise<SignedMediaRequest> {
    const url = new URL(request.url);
    const method = request.method as "GET" | "PUT";
    if (method !== "GET" && method !== "PUT") throw new StorageError("INVALID_METHOD", 405);
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig");
    const uploadId = url.searchParams.get("uploadId") ?? undefined;
    const rawPart = url.searchParams.get("partNumber");
    const partNumber = rawPart === null ? undefined : Number(rawPart);
    const contentType = url.searchParams.has("ct") ? decode(url.searchParams.get("ct")!) : undefined;
    if (!Number.isSafeInteger(exp) || !sig || exp < Math.floor(this.now() / 1000) || (uploadId === undefined) !== (partNumber === undefined))
      throw new StorageError("INVALID_SIGNATURE", 403);
    if (method === "PUT" && (!contentType || request.headers.get("content-type") !== contentType))
      throw new StorageError("INVALID_CONTENT_TYPE", 403);
    if (partNumber !== undefined) validPartNumber(partNumber);
    if (uploadId) validUploadId(uploadId);
    const signed = { method, key, exp, contentType, uploadId, partNumber };
    const expected = Buffer.from(this.signature(signed));
    const supplied = Buffer.from(sig);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new StorageError("INVALID_SIGNATURE", 403);
    await this.target(key);
    return signed;
  }

  async writeSignedPut(request: Request, signed: SignedMediaRequest): Promise<{ etag: string; bytes: number }> {
    if (!request.body) throw new StorageError("EMPTY_BODY");
    const target = signed.uploadId && signed.partNumber
      ? await this.partPath(signed.key, signed.uploadId, signed.partNumber)
      : await this.target(signed.key);
    if (signed.uploadId) {
      const state = await this.readState(signed.key, signed.uploadId);
      if (state.status !== "in_progress" || state.contentType !== signed.contentType) throw new StorageError("INVALID_UPLOAD_STATE", 409);
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.uploading`;
    const hash = createHash("sha256");
    let bytes = 0;
    const writable = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    const reader = request.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        hash.update(next.value);
        if (!writable.write(next.value)) await new Promise<void>((resolve, reject) => writable.once("drain", resolve).once("error", reject));
      }
      writable.end();
      await new Promise<void>((resolve, reject) => writable.once("finish", resolve).once("error", reject));
      if (signed.uploadId) {
        // A retry may replace only its own upload's part; final objects never overwrite.
        await rename(temporary, target);
      } else {
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new StorageError("OBJECT_ALREADY_EXISTS", 409);
          throw error;
        }
      }
      return { etag: hash.digest("hex"), bytes };
    } catch (error) {
      writable.destroy();
      throw error;
    } finally {
      reader.releaseLock();
      await rm(temporary, { force: true });
    }
  }

  async partEtag(key: string, uploadId: string, partNumber: number): Promise<string> {
    const file = await this.partPath(key, uploadId, partNumber);
    try {
      const handle = await open(file, "r");
      try {
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream()) hash.update(chunk);
        return hash.digest("hex");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StorageError("MISSING_PART", 409);
      throw error;
    }
  }

  private async contentTypeFor(key: string): Promise<string | undefined> {
    const dir = await this.target(this.partsRoot(key));
    try {
      for (const name of await readdir(dir)) {
        if (!name.endsWith(".json")) continue;
        const state = JSON.parse(await readFile(path.join(dir, name), "utf8")) as UploadState;
        if (state.status === "complete") return state.contentType;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
  }

  async openRange(key: string, rangeHeader: string | null): Promise<{ stream: ReturnType<typeof createReadStream>; start: number; end: number; size: number; contentType?: string; partial: boolean }> {
    const object = await this.target(key);
    let size: number;
    try { size = (await stat(object)).size; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StorageError("OBJECT_NOT_FOUND", 404);
      throw error;
    }
    let start = 0, end = Math.max(0, size - 1), partial = false;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match || (!match[1] && !match[2])) throw new StorageError("RANGE_NOT_SATISFIABLE", 416);
      partial = true;
      if (!match[1]) {
        const length = Number(match[2]);
        if (!Number.isSafeInteger(length) || length < 1) throw new StorageError("RANGE_NOT_SATISFIABLE", 416);
        start = Math.max(0, size - length);
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start)
        throw new StorageError("RANGE_NOT_SATISFIABLE", 416);
      end = Math.min(end, size - 1);
    }
    return { stream: createReadStream(object, { start, end }), start, end, size, contentType: await this.contentTypeFor(key), partial };
  }
}
