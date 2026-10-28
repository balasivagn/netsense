/** Retry-report metadata only. Convex verifies the issued generation; no client total. */
export function failureStore(coachId: string, sessionId: string) {
  const key = `netsense-upload-failure-v1:${encodeURIComponent(coachId)}:${encodeURIComponent(sessionId)}`;
  return {
    read(): number | undefined {
      try {
        const raw = localStorage.getItem(key);
        if (!raw || raw.length > 16 || !/^[1-9][0-9]*$/.test(raw)) return;
        const attempt = Number(raw);
        return Number.isSafeInteger(attempt) ? attempt : undefined;
      } catch {
        return undefined;
      }
    },
    write(attempt: number | undefined) {
      try {
        if (attempt === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, String(attempt));
      } catch {
        /* Unavailable storage cannot promise recovery after reload. */
      }
    },
  };
}
