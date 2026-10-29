import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const target = "packages/contracts/gen/Subject.ts";
const original = await readFile(target, "utf8");
try {
  await writeFile(
    target,
    original + "\n// Deliberate drift for the negative acceptance test.\n",
  );
  const result = spawnSync("pnpm", ["contracts:check"], { encoding: "utf8" });
  if (
    result.status !== 1 ||
    !result.stderr.includes(`Contract drift: ${target}`)
  )
    throw Error("Drift check did not reject changed generated output");
  console.log("PASS: deliberate generated TypeScript drift rejected (exit 1)");
} finally {
  await writeFile(target, original);
}
const restored = spawnSync("pnpm", ["contracts:check"], { stdio: "inherit" });
if (restored.status !== 0)
  throw Error("Clean generated output failed after restoration");
console.log("PASS: original generated file restored and drift check passed");
