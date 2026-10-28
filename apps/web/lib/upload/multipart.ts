import { sha256Blob, type HashableBlob } from "./sha256";
import type { UploadRecoveryStore } from "./resume";

export type UploadPhase =
  | "idle"
  | "hashing"
  | "uploading"
  | "paused"
  | "ready_to_complete"
  | "completing"
  | "complete"
  | "cancelled"
  | "cancelling"
  | "cancel_failed"
  | "disposed"
  | "failed";
export type UploadErrorCode =
  | "UPLOAD_PART_FAILED"
  | "UPLOAD_CHECKSUM"
  | "UPLOAD_REJECTED"
  | "INVALID_RESPONSE"
  | "CANCELLED"
  | "CONSENT_REQUIRED";
export type UploadFile = HashableBlob & {
  readonly size: number;
  readonly type: string;
  readonly name?: string;
};
export type UploadState = Readonly<{
  phase: UploadPhase;
  sha256?: string;
  uploadId?: string;
  confirmedBytes: number;
  bytesTotal: number;
  confirmedParts: readonly number[];
  wholeUploadAttempts: number;
  error?: UploadErrorCode;
}>;
export type InitResponse = {
  uploadId: string;
  partSize: number;
  partCount: number;
  resumeFrom: number[];
};
export type SignedPart = { partNumber: number; url: string; expiresAt: number };
export interface UploadTransport {
  initialize(
    input: {
      sessionId: string;
      fileName: string;
      mimeType: string;
      bytesTotal: number;
      sha256: string;
    },
    signal: AbortSignal,
  ): Promise<InitResponse>;
  signParts(
    uploadId: string,
    partNumbers: number[],
    signal: AbortSignal,
  ): Promise<SignedPart[]>;
  put(
    url: string,
    part: Blob,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<{ etag: string; bytes: number }>;
  confirm(
    uploadId: string,
    input: { partNumber: number; etag: string; bytes: number },
    signal: AbortSignal,
  ): Promise<{ bytesConfirmed: number }>;
  complete(
    uploadId: string,
    signal: AbortSignal,
  ): Promise<{ jobId: string | null }>;
  abort(uploadId: string, signal: AbortSignal): Promise<void>;
}
export type UploadEvent =
  | { type: "state"; state: UploadState }
  | { type: "hash_progress"; hashedBytes: number; bytesTotal: number }
  | { type: "complete"; jobId: string | null };

const safeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const uniqueParts = (value: unknown, count: number): number[] | null =>
  Array.isArray(value) &&
  value.length <= count &&
  new Set(value).size === value.length &&
  value.every((part) => Number.isInteger(part) && part >= 1 && part <= count)
    ? [...new Set(value)].sort((a, b) => a - b)
    : null;

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
  private cancellation?: Promise<void>;
  private source?: Parameters<UploadTransport["initialize"]>[0];

  constructor(
    private readonly options: {
      coachId: string;
      sessionId: string;
      file: UploadFile;
      transport: UploadTransport;
      recovery: UploadRecoveryStore;
      retryDelaysMs?: readonly number[];
      partConcurrency?: number;
      onEvent?: (event: UploadEvent) => void;
    },
  ) {
    if (
      !options.file ||
      !Number.isSafeInteger(options.file.size) ||
      options.file.size < 1 ||
      options.file.size > 2 * 1024 ** 3 ||
      typeof options.file.slice !== "function" ||
      !["video/mp4", "video/webm", "video/quicktime"].includes(
        options.file.type,
      ) ||
      (options.file.name !== undefined &&
        (typeof options.file.name !== "string" ||
          !options.file.name.length ||
          options.file.name.length > 1024))
    )
      throw Error("INVALID_FILE");
    this.state = Object.freeze({
      phase: "idle",
      confirmedBytes: 0,
      bytesTotal: options.file.size,
      confirmedParts: Object.freeze([]),
      wholeUploadAttempts: 0,
    });
    this.retries = Object.freeze([
      ...(options.retryDelaysMs ?? [2000, 8000, 30000]),
    ]);
    this.partConcurrency = options.partConcurrency ?? 2;
    if (
      !Number.isInteger(this.partConcurrency) ||
      this.partConcurrency < 1 ||
      this.partConcurrency > 32
    )
      throw Error("INVALID_CONCURRENCY");
    if (
      this.retries.length > 10 ||
      !this.retries.every(
        (delay) => Number.isSafeInteger(delay) && delay >= 0 && delay <= 60_000,
      )
    )
      throw Error("INVALID_RETRY_DELAYS");
    if (options.onEvent) this.listeners.add(options.onEvent);
  }
  get snapshot() {
    return this.state;
  }
  onEvent(listener: (event: UploadEvent) => void) {
    if (this.state.phase === "disposed") throw Error("UPLOAD_TERMINAL");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<UploadState> {
    return this.begin();
  }
  async resume(): Promise<UploadState> {
    return this.begin();
  }

  pause() {
    if (!["hashing", "uploading", "completing"].includes(this.state.phase))
      return;
    this.run++;
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.set({ ...this.state, phase: "paused", error: undefined });
  }
  cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation;
    if (["disposed", "complete"].includes(this.state.phase))
      return Promise.reject(Error("UPLOAD_TERMINAL"));
    if (this.state.phase === "cancelled") return Promise.resolve();
    this.invalidate();
    const run = this.run;
    const cancellation = Promise.resolve()
      .then(() => this.cancelUpload(run))
      .finally(() => {
        this.cancellation = undefined;
      });
    this.cancellation = cancellation;
    this.set({ ...this.state, phase: "cancelling", error: undefined });
    return cancellation;
  }
  private async cancelUpload(run: number) {
    try {
      this.current(run);
      const saved = this.recovery(() =>
        this.options.recovery.read(
          this.options.coachId,
          this.options.sessionId,
        ),
      );
      let uploadId = this.state.uploadId ?? saved?.uploadId;
      if (!this.source && saved)
        this.source = {
          sessionId: this.options.sessionId,
          fileName: this.options.file.name ?? "clip",
          mimeType: saved.mimeType,
          bytesTotal: saved.bytesTotal,
          sha256: saved.sha256,
        };
      // Init may have reserved an upload even if its response was lost. Reconcile
      // the same source identity rather than silently discarding its recovery.
      if (!uploadId && this.source) {
        const init = await this.call((signal) =>
          this.options.transport.initialize(this.source!, signal),
        );
        this.current(run);
        this.validateInit(init, this.source!.bytesTotal);
        uploadId = init.uploadId;
        this.set({ ...this.state, uploadId });
      }
      this.current(run);
      if (uploadId)
        await this.call((signal) =>
          this.options.transport.abort(uploadId!, signal),
        );
      this.current(run);
      this.recovery(() =>
        this.options.recovery.clear(
          this.options.coachId,
          this.options.sessionId,
        ),
      );
      this.set({ ...this.state, phase: "cancelled", error: "CANCELLED" });
    } catch (error) {
      if (this.state.phase !== "disposed")
        this.set({
          ...this.state,
          phase: "cancel_failed",
          error: "UPLOAD_PART_FAILED",
        });
      throw error;
    }
  }
  dispose() {
    this.invalidate();
    this.set({ ...this.state, phase: "disposed" });
    this.listeners.clear();
  }
  private invalidate() {
    this.run++;
    for (const controller of this.active) controller.abort();
  }
  private recovery<T>(operation: () => T): T | undefined {
    try {
      return operation();
    } catch {
      return undefined;
    }
  }

  async complete(): Promise<{ jobId: string | null }> {
    if (this.state.phase !== "ready_to_complete" || !this.state.uploadId)
      throw Error("NOT_READY_TO_COMPLETE");
    const run = ++this.run;
    this.set({ ...this.state, phase: "completing" });
    try {
      this.current(run);
      const result = await this.call((signal) =>
        this.options.transport.complete(this.state.uploadId!, signal),
      );
      this.current(run);
      this.recovery(() =>
        this.options.recovery.clear(
          this.options.coachId,
          this.options.sessionId,
        ),
      );
      this.set({ ...this.state, phase: "complete", error: undefined });
      this.emit({ type: "complete", jobId: result.jobId });
      return result;
    } catch (error) {
      if (this.run !== run) throw error;
      this.fail(run, this.errorCode(error));
      throw error;
    }
  }

  private async begin(): Promise<UploadState> {
    if (["hashing", "uploading", "completing"].includes(this.state.phase))
      return this.state;
    if (
      [
        "cancelled",
        "complete",
        "disposed",
        "cancelling",
        "cancel_failed",
      ].includes(this.state.phase)
    )
      throw Error("UPLOAD_TERMINAL");
    if (this.state.phase === "failed" && this.state.wholeUploadAttempts >= 3)
      return this.state;
    const run = ++this.run;
    this.set({ ...this.state, phase: "hashing", error: undefined });
    try {
      const sha256 = await this.hash(run);
      this.current(run);
      const saved = this.recovery(() =>
        this.options.recovery.read(
          this.options.coachId,
          this.options.sessionId,
        ),
      );
      if (
        saved &&
        (saved.sha256 !== sha256 ||
          saved.bytesTotal !== this.options.file.size ||
          saved.mimeType !== this.options.file.type)
      )
        return this.fail(run, "UPLOAD_CHECKSUM");
      this.source = {
        sessionId: this.options.sessionId,
        fileName: this.options.file.name ?? "clip",
        mimeType: this.options.file.type,
        bytesTotal: this.options.file.size,
        sha256,
      };
      this.recovery(() =>
        this.options.recovery.write(
          this.options.coachId,
          this.options.sessionId,
          {
            version: 1,
            sha256,
            bytesTotal: this.options.file.size,
            mimeType: this.options.file.type,
          },
        ),
      );
      const init = await this.call((signal) =>
        this.options.transport.initialize(this.source!, signal),
      );
      this.current(run);
      this.validateInit(init);
      this.recovery(() =>
        this.options.recovery.write(
          this.options.coachId,
          this.options.sessionId,
          {
            version: 1,
            sha256,
            bytesTotal: this.options.file.size,
            mimeType: this.options.file.type,
            uploadId: init.uploadId,
          },
        ),
      );
      const confirmed = uniqueParts(init.resumeFrom, init.partCount)!;
      this.set({
        ...this.state,
        phase: "uploading",
        sha256,
        uploadId: init.uploadId,
        confirmedParts: confirmed,
        confirmedBytes: this.confirmedBytes(confirmed, init.partSize),
      });
      await this.uploadMissing(run, init);
      this.current(run);
      if (
        this.state.confirmedParts.length !== init.partCount ||
        this.state.confirmedBytes !== this.options.file.size
      )
        throw Error("INVALID_RESPONSE");
      this.set({ ...this.state, phase: "ready_to_complete", error: undefined });
      return this.state;
    } catch (error) {
      return this.handleFailure(run, error, this.state);
    }
  }
  private async hash(run: number) {
    this.current(run);
    return this.call((signal) =>
      sha256Blob(this.options.file, {
        signal,
        onProgress: (hashedBytes) => {
          if (this.run === run)
            this.emit({
              type: "hash_progress",
              hashedBytes,
              bytesTotal: this.options.file.size,
            });
        },
      }),
    );
  }
  private async uploadMissing(run: number, init: InitResponse) {
    const confirmed = new Set(this.state.confirmedParts);
    const missing = Array.from(
      { length: init.partCount },
      (_, index) => index + 1,
    ).filter((part) => !confirmed.has(part));
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        this.current(run);
        const partNumber = missing[cursor++];
        try {
          await this.uploadPart(run, init, partNumber);
        } catch (error) {
          if (this.run === run) {
            this.fail(run, this.errorCode(error));
          }
          throw error;
        }
      }
    };
    const results = await Promise.allSettled(
      Array.from(
        { length: Math.min(this.partConcurrency, missing.length) },
        worker,
      ),
    );
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
  private async uploadPart(
    run: number,
    init: InitResponse,
    partNumber: number,
  ) {
    const start = (partNumber - 1) * init.partSize;
    const part = this.options.file.slice(
      start,
      Math.min(this.options.file.size, start + init.partSize),
    );
    if (part.size !== Math.min(init.partSize, this.options.file.size - start))
      throw Error("INVALID_BLOB");
    for (let attempt = 0; ; attempt++) {
      try {
        this.current(run);
        const signed = await this.call((signal) =>
          this.options.transport.signParts(init.uploadId, [partNumber], signal),
        );
        this.current(run);
        if (signed.length !== 1 || !this.validSigned(signed[0], partNumber))
          throw Error("INVALID_RESPONSE");
        const uploaded = await this.call((signal) =>
          this.options.transport.put(
            signed[0].url,
            part,
            this.options.file.type,
            signal,
          ),
        );
        this.current(run);
        if (
          !safeInteger(uploaded.bytes) ||
          uploaded.bytes !== part.size ||
          !this.validEtag(uploaded.etag)
        )
          throw Error("INVALID_RESPONSE");
        const confirmed = await this.call((signal) =>
          this.options.transport.confirm(
            init.uploadId,
            { partNumber, ...uploaded },
            signal,
          ),
        );
        this.current(run);
        if (
          !safeInteger(confirmed.bytesConfirmed) ||
          !this.validAggregate(confirmed.bytesConfirmed, init, partNumber)
        )
          throw Error("INVALID_RESPONSE");
        this.current(run);
        const parts = [
          ...new Set([...this.state.confirmedParts, partNumber]),
        ].sort((a, b) => a - b);
        this.set({
          ...this.state,
          confirmedParts: parts,
          confirmedBytes: this.confirmedBytes(parts, init.partSize),
        });
        return;
      } catch (error) {
        // Pause/cancel/dispose invalidate the generation. An AbortError while
        // this run is current is a transport deadline and may use its retry budget.
        this.current(run);
        if (attempt >= this.retries.length) throw error;
        await this.wait(this.retries[attempt], run);
      }
    }
  }
  private validAggregate(total: number, init: InitResponse, part: number) {
    const minimum = this.confirmedBytes(
      [...init.resumeFrom, part],
      init.partSize,
    );
    const remainder = this.options.file.size % init.partSize;
    return (
      total >= minimum &&
      total <= this.options.file.size &&
      (total % init.partSize === 0 ||
        (remainder > 0 && total % init.partSize === remainder)) &&
      ((part !== init.partCount && !init.resumeFrom.includes(init.partCount)) ||
        !remainder ||
        total % init.partSize === remainder)
    );
  }
  private confirmedBytes(parts: readonly number[], partSize: number) {
    return parts.reduce(
      (total, part) =>
        total +
        Math.min(partSize, this.options.file.size - (part - 1) * partSize),
      0,
    );
  }
  private validateInit(
    value: InitResponse,
    bytesTotal = this.options.file.size,
  ) {
    if (
      !value ||
      typeof value.uploadId !== "string" ||
      !value.uploadId ||
      value.uploadId.length > 256 ||
      !/^[A-Za-z0-9_-]+$/.test(value.uploadId) ||
      !safeInteger(value.partSize) ||
      value.partSize < 1 ||
      value.partSize > 8 * 1024 ** 2 ||
      !safeInteger(value.partCount) ||
      value.partCount < 1 ||
      value.partCount > 10000 ||
      value.partCount !== Math.ceil(bytesTotal / value.partSize) ||
      uniqueParts(value.resumeFrom, value.partCount) === null
    )
      throw Error("INVALID_RESPONSE");
  }
  private validSigned(value: SignedPart, partNumber: number) {
    try {
      const url = new URL(
        value.url,
        typeof location === "undefined" ? undefined : location.href,
      );
      return (
        !url.username &&
        !url.password &&
        !url.hash &&
        value.partNumber === partNumber &&
        typeof value.expiresAt === "number" &&
        value.expiresAt > Date.now() &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            typeof location !== "undefined" &&
            url.origin === location.origin))
      );
    } catch {
      return false;
    }
  }
  private validEtag(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 256;
  }
  private errorCode(error: unknown): UploadErrorCode {
    return error instanceof Error &&
      ["INVALID_RESPONSE", "CONSENT_REQUIRED"].includes(error.message)
      ? (error.message as UploadErrorCode)
      : "UPLOAD_PART_FAILED";
  }
  private async wait(delay: number, run: number) {
    await this.call(
      (signal) =>
        new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Upload paused", "AbortError"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, delay);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
    ).then(() => this.current(run));
  }
  private async call<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), 120_000);
    let abort: () => void = () => undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () =>
          reject(new DOMException("Upload interrupted", "AbortError"));
        controller.signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted();
            return operation(controller.signal);
          })
          .then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      this.active.delete(controller);
    }
  }

  private current(run: number) {
    if (this.run !== run)
      throw new DOMException("Stale upload completion", "AbortError");
  }
  private handleFailure<T>(run: number, error: unknown, fallback: T): T {
    if (this.run !== run) return fallback;
    return this.fail(run, this.errorCode(error)) as T;
  }
  private fail(run: number, error: UploadErrorCode): UploadState {
    if (this.run === run) {
      this.invalidate();
      this.set({
        ...this.state,
        phase: "failed",
        wholeUploadAttempts: this.state.wholeUploadAttempts + 1,
        error,
      });
    }
    return this.state;
  }
  private set(state: UploadState) {
    this.state = Object.freeze({
      ...state,
      confirmedParts: Object.freeze([...state.confirmedParts]),
    });
    this.emit({ type: "state", state: this.state });
  }
  private emit(event: UploadEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
