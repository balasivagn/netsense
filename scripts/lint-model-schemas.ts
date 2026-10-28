import { dereference, loadSchemas, type Schema } from "./schema-utils";
export const modelSchemas = [
  "PlanModelOutput",
  "MomentModelOutput",
  "SubjectModelOutput",
  "PlaceModelOutput",
  "CriticModelOutput",
  "NextFocusModelOutput",
];
export function lintModelSchema(
  schema: Schema,
  file: string,
  registry: Record<string, Schema>,
): void {
  const resolved = dereference(schema, file, registry);
  function walk(node: Schema, depth: number, root: boolean): void {
    if ("allOf" in node || "oneOf" in node)
      throw Error("allOf/oneOf forbidden");
    if (root && "anyOf" in node) throw Error("root anyOf forbidden");
    const next =
      depth + (node.type === "object" || node.type === "array" ? 1 : 0);
    if (next > 10) throw Error("nesting exceeds 10");
    if (node.type === "object" || node.properties) {
      if (node.additionalProperties !== false)
        throw Error("object must be closed");
      const properties = (node.properties as Record<string, Schema>) ?? {};
      const required = (node.required as string[]) ?? [];
      if (
        required.length !== Object.keys(properties).length ||
        Object.keys(properties).some((k) => !required.includes(k))
      )
        throw Error("all keys must be required");
      for (const child of Object.values(properties)) walk(child, next, false);
    }
    if (node.items && typeof node.items === "object")
      walk(node.items as Schema, next, false);
    for (const child of (node.anyOf as Schema[]) ?? [])
      walk(child, next, false);
  }
  walk(resolved, 0, true);
}
if (process.argv[1]?.endsWith("lint-model-schemas.ts")) {
  const registry = loadSchemas();
  for (const name of modelSchemas)
    lintModelSchema(registry[`${name}.json`], `${name}.json`, registry);
  console.log(
    `Spark structural limits passed for ${modelSchemas.length} model-output schemas; live vendor acceptance UNTESTED`,
  );
}
