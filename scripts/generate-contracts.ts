import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { format } from "prettier";
import { compile } from "json-schema-to-typescript";
import { loadSchemas, dereference } from "./schema-utils";
import { convexValidator } from "./convex-validator-source";
import { modelSchemas } from "./lint-model-schemas";
import { persistenceSources } from "./persistence-validators";
const registry = loadSchemas();
const check = process.argv.includes("--check");
await mkdir(".orca-scratch", { recursive: true });
const temp = await mkdtemp(".orca-scratch/contracts-");
try {
  const schemas = (await readdir("packages/contracts/schemas"))
    .filter((n) => n.endsWith(".json"))
    .sort();
  const outputs: Record<string, string> = persistenceSources(registry);
  for (const file of schemas) {
    const name = file.slice(0, -5);
    const schema = dereference(registry[file], file, registry);
    // The pinned upstream generator treats nullable fields as optional. All wire
    // properties are required; enforce that invariant before removing None defaults.
    function requireAll(node: unknown): void {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(requireAll);
        return;
      }
      const value = node as Record<string, unknown>;
      if (value.properties) {
        const required = (value.required as string[]) ?? [];
        if (
          Object.keys(value.properties as object).some(
            (key) => !required.includes(key),
          )
        )
          throw Error(
            "Wire properties must be required; update generator for optional fields",
          );
      }
      Object.values(value).forEach(requireAll);
    }
    requireAll(schema);
    await mkdir(join(temp, "input"), { recursive: true });
    await writeFile(join(temp, "input", file), JSON.stringify(schema));
    outputs[`packages/contracts/gen/${name}.ts`] = await compile(schema, name, {
      bannerComment: "/* Generated from JSON Schema. Do not edit. */",
      additionalProperties: false,
      unknownAny: true,
      declareExternallyReferenced: true,
      enableConstEnums: false,
    });
    execFileSync(
      "uv",
      [
        "run",
        "--project",
        "runner",
        "datamodel-codegen",
        "--input",
        resolve(temp, "input", file),
        "--input-file-type",
        "jsonschema",
        "--output",
        resolve(temp, `${name}.py`),
        "--output-model-type",
        "pydantic_v2.BaseModel",
        "--target-python-version",
        "3.12",
        "--use-standard-collections",
        "--use-union-operator",
        "--use-subclass-enum",
        "--disable-timestamp",
        "--use-title-as-name",
        "--field-constraints",
        "--use-annotated",
        "--strip-default-none",
        "--enum-field-as-literal",
        "all",
        "--base-class",
        "netsense_runner.contract_base.ContractModel",
        "--formatters",
        "ruff-check",
        "ruff-format",
      ],
      { stdio: "pipe" },
    );
    const pyPath = join(temp, `${name}.py`);
    await writeFile(
      pyPath,
      (await readFile(pyPath, "utf8")).replace(/ = None$/gm, ""),
    );
    execFileSync(
      "uv",
      [
        "run",
        "--project",
        "runner",
        "ruff",
        "check",
        "--fix",
        "--config",
        "runner/pyproject.toml",
        pyPath,
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      "uv",
      [
        "run",
        "--project",
        "runner",
        "ruff",
        "format",
        "--config",
        "runner/pyproject.toml",
        pyPath,
      ],
      { stdio: "pipe" },
    );
    outputs[`runner/netsense_runner/contracts/${name}.py`] = await readFile(
      pyPath,
      "utf8",
    );
  }
  // Separate TS modules avoid collisions between shared names emitted by the upstream generator.
  outputs["packages/contracts/gen/index.ts"] =
    schemas
      .map(
        (f) => `export type { ${f.slice(0, -5)} } from "./${f.slice(0, -5)}";`,
      )
      .join("\n") + "\n";
  outputs["runner/netsense_runner/contracts/__init__.py"] =
    '"""Generated contract models. Import each named module directly."""\n';
  outputs["runner/netsense_runner/contracts/schemas.json"] =
    JSON.stringify(registry, null, 2) + "\n";
  const digest = createHash("sha256");
  for (const file of schemas)
    digest
      .update(file)
      .update(await readFile(`packages/contracts/schemas/${file}`));
  const foundationSources = [
    "convex/schema.ts",
    "convex/pipeline.ts",
    "convex/http.ts",
    "convex/worker.ts",
    "convex/lib/httpInput.ts",
    "packages/contracts/validateSchema.ts",
    "scripts/persistence-validators.ts",
    "scripts/convex-validator-source.ts",
    "convex/validators.ts",
    "convex/errorCodes.ts",
    "convex/coaches.ts",
    "convex/config.ts",
    "convex/students.ts",
    "convex/sessions.ts",
    "convex/jobs.ts",
    "convex/stageRuns.ts",
    "convex/uploads.ts",
    "convex/lib/auth.ts",
    "config/pipeline_config.v1.json",
  ].sort();
  const sourceDigests: Record<string, string> = {};
  for (const path of foundationSources)
    sourceDigests[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  outputs["packages/contracts/manifest.json"] =
    JSON.stringify(
      {
        version: 1,
        foundationSourceDigests: Object.entries(sourceDigests).map(
          ([path, sha256]) => ({ path, sha256 }),
        ),
        algorithm: "sha256(filename + source bytes, sorted filenames)",
        digest: digest.digest("hex"),
        schemas: schemas.map((f) => f.slice(0, -5)),
      },
      null,
      2,
    ) + "\n";
  outputs["config/defaults.ts"] =
    '// Generated from pipeline_config.v1.json. Do not edit.\nimport type { PipelineConfig } from "../packages/contracts/gen/PipelineConfig";\nexport default ' +
    (await readFile("config/pipeline_config.v1.json", "utf8")).trim() +
    " satisfies PipelineConfig;\n";
  outputs["convex/modelOutputs.ts"] =
    '// Generated from model-output schemas. Do not edit.\nimport { v } from "convex/values";\n' +
    modelSchemas
      .map(
        (name) =>
          `export const ${name} = ${convexValidator(dereference(registry[`${name}.json`], `${name}.json`, registry))};`,
      )
      .join("\n") +
    "\nexport const modelOutput = v.union(" +
    modelSchemas.join(",") +
    ");\n";
  let drift = false;
  for (const [file, rawContent] of Object.entries(outputs)) {
    const content = file.endsWith(".ts")
      ? await format(rawContent, { parser: "typescript" })
      : rawContent;
    if (check) {
      if ((await readFile(file, "utf8").catch(() => null)) !== content) {
        console.error(`Contract drift: ${file}`);
        drift = true;
      }
    } else {
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, content);
    }
  }
  for (const dir of [
    "packages/contracts/gen",
    "runner/netsense_runner/contracts",
  ]) {
    for (const file of await readdir(dir)) {
      if (
        (file.endsWith(".ts") || file.endsWith(".py")) &&
        !(`${dir}/${file}` in outputs)
      ) {
        if (check) {
          console.error(`Stale generated file: ${dir}/${file}`);
          drift = true;
        } else await rm(`${dir}/${file}`);
      }
    }
  }
  if (drift) process.exitCode = 1;
  else
    console.log(
      `${check ? "Verified" : "Generated"} ${schemas.length} contracts (TypeScript + Pydantic)`,
    );
} finally {
  await rm(temp, { recursive: true, force: true });
}
