import { getVideoStorage } from "../../../../lib/storage";
import { createWorkerSignHandler } from "../../../../lib/worker-sign";

export const runtime = "nodejs";

export const POST = createWorkerSignHandler({
  env: {
    WORKER_TOKEN_SECRET: process.env.WORKER_TOKEN_SECRET,
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
    SIGNED_URL_TTL_SECONDS: process.env.SIGNED_URL_TTL_SECONDS,
  },
  storage: getVideoStorage,
  fetch,
});
