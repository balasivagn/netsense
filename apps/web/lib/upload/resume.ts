export type UploadRecovery = {
  version: 1;
  sha256: string;
  bytesTotal: number;
  mimeType: string;
  uploadId: string;
};

export interface UploadRecoveryStore {
  read(coachId: string, sessionId: string): UploadRecovery | null;
  write(coachId: string, sessionId: string, value: UploadRecovery): void;
  clear(coachId: string, sessionId: string): void;
}

const valid = (value: unknown): value is UploadRecovery => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && typeof candidate.uploadId === "string" && candidate.uploadId.length > 0 &&
    typeof candidate.bytesTotal === "number" && Number.isSafeInteger(candidate.bytesTotal) && candidate.bytesTotal > 0 &&
    typeof candidate.mimeType === "string" && typeof candidate.sha256 === "string" && /^[a-f0-9]{64}$/.test(candidate.sha256);
};

export function recoveryKey(coachId: string, sessionId: string) {
  return `netsense-upload-v1:${encodeURIComponent(coachId)}:${encodeURIComponent(sessionId)}`;
}

/** Stores source identity only. Signed URLs, credentials and part URLs are never persisted. */
export function browserRecoveryStore(storage: Storage | null = typeof localStorage === "undefined" ? null : localStorage): UploadRecoveryStore {
  return {
    read(coachId, sessionId) {
      if (!storage) return null;
      try {
        const raw: unknown = JSON.parse(storage.getItem(recoveryKey(coachId, sessionId)) ?? "null");
        return valid(raw) ? raw : null;
      } catch { return null; }
    },
    write(coachId, sessionId, value) {
      if (!storage || !valid(value)) return;
      storage.setItem(recoveryKey(coachId, sessionId), JSON.stringify(value));
    },
    clear(coachId, sessionId) { storage?.removeItem(recoveryKey(coachId, sessionId)); },
  };
}
