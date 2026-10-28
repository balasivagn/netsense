import { readFileSync, readdirSync } from "node:fs";
export type Schema = { [key: string]: unknown };
export function loadSchemas(): Record<string, Schema> {
  return Object.fromEntries(
    readdirSync("packages/contracts/schemas")
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((name) => [
        name,
        JSON.parse(
          readFileSync(`packages/contracts/schemas/${name}`, "utf8"),
        ) as Schema,
      ]),
  );
}
export function dereference(
  schema: Schema,
  file: string,
  registry: Record<string, Schema>,
  stack: string[] = [],
): Schema {
  if (typeof schema.$ref === "string") {
    const [target, fragment = ""] = schema.$ref.split("#");
    const targetFile = target || file;
    const key = targetFile + "#" + fragment;
    if (stack.includes(key)) throw Error(`Recursive reference: ${key}`);
    let resolved: unknown = registry[targetFile];
    for (const part of fragment.split("/").slice(1))
      resolved = (resolved as Schema)?.[
        part.replace(/~1/g, "/").replace(/~0/g, "~")
      ];
    if (!resolved || typeof resolved !== "object")
      throw Error(`Unresolved reference: ${key}`);
    const { $ref, ...siblings } = schema;
    void $ref;
    return {
      ...dereference(resolved as Schema, targetFile, registry, [...stack, key]),
      ...dereference(siblings, file, registry, stack),
    };
  }
  const visit = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(visit)
      : value && typeof value === "object"
        ? dereference(value as Schema, file, registry, stack)
        : value;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !["$defs", "$id"].includes(key))
      .map(([key, value]) => [key, visit(value)]),
  );
}
