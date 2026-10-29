import {
  MultipartUploadController,
  type UploadState,
  type UploadTransport,
} from "../upload/multipart";
import type { UploadRecoveryStore } from "../upload/resume";

export type FlowState = Readonly<{
  file: File | null;
  upload: UploadState | null;
  error: string | null;
  busy: boolean;
  sourceVerified: boolean;
  consentRequired: boolean;
}>;
export class SessionFlow {
  private value: FlowState = {
    file: null,
    upload: null,
    error: null,
    busy: false,
    sourceVerified: false,
    consentRequired: false,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = true;
  private controller?: MultipartUploadController;
  private running?: number;
  private pausedAdmission = false;
  constructor(
    private readonly options: {
      coachId: string;
      sessionId: string;
      transport: UploadTransport;
      recovery: UploadRecoveryStore;
      selectMode(mode: "camera" | "camera_roll"): Promise<unknown>;
      beginAttempt(): Promise<number>;
      failAttempt(attempt: number): Promise<unknown>;
      failureStore?: {
        read(): number | undefined;
        write(attempt: number | undefined): void;
      };
    },
  ) {
    this.pendingFailure = options.failureStore?.read();
  }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<FlowState>) {
    if (!this.active) return;
    this.value = { ...this.value, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  async select(file: File, mode: "camera" | "camera_roll") {
    const generation = ++this.generation;
    this.controller?.dispose();
    this.controller = undefined;
    this.set({
      file: null,
      upload: null,
      error: null,
      busy: true,
      sourceVerified: false,
      consentRequired: false,
    });
    try {
      await this.options.selectMode(mode);
      if (!this.active || generation !== this.generation) return false;
      const controller = new MultipartUploadController({
        ...this.options,
        file,
      });
      this.controller = controller;
      controller.onEvent((event) => {
        if (
          this.active &&
          generation === this.generation &&
          event.type === "state"
        )
          this.set({
            upload: event.state,
            sourceVerified:
              this.value.sourceVerified ||
              [
                "uploading",
                "ready_to_complete",
                "completing",
                "complete",
              ].includes(event.state.phase),
          });
      });
      this.set({
        file,
        upload: controller.snapshot,
        busy: false,
        sourceVerified: false,
        consentRequired: false,
      });
      return true;
    } catch {
      if (generation === this.generation)
        this.set({
          busy: false,
          error: "Couldn’t select this clip. Please try again.",
        });
      return false;
    }
  }
  async run() {
    const controller = this.controller;
    if (
      !controller ||
      this.running === this.generation ||
      !this.active ||
      [
        "complete",
        "cancelled",
        "disposed",
        "cancelling",
        "cancel_failed",
      ].includes(controller.snapshot.phase)
    )
      return;
    const generation = this.generation;
    this.running = generation;
    this.pausedAdmission = false;
    this.set({ error: null, consentRequired: false });
    let attempt: number | undefined;
    try {
      attempt = await this.options.beginAttempt();
      if (!this.active || generation !== this.generation) return;
      if (
        this.pausedAdmission ||
        ["cancelled", "cancelling", "cancel_failed"].includes(
          controller.snapshot.phase,
        )
      )
        return;
      const state = await controller.resume();
      if (!this.active || generation !== this.generation) return;
      if (state.phase === "ready_to_complete") await controller.complete();
      if (controller.snapshot.phase === "failed") throw Error("UPLOAD_FAILED");
    } catch (cause) {
      if (this.active && generation === this.generation) {
        if (
          cause instanceof Error &&
          /\bCONSENT_REQUIRED\b/.test(cause.message)
        )
          this.set({ consentRequired: true });
        // Failure reports are bound to a server-issued attempt and idempotent.
        // If offline, retry this report before admitting a later attempt.
        if (attempt !== undefined && controller.snapshot.phase === "failed") {
          this.pendingFailure = attempt;
          this.options.failureStore?.write(attempt);
          await this.flushFailure();
        }
        if (generation === this.generation)
          this.set({
            error:
              "Upload paused. Confirmed parts are kept. Try again when connected.",
          });
      }
    } finally {
      if (this.running === generation) this.running = undefined;
    }
  }
  private pendingFailure?: number;
  private async flushFailure() {
    if (this.pendingFailure === undefined) return;
    await this.options.failAttempt(this.pendingFailure);
    this.pendingFailure = undefined;
    this.options.failureStore?.write(undefined);
  }
  async retry() {
    if (!this.active) return;
    try {
      await this.flushFailure();
      await this.run();
    } catch {
      this.set({ error: "No connection, try again" });
    }
  }
  pause() {
    this.pausedAdmission = true;
    this.controller?.pause();
  }
  async cancel() {
    if (!this.active) return;
    const generation = this.generation;
    this.set({ error: null });
    try {
      await this.controller?.cancel();
    } catch {
      if (generation === this.generation)
        this.set({ error: "Couldn’t cancel. Try cancelling again." });
    }
  }
  dispose() {
    this.active = false;
    this.generation++;
    this.controller?.dispose();
    this.controller = undefined;
    this.value = {
      file: null,
      upload: null,
      error: null,
      busy: false,
      sourceVerified: false,
      consentRequired: false,
    };
    this.listeners.clear();
  }
}
