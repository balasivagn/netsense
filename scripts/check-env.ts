import { readFileSync } from "node:fs";
export function missingNames(
  template: string,
  env: NodeJS.ProcessEnv,
): string[] {
  return [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)]
    .map((m) => m[1])
    .filter((name) => !env[name]?.trim());
}
if (process.argv[1]?.endsWith("check-env.ts")) {
  const missing = missingNames(
    readFileSync(".env.example", "utf8"),
    process.env,
  );
  if (missing.length) {
    console.error(missing.join("\n"));
    process.exitCode = 1;
  } else console.log("All environment names are set");
}
