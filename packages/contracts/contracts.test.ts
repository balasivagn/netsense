import { expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { readFileSync } from "node:fs";
import { loadSchemas } from "../../scripts/schema-utils";
import seed from "../../config/pipeline_config.v1.json";
import { errorCode } from "../../convex/errorCodes";
const schemas = loadSchemas();
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const schema of Object.values(schemas)) ajv.addSchema(schema);
for (const [file, schema] of Object.entries(schemas)) {
  test(`${file} compiles and validates/rejects shared fixtures`, () => {
    const validate = ajv.getSchema(file)!;
    expect(validate).toBeTypeOf("function");
    const fixture = JSON.parse(
      readFileSync(`fixtures/synthetic/contracts/${file}`, "utf8"),
    ) as { valid: unknown; invalid: unknown };
    expect(validate(fixture.valid), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(fixture.invalid)).toBe(false);
    if (schema.type === "object" && Array.isArray(schema.required))
      for (const key of schema.required as string[]) {
        const missing = { ...(fixture.valid as Record<string, unknown>) };
        delete missing[key];
        expect(validate(missing), `required ${key}`).toBe(false);
      }
  });
}
test("seed conforms to contract and has each stage exactly once", () => {
  expect(ajv.getSchema("PipelineConfig.json")!(seed)).toBe(true);
  expect(new Set(seed.stages.map((s) => s.stage)).size).toBe(9);
  expect(seed.stages.find((s) => s.stage === "check")?.critic?.enabled).toBe(
    false,
  );
});
test("Convex errors match schema enum", () => {
  expect(errorCode.members.map((v) => v.value).sort()).toEqual(
    [...(schemas["ErrorCode.json"].enum as string[])].sort(),
  );
});
const negativeCases = JSON.parse(
  readFileSync("fixtures/synthetic/contracts/negative-cases.json", "utf8"),
) as { schema: string; label: string; value: unknown }[];
for (const c of negativeCases)
  test(`reject ${c.schema}: ${c.label}`, () =>
    expect(ajv.getSchema(`${c.schema}.json`)!(c.value)).toBe(false));
