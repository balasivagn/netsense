import { LocalVideoStorage } from "./local";
import type { VideoStorage } from "./types";

export { LocalVideoStorage, StorageError } from "./local";
export type { VideoStorage } from "./types";

type StorageEnvironment = {
  STORAGE_DRIVER?: string;
  LOCAL_STORAGE_DIR?: string;
  MEDIA_URL_SIGNING_SECRET?: string;
  APP_BASE_URL?: string;
};

export function getVideoStorage(
  env: StorageEnvironment = process.env as StorageEnvironment,
): VideoStorage {
  if (env.STORAGE_DRIVER === "local") {
    if (!env.LOCAL_STORAGE_DIR || !env.MEDIA_URL_SIGNING_SECRET)
      throw new Error("Local storage requires LOCAL_STORAGE_DIR and MEDIA_URL_SIGNING_SECRET");
    return new LocalVideoStorage({
      rootDir: env.LOCAL_STORAGE_DIR,
      signingSecret: env.MEDIA_URL_SIGNING_SECRET,
      baseUrl: env.APP_BASE_URL,
    });
  }
  if (env.STORAGE_DRIVER === "r2")
    throw new Error("R2 storage is not implemented in this lane");
  throw new Error("STORAGE_DRIVER must be explicitly set to local or r2");
}
