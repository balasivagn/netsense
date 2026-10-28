export type UploadRecovery = {
  version: 1;
  sha256: string;
  bytesTotal: number;
  mimeType: string;
  uploadId?: string;
};

export interface UploadRecoveryStore {
  read(coachId: string, sessionId: string): UploadRecovery | null;
  write(coachId: string, sessionId: string, value: UploadRecovery): void;
  clear(coachId: string, sessionId: string): void;
}

const valid = (value: unknown): value is UploadRecovery => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![
      "bytesTotal,mimeType,sha256,uploadId,version",
      "bytesTotal,mimeType,sha256,version",
    ].includes(Object.keys(value).sort().join(","))
  )
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    (candidate.uploadId === undefined ||
      (typeof candidate.uploadId === "string" &&
        candidate.uploadId.length > 0 &&
        candidate.uploadId.length <= 256 &&
        /^[A-Za-z0-9_-]+$/.test(candidate.uploadId))) &&
    typeof candidate.bytesTotal === "number" &&
    Number.isSafeInteger(candidate.bytesTotal) &&
    candidate.bytesTotal > 0 &&
    candidate.bytesTotal <= 5 * 1024 ** 3 &&
    typeof candidate.mimeType === "string" &&
    ["video/mp4", "video/quicktime", "video/webm"].includes(
      candidate.mimeType,
    ) &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.sha256)
  );
};

export function recoveryKey(coachId: string, sessionId: string) {
  return `netsense-upload-v1:${encodeURIComponent(coachId)}:${encodeURIComponent(sessionId)}`;
}

/** Stores source identity only. Signed URLs, credentials and part URLs are never persisted. */
export function browserRecoveryStore(
  storage?: Storage | null,
): UploadRecoveryStore {
  if (storage === undefined) {
    try {
      storage = typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      storage = null;
    }
  }
  return {
    read(coachId, sessionId) {
      if (!storage) return null;
      try {
        const text = storage.getItem(recoveryKey(coachId, sessionId));
        if (!text || text.length > 2048) return null;
        const raw: unknown = JSON.parse(text);
        return valid(raw) ? raw : null;
      } catch {
        return null;
      }
    },
    write(coachId, sessionId, value) {
      if (!storage || !valid(value)) return;
      try {
        storage.setItem(recoveryKey(coachId, sessionId), JSON.stringify(value));
      } catch {
        /* Storage may be unavailable or full. Server remains authoritative. */
      }
    },
    clear(coachId, sessionId) {
      try {
        storage?.removeItem(recoveryKey(coachId, sessionId));
      } catch {
        /* Best effort only. */
      }
    },
  };
}
