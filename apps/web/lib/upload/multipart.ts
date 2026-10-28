import { sha256Blob, type HashableBlob } from "./sha256";
import type { UploadRecoveryStore } from "./resume";

export type UploadPhase = "idle" | "hashing" | "uploading" | "paused" | "ready_to_complete" | "completing" | "complete" | "cancelled" | "failed";
export type UploadErrorCode = "UPLOAD_PART_FAILED" | "UPLOAD_CHECKSUM" | "UPLOAD_REJECTED" | "INVALID_RESPONSE" | "CANCELLED";
export type UploadFile = HashableBlob & { readonly size: number; readonly type: string; readonly name?: string };
export type UploadState = Readonly<{ phase: UploadPhase; sha256?: string; uploadId?: string; confirmedBytes: number; bytesTotal: number; confirmedParts: readonly number[]; wholeUploadAttempts: number; error?: UploadErrorCode }>;
export type InitResponse = { uploadId: string; partSize: number; partCount: number; resumeFrom: number[] };
export type SignedPart = { partNumber: number; url: string; expiresAt: number };
export interface UploadTransport {
  initialize(input: { sessionId: string; fileName: string; mimeType: string; bytesTotal: number; sha256: string }, signal: AbortSignal): Promise<InitResponse>;
  signParts(uploadId: string, partNumbers: number[], signal: AbortSignal): Promise<SignedPart[]>;
  put(url: string, part: Blob, mimeType: string, signal: AbortSignal): Promise<{ etag: string; bytes: number }>;
  confirm(uploadId: string, input: { partNumber: number; etag: string; bytes: number }, signal: AbortSignal): Promise<{ bytesConfirmed: number }>;
  complete(uploadId: string, signal: AbortSignal): Promise<{ jobId: string | null }>;
  abort(uploadId: string, signal: AbortSignal): Promise<void>;
}
export type UploadEvent = { type: "state"; state: UploadState } | { type: "hash_progress"; hashedBytes: number; bytesTotal: number } | { type: "complete"; jobId: string | null };

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const safeInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const uniqueParts = (value: unknown, count: number): number[] | null => Array.isArray(value) && value.every((part) => Number.isInteger(part) && part >= 1 && part <= count) ? [...new Set(value)].sort((a, b) => a - b) : null;

/**
 * Browser-only multipart controller. Call start/resume, then call complete only
 * from the UI's explicit continue action. It sends no signed URL to storage.
 */
export class MultipartUploadController {
  private state: UploadState;
  private run = 0;
  private active = new Set<AbortController>();
  private readonly listeners = new Set<(event: UploadEvent) => void>();
  private readonly retries: readonly number[];
  private readonly partConcurrency: number;
  private jobId: string | null | undefined;

  constructor(private readonly options: { coachId: string; sessionId: string; file: UploadFile; transport: UploadTransport; recovery: UploadRecoveryStore; retryDelaysMs?: readonly number[]; partConcurrency?: number; onEvent?: (event: UploadEvent) => void }) {
    this.state = { phase: "idle", confirmedBytes: 0, bytesTotal: options.file.size, confirmedParts: [], wholeUploadAttempts: 0 };
    this.retries = options.retryDelaysMs ?? [2000, 8000, 30000];
    this.partConcurrency = options.partConcurrency ?? 2;
    if (!Number.isInteger(this.partConcurrency) || this.partConcurrency < 1) throw Error("INVALID_CONCURRENCY");
    if (!this.retries.every((delay) => Number.isSafeInteger(delay) && delay >= 0)) throw Error("INVALID_RETRY_DELAYS");
    if (options.onEvent) this.listeners.add(options.onEvent);
  }
  get snapshot() { return this.state; }
  onEvent(listener: (event: UploadEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async start(): Promise<UploadState> { return this.begin(); }
  async resume(): Promise<UploadState> { return this.begin(); }

  pause() {
    if (!["hashing", "uploading", "completing"].includes(this.state.phase)) return;
    this.run++;
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.set({ ...this.state, phase: "paused", error: undefined });
  }
  async cancel(): Promise<void> {
    const uploadId = this.state.uploadId;
    this.run++;
    for (const controller of this.active) controller.abort();
    this.active.clear();
    if (uploadId) {
      const controller = new AbortController();
      try { await this.options.transport.abort(uploadId, controller.signal); } catch (error) { if (!isAbort(error)) throw error; }
    }
    this.options.recovery.clear(this.options.coachId, this.options.sessionId);
    this.set({ ...this.state, phase: "cancelled", error: "CANCELLED" });
  }
  dispose() { this.pause(); this.listeners.clear(); }

  async complete(): Promise<{ jobId: string | null }> {
    if (this.state.phase !== "ready_to_complete" || !this.state.uploadId) throw Error("NOT_READY_TO_COMPLETE");
    const run = ++this.run;
    this.set({ ...this.state, phase: "completing" });
    try {
      const result = await this.call((signal) => this.options.transport.complete(this.state.uploadId!, signal));
      this.current(run);
      this.jobId = result.jobId;
      this.options.recovery.clear(this.options.coachId, this.options.sessionId);
      this.set({ ...this.state, phase: "complete", error: undefined });
      this.emit({ type: "complete", jobId: result.jobId });
      return result;
    } catch (error) {
      if (isAbort(error) || this.run !== run) throw error;
      this.fail(run, "UPLOAD_PART_FAILED");
      return { jobId: null };
    }
  }

  private async begin(): Promise<UploadState> {
    if (["hashing", "uploading", "completing"].includes(this.state.phase)) return this.state;
    if (["cancelled", "complete"].includes(this.state.phase)) throw Error("UPLOAD_TERMINAL");
    if (this.state.phase === "failed" && this.state.wholeUploadAttempts >= 3) return this.state;
    const run = ++this.run;
    this.set({ ...this.state, phase: "hashing", error: undefined });
    try {
      const sha256 = await this.hash(run);
      this.current(run);
      const saved = this.options.recovery.read(this.options.coachId, this.options.sessionId);
      if (saved && (saved.sha256 !== sha256 || saved.bytesTotal !== this.options.file.size || saved.mimeType !== this.options.file.type)) return this.fail(run, "UPLOAD_CHECKSUM");
      const init = await this.call((signal) => this.options.transport.initialize({ sessionId: this.options.sessionId, fileName: this.options.file.name ?? "clip", mimeType: this.options.file.type, bytesTotal: this.options.file.size, sha256 }, signal));
      this.current(run); this.validateInit(init);
      this.options.recovery.write(this.options.coachId, this.options.sessionId, { version: 1, sha256, bytesTotal: this.options.file.size, mimeType: this.options.file.type, uploadId: init.uploadId });
      const confirmed = uniqueParts(init.resumeFrom, init.partCount)!;
      this.set({ ...this.state, phase: "uploading", sha256, uploadId: init.uploadId, confirmedParts: confirmed, confirmedBytes: this.confirmedBytes(confirmed, init.partSize) });
      await this.uploadMissing(run, init);
      this.current(run);
      this.set({ ...this.state, phase: "ready_to_complete", error: undefined });
      return this.state;
    } catch (error) { return this.handleFailure(run, error, this.state); }
  }
  private async hash(run: number) {
    return this.call((signal) => sha256Blob(this.options.file, { signal, onProgress: (hashedBytes) => { if (this.run === run) this.emit({ type: "hash_progress", hashedBytes, bytesTotal: this.options.file.size }); } }));
  }
  private async uploadMissing(run: number, init: InitResponse) {
    const confirmed = new Set(this.state.confirmedParts);
    const missing = Array.from({ length: init.partCount }, (_, index) => index + 1).filter((part) => !confirmed.has(part));
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        this.current(run);
        const partNumber = missing[cursor++];
        await this.uploadPart(run, init, partNumber);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.partConcurrency, missing.length) }, worker));
  }
  private async uploadPart(run: number, init: InitResponse, partNumber: number) {
    const start = (partNumber - 1) * init.partSize;
    const part = this.options.file.slice(start, Math.min(this.options.file.size, start + init.partSize));
    for (let attempt = 0; ; attempt++) {
      try {
        const signed = await this.call((signal) => this.options.transport.signParts(init.uploadId, [partNumber], signal));
        this.current(run);
        if (signed.length !== 1 || !this.validSigned(signed[0], partNumber)) throw Error("INVALID_RESPONSE");
        const uploaded = await this.call((signal) => this.options.transport.put(signed[0].url, part, this.options.file.type, signal));
        if (!safeInteger(uploaded.bytes) || uploaded.bytes !== part.size || !this.validEtag(uploaded.etag)) throw Error("INVALID_RESPONSE");
        const confirmed = await this.call((signal) => this.options.transport.confirm(init.uploadId, { partNumber, ...uploaded }, signal));
        if (!safeInteger(confirmed.bytesConfirmed) || confirmed.bytesConfirmed !== uploaded.bytes) throw Error("INVALID_RESPONSE");
        this.current(run);
        const parts = [...new Set([...this.state.confirmedParts, partNumber])].sort((a, b) => a - b);
        this.set({ ...this.state, confirmedParts: parts, confirmedBytes: this.confirmedBytes(parts, init.partSize) });
        return;
      } catch (error) {
        if (isAbort(error)) throw error;
        if (attempt >= this.retries.length) throw error;
        await this.wait(this.retries[attempt], run);
      }
    }
  }
  private confirmedBytes(parts: readonly number[], partSize: number) { return parts.reduce((total, part) => total + Math.min(partSize, this.options.file.size - (part - 1) * partSize), 0); }
  private validateInit(value: InitResponse) { if (!value || typeof value.uploadId !== "string" || !value.uploadId || !safeInteger(value.partSize) || value.partSize < 1 || !safeInteger(value.partCount) || value.partCount < 1 || uniqueParts(value.resumeFrom, value.partCount) === null) throw Error("INVALID_RESPONSE"); }
  private validSigned(value: SignedPart, partNumber: number) { try { const url = new URL(value.url, typeof location === "undefined" ? undefined : location.href); return value.partNumber === partNumber && typeof value.expiresAt === "number" && value.expiresAt > Date.now() && (url.protocol === "https:" || (url.protocol === "http:" && typeof location !== "undefined" && url.origin === location.origin)); } catch { return false; } }
  private validEtag(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }
  private async wait(delay: number, run: number) { await this.call((signal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, delay); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Upload paused", "AbortError")); }, { once: true }); })).then(() => this.current(run)); }
  private async call<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> { const controller = new AbortController(); this.active.add(controller); try { return await operation(controller.signal); } finally { this.active.delete(controller); } }
  private current(run: number) { if (this.run !== run) throw new DOMException("Stale upload completion", "AbortError"); }
  private handleFailure<T>(run: number, error: unknown, fallback: T): T { if (isAbort(error) || this.run !== run) return fallback; return this.fail(run, error instanceof Error && error.message === "INVALID_RESPONSE" ? "INVALID_RESPONSE" : "UPLOAD_PART_FAILED") as T; }
  private fail(run: number, error: UploadErrorCode): UploadState { if (this.run === run) this.set({ ...this.state, phase: "failed", wholeUploadAttempts: this.state.wholeUploadAttempts + 1, error }); return this.state; }
  private set(state: UploadState) { this.state = Object.freeze(state); this.emit({ type: "state", state: this.state }); }
  private emit(event: UploadEvent) { for (const listener of this.listeners) listener(event); }
}
