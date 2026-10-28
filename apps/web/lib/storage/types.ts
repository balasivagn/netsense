export interface VideoStorage {
  driver: "r2" | "local";
  initMultipart(key: string, contentType: string): Promise<{ uploadId: string }>;
  signPartUrls(
    key: string,
    uploadId: string,
    partNumbers: number[],
    ttlS: number,
  ): Promise<{ partNumber: number; url: string; expiresAt: number }[]>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<{ bytes: number; contentType?: string } | null>;
  signGetUrl(
    key: string,
    ttlS: number,
    opts?: { contentDisposition?: "inline" },
  ): Promise<string>;
  signPutUrl(key: string, contentType: string, ttlS: number): Promise<string>;
  delete(keyOrPrefix: string): Promise<void>;
}
