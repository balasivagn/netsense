import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { VideoStorage } from "./types";

const MAX_TTL_SECONDS = 3600;
const SESSION_PREFIX = "sessions/";
// SPEC §5 has one web process. Share locks between adapter instances (routes
// construct a fresh adapter); a multi-process local deployment is unsupported.
const mutations = new Map<string, Promise<void>>();
type Part = { partNumber: number; etag: string };
type MediaRange = {
  stream: ReturnType<typeof createReadStream>;
  start: number;
  end: number;
  size: number;
  contentType?: string;
  partial: boolean;
};

type UploadState = {
  key: string;
  contentType: string;
  status: "in_progress" | "complete" | "aborted";
  completedParts?: Part[];
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
  constructor(
    message: string,
    readonly status = 400,
    readonly resourceBytes?: number,
  ) {
    super(message);
  }
}

function validKey(key: string): string[] {
  if (
    !key.startsWith(SESSION_PREFIX) ||
    key.includes("%") ||
    key.includes("\\") ||
    Array.from(key).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
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
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      uploadId,
    )
  )
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
    if (!options.rootDir)
      throw new StorageError("LOCAL_STORAGE_DIR_REQUIRED", 500);
    if (!options.signingSecret)
      throw new StorageError("MEDIA_URL_SIGNING_SECRET_REQUIRED", 500);
    this.rootDir = path.resolve(options.rootDir);
    this.secret = Buffer.from(options.signingSecret);
    this.baseUrl = (options.baseUrl ?? "http://localhost:3000").replace(
      /\/$/,
      "",
    );
    this.now = options.now ?? Date.now;
  }

  private async mutate<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pieces = validKey(key);
    const lock = `${this.rootDir}/${pieces.slice(0, 2).join("/")}`;
    const previous = mutations.get(lock) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    mutations.set(lock, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (mutations.get(lock) === current) mutations.delete(lock);
    }
  }

  private async target(key: string): Promise<string> {
    const pieces = validKey(key);
    await mkdir(this.rootDir, { recursive: true });
    const rootStat = await lstat(this.rootDir);
    if (rootStat.isSymbolicLink())
      throw new StorageError("STORAGE_SYMLINK_ESCAPE", 403);
    let current = this.rootDir;
    for (const piece of pieces) {
      current = path.join(current, piece);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new StorageError("STORAGE_SYMLINK_ESCAPE", 403);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const target = path.resolve(this.rootDir, ...pieces);
    if (!target.startsWith(`${this.rootDir}${path.sep}`))
      throw new StorageError("INVALID_STORAGE_KEY");
    return target;
  }

  private partsRoot(key: string): string {
    return `${key}.parts`;
  }

  private async statePath(key: string, uploadId: string): Promise<string> {
    validUploadId(uploadId);
    return this.target(`${this.partsRoot(key)}/${uploadId}.json`);
  }

  private async partPath(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    validUploadId(uploadId);
    validPartNumber(partNumber);
    return this.target(`${this.partsRoot(key)}/${uploadId}/${partNumber}`);
  }

  private async readState(key: string, uploadId: string): Promise<UploadState> {
    const statePath = await this.statePath(key, uploadId);
    try {
      const state = JSON.parse(
        await readFile(statePath, "utf8"),
      ) as UploadState;
      if (
        state.key !== key ||
        !state.contentType ||
        !["in_progress", "complete", "aborted"].includes(state.status)
      )
        throw new StorageError("INVALID_UPLOAD_STATE");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new StorageError("UNKNOWN_UPLOAD", 404);
      throw error;
    }
  }

  private async saveState(
    key: string,
    uploadId: string,
    state: UploadState,
  ): Promise<void> {
    const target = await this.statePath(key, uploadId);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, target);
  }

  private signature(request: SignedMediaRequest): string {
    return createHmac("sha256", this.secret)
      .update(
        [
          request.method,
          request.key,
          request.exp,
          request.contentType ?? "",
          request.uploadId ?? "",
          request.partNumber ?? "",
        ].join("\n"),
      )
      .digest("base64url");
  }

  private signedUrl(request: SignedMediaRequest): string {
    const query = new URLSearchParams({
      exp: String(request.exp),
      sig: this.signature(request),
    });
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

  async initMultipart(
    key: string,
    contentType: string,
  ): Promise<{ uploadId: string }> {
    return this.mutate(key, () => this.initUnlocked(key, contentType));
  }

  private async initUnlocked(
    key: string,
    contentType: string,
  ): Promise<{ uploadId: string }> {
    if (!contentType || contentType.length > 200 || /[\r\n]/.test(contentType))
      throw new StorageError("INVALID_CONTENT_TYPE");
    const object = await this.target(key);
    try {
      await stat(object);
      throw new StorageError("OBJECT_ALREADY_EXISTS", 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const uploadId = randomUUID();
    await this.saveState(key, uploadId, {
      key,
      contentType,
      status: "in_progress",
    });
    await mkdir(path.dirname(await this.partPath(key, uploadId, 1)), {
      recursive: true,
    });
    return { uploadId };
  }

  async signPartUrls(
    key: string,
    uploadId: string,
    partNumbers: number[],
    ttlS: number,
  ) {
    const state = await this.readState(key, uploadId);
    if (state.status !== "in_progress")
      throw new StorageError("INVALID_UPLOAD_STATE", 409);
    if (!partNumbers.length || new Set(partNumbers).size !== partNumbers.length)
      throw new StorageError("INVALID_PART_NUMBERS");
    const exp = this.expiry(ttlS);
    return partNumbers.map((partNumber) => {
      validPartNumber(partNumber);
      return {
        partNumber,
        url: this.signedUrl({
          method: "PUT",
          key,
          exp,
          contentType: state.contentType,
          uploadId,
          partNumber,
        }),
        expiresAt: exp * 1000,
      };
    });
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    return this.mutate(key, () => this.completeUnlocked(key, uploadId, parts));
  }

  private async completeUnlocked(
    key: string,
    uploadId: string,
    parts: Part[],
  ): Promise<void> {
    const state = await this.readState(key, uploadId);
    if (
      state.status === "aborted" ||
      !parts.length ||
      new Set(parts.map((part) => part.partNumber)).size !== parts.length
    )
      throw new StorageError("INVALID_UPLOAD_STATE", 409);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    for (const [index, part] of ordered.entries()) {
      validPartNumber(part.partNumber);
      if (part.partNumber !== index + 1)
        throw new StorageError("MISSING_PART", 409);
      if (!/^[a-f0-9]{64}$/.test(part.etag))
        throw new StorageError("PART_ETAG_MISMATCH", 409);
    }
    if (state.status === "complete") {
      if (JSON.stringify(state.completedParts) !== JSON.stringify(ordered))
        throw new StorageError("COMPLETION_CONFLICT", 409);
      if (!(await this.head(key)))
        throw new StorageError("OBJECT_NOT_FOUND", 404);
      return;
    }
    for (const part of ordered) {
      const actual = await this.partEtag(key, uploadId, part.partNumber);
      if (!timingSafeEqual(Buffer.from(actual), Buffer.from(part.etag)))
        throw new StorageError("PART_ETAG_MISMATCH", 409);
    }
    const object = await this.target(key);
    await mkdir(path.dirname(object), { recursive: true });
    const temporary = `${object}.${randomUUID()}.assembling`;
    try {
      const destination = await open(temporary, "wx", 0o600);
      try {
        for (const part of ordered) {
          for await (const chunk of createReadStream(
            await this.partPath(key, uploadId, part.partNumber),
          )) {
            await destination.writeFile(chunk as Buffer);
          }
        }
        await destination.sync();
      } finally {
        await destination.close();
      }
      try {
        await link(temporary, object);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new StorageError("OBJECT_ALREADY_EXISTS", 409);
      }
      await this.saveState(key, uploadId, {
        ...state,
        status: "complete",
        completedParts: ordered,
      });
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    return this.mutate(key, () => this.abortUnlocked(key, uploadId));
  }

  private async abortUnlocked(key: string, uploadId: string): Promise<void> {
    const state = await this.readState(key, uploadId);
    if (state.status === "complete")
      throw new StorageError("INVALID_UPLOAD_STATE", 409);
    const parts = await this.target(`${this.partsRoot(key)}/${uploadId}`);
    await rm(parts, { recursive: true, force: true });
    await this.saveState(key, uploadId, { ...state, status: "aborted" });
  }

  async head(
    key: string,
  ): Promise<{ bytes: number; contentType?: string } | null> {
    const object = await this.target(key);
    try {
      const metadata = await stat(object);
      if (!metadata.isFile()) return null;
      return {
        bytes: metadata.size,
        contentType: await this.contentTypeFor(key),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async signGetUrl(
    key: string,
    ttlS: number,
    opts?: { contentDisposition?: "inline" },
  ): Promise<string> {
    void opts;
    if (!(await this.head(key)))
      throw new StorageError("OBJECT_NOT_FOUND", 404);
    return this.signedUrl({ method: "GET", key, exp: this.expiry(ttlS) });
  }

  async signPutUrl(
    key: string,
    contentType: string,
    ttlS: number,
  ): Promise<string> {
    if (!contentType || /[\r\n]/.test(contentType))
      throw new StorageError("INVALID_CONTENT_TYPE");
    await this.target(key);
    return this.signedUrl({
      method: "PUT",
      key,
      contentType,
      exp: this.expiry(ttlS),
    });
  }

  async delete(keyOrPrefix: string): Promise<void> {
    const key = keyOrPrefix.replace(/\/$/, "");
    return this.mutate(key, async () => {
      const target = await this.target(key);
      const parts = await this.target(`${key}.parts`);
      await rm(target, { recursive: true, force: true });
      await rm(parts, { recursive: true, force: true });
    });
  }

  async verifySignedRequest(
    request: Request,
    key: string,
  ): Promise<SignedMediaRequest> {
    const url = new URL(request.url);
    const method = request.method as "GET" | "PUT";
    if (method !== "GET" && method !== "PUT")
      throw new StorageError("INVALID_METHOD", 405);
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig");
    const uploadId = url.searchParams.get("uploadId") ?? undefined;
    const rawPart = url.searchParams.get("partNumber");
    const partNumber = rawPart === null ? undefined : Number(rawPart);
    const contentType = url.searchParams.has("ct")
      ? decode(url.searchParams.get("ct")!)
      : undefined;
    if (
      !Number.isSafeInteger(exp) ||
      !sig ||
      exp <= Math.floor(this.now() / 1000) ||
      (uploadId === undefined) !== (partNumber === undefined)
    )
      throw new StorageError("INVALID_SIGNATURE", 403);
    if (
      method === "PUT" &&
      (!contentType || request.headers.get("content-type") !== contentType)
    )
      throw new StorageError("INVALID_CONTENT_TYPE", 403);
    if (partNumber !== undefined) validPartNumber(partNumber);
    if (uploadId) validUploadId(uploadId);
    const signed = { method, key, exp, contentType, uploadId, partNumber };
    const expected = Buffer.from(this.signature(signed));
    const supplied = Buffer.from(sig);
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw new StorageError("INVALID_SIGNATURE", 403);
    await this.target(key);
    return signed;
  }

  async writeSignedPut(
    request: Request,
    signed: SignedMediaRequest,
  ): Promise<{ etag: string; bytes: number }> {
    return this.mutate(signed.key, () => this.writeUnlocked(request, signed));
  }

  private async writeUnlocked(
    request: Request,
    signed: SignedMediaRequest,
  ): Promise<{ etag: string; bytes: number }> {
    if (!request.body) throw new StorageError("EMPTY_BODY");
    const target =
      signed.uploadId && signed.partNumber
        ? await this.partPath(signed.key, signed.uploadId, signed.partNumber)
        : await this.target(signed.key);
    if (signed.uploadId) {
      const state = await this.readState(signed.key, signed.uploadId);
      if (
        state.status !== "in_progress" ||
        state.contentType !== signed.contentType
      )
        throw new StorageError("INVALID_UPLOAD_STATE", 409);
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.uploading`;
    const hash = createHash("sha256");
    let bytes = 0;
    const writable = await open(temporary, "wx", 0o600);
    const reader = request.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        hash.update(next.value);
        await writable.writeFile(next.value);
      }
      await writable.sync();
      await writable.close();
      const etag = hash.digest("hex");
      if (signed.uploadId) {
        // Confirmed bytes are immutable. Only byte-identical part retries succeed.
        try {
          await link(temporary, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (
            (await this.partEtag(
              signed.key,
              signed.uploadId,
              signed.partNumber!,
            )) !== etag
          )
            throw new StorageError("PART_CONFLICT", 409);
        }
      } else {
        // Direct PUT matches object-storage replacement semantics. Worker retries
        // and final renders may replace an existing derivative at the same key.
        // Multipart source parts/completion still use immutable create-only links.
        await rename(temporary, target);
        const metadata = await this.target(
          `${this.partsRoot(signed.key)}/object.json`,
        );
        await mkdir(path.dirname(metadata), { recursive: true });
        await writeFile(
          metadata,
          JSON.stringify({
            key: signed.key,
            contentType: signed.contentType,
            status: "complete",
          }),
          { mode: 0o600 },
        );
      }
      return { etag, bytes };
    } finally {
      await writable.close();
      reader.releaseLock();
      await rm(temporary, { force: true });
    }
  }

  async partEtag(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new StorageError("MISSING_PART", 409);
      throw error;
    }
  }

  private async contentTypeFor(key: string): Promise<string | undefined> {
    const dir = await this.target(this.partsRoot(key));
    try {
      const names = await readdir(dir);
      // A direct PUT supersedes a prior multipart object's content type.
      names.sort(
        (a, b) => Number(b === "object.json") - Number(a === "object.json"),
      );
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const state = JSON.parse(
          await readFile(
            await this.target(`${this.partsRoot(key)}/${name}`),
            "utf8",
          ),
        ) as UploadState;
        if (state.status === "complete") return state.contentType;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
  }

  async openRange(
    key: string,
    rangeHeader: string | null,
  ): Promise<MediaRange> {
    // Snapshot the opened inode, length and type while writers hold the same
    // lock. A later replacement cannot truncate or change this response's bytes.
    return this.mutate(key, () => this.openRangeUnlocked(key, rangeHeader));
  }

  private async openRangeUnlocked(
    key: string,
    rangeHeader: string | null,
  ): Promise<MediaRange> {
    const object = await this.target(key);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(object, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new StorageError("OBJECT_NOT_FOUND", 404);
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new StorageError("OBJECT_NOT_FOUND", 404);
      const size = metadata.size;
      let start = 0,
        end = Math.max(0, size - 1),
        partial = false;
      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match || (!match[1] && !match[2]))
          throw new StorageError("RANGE_NOT_SATISFIABLE", 416, size);
        partial = true;
        if (!match[1]) {
          const length = Number(match[2]);
          if (!Number.isSafeInteger(length) || length < 1)
            throw new StorageError("RANGE_NOT_SATISFIABLE", 416, size);
          start = Math.max(0, size - length);
        } else {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : end;
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start >= size ||
          end < start
        )
          throw new StorageError("RANGE_NOT_SATISFIABLE", 416, size);
        end = Math.min(end, size - 1);
      }
      const contentType = await this.contentTypeFor(key);
      return {
        stream: handle.createReadStream({ start, end }),
        start,
        end,
        size,
        contentType,
        partial,
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
