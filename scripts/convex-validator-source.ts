import type { Schema } from "./schema-utils";
// Convex validates shape; numerical ranges still need domain checks at mutation boundaries.
export function convexValidator(schema: Schema): string {
  if ("const" in schema) return `v.literal(${JSON.stringify(schema.const)})`;
  if (Array.isArray(schema.enum))
    return union(
      schema.enum.map((value) => `v.literal(${JSON.stringify(value)})`),
    );
  if (Array.isArray(schema.anyOf))
    return union(schema.anyOf.map((s) => convexValidator(s as Schema)));
  if (schema.type === "object") {
    const properties = (schema.properties as Record<string, Schema>) ?? {};
    const required = (schema.required as string[]) ?? [];
    return `v.object({${Object.entries(properties)
      .map(
        ([key, value]) =>
          `${JSON.stringify(key)}: ${required.includes(key) ? convexValidator(value) : `v.optional(${convexValidator(value)})`}`,
      )
      .join(",")}})`;
  }
  if (schema.type === "array")
    return `v.array(${convexValidator(schema.items as Schema)})`;
  if (schema.type === "integer" || schema.type === "number")
    return "v.number()";
  if (["string", "boolean", "null"].includes(schema.type as string))
    return `v.${schema.type}()`;
  throw Error(`Unsupported Convex schema type: ${schema.type}`);
}
function union(items: string[]): string {
  return items.length === 1 ? items[0] : `v.union(${items.join(",")})`;
}
