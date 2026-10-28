import { dereference, type Schema } from "./schema-utils";
import { convexValidator } from "./convex-validator-source";
export const persistenceContracts = [
  "TranscodeOutput",
  "TranscribeOutput",
  "PlanOutput",
  "MomentOutput",
  "SubjectAnchorOutput",
  "SubjectOutput",
  "TrackOutput",
  "PlaceOutput",
  "CheckOutput",
  "RenderOutput",
  "Provenance",
];
// Fail generation on a new validation keyword until the runtime supports it.
const supported = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "anyOf",
  "properties",
  "patternProperties",
  "required",
  "additionalProperties",
  "items",
  "uniqueItems",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);
function check(schema: Schema) {
  if (
    schema.type !== undefined &&
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(schema.type as string)
  )
    throw Error("Unsupported persistence type");
  if (
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  )
    throw Error("Unsupported persistence additionalProperties");
  for (const [key, value] of Object.entries(schema)) {
    if (!supported.has(key))
      throw Error(`Unsupported persistence keyword: ${key}`);
    if (["properties", "patternProperties"].includes(key))
      Object.values(value as Record<string, Schema>).forEach(check);
    if (key === "items") check(value as Schema);
    if (key === "anyOf") (value as Schema[]).forEach(check);
  }
}
export function persistenceSources(registry: Record<string, Schema>) {
  const resolved = Object.fromEntries(
    persistenceContracts.map((name) => {
      const schema = dereference(
        registry[`${name}.json`],
        `${name}.json`,
        registry,
      );
      check(schema);
      return [name, schema];
    }),
  );
  return {
    "packages/contracts/gen/persistenceValidation.ts": `// Generated from JSON Schemas. Do not edit.\nimport { validateSchema } from "../validateSchema";\n${persistenceContracts.map((name) => `import type { ${name} } from "./${name}";`).join("\n")}\nconst schemas = ${JSON.stringify(resolved)};\n${persistenceContracts.map((name) => `export function validate${name}(value: unknown): asserts value is ${name} { if (!validateSchema(schemas.${name}, value)) throw Error("CONTRACT_INVALID"); }`).join("\n")}\n`,
    "convex/persistenceValidators.ts": `// Generated from JSON Schemas. Do not edit.\nimport { v } from "convex/values";\n${persistenceContracts.map((name) => `export const ${name} = ${convexValidator(resolved[name])};`).join("\n")}\n`,
  };
}
