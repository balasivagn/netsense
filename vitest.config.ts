import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "convex/tests/**/*.test.ts",
      "packages/**/*.test.ts",
      "scripts/**/*.test.ts",
      "apps/web/**/*.test.ts",
      "apps/web/**/*.test.tsx",
    ],
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
