/** JSON Schema subset used by the generated persistence validators. The generator
 * rejects unknown keywords, so a schema amendment cannot silently weaken checks.
 * Pure evaluation of schema data: no runtime compilation/eval or AJV dependency.
 */
type Schema = { [key: string]: unknown };
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validateSchema(s: Schema, value: unknown): boolean {
  if (s.anyOf && !(s.anyOf as Schema[]).some((x) => validateSchema(x, value)))
    return false;
  if (Object.hasOwn(s, "const") && canonical(value) !== canonical(s.const))
    return false;
  if (
    s.enum &&
    !(s.enum as unknown[]).some((x) => canonical(x) === canonical(value))
  )
    return false;
  const type = s.type;
  if (type === "null") return value === null;
  if (type === "boolean" && typeof value !== "boolean") return false;
  if (type === "number" || type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (type === "integer" && !Number.isSafeInteger(value))
    )
      return false;
    if (
      (typeof s.minimum === "number" && value < s.minimum) ||
      (typeof s.maximum === "number" && value > s.maximum) ||
      (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) ||
      (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum)
    )
      return false;
  }
  if (type === "string") {
    if (typeof value !== "string") return false;
    const length = [...value].length;
    if (
      (typeof s.minLength === "number" && length < s.minLength) ||
      (typeof s.maxLength === "number" && length > s.maxLength) ||
      (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value))
    )
      return false;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return false;
    if (
      (typeof s.minItems === "number" && value.length < s.minItems) ||
      (typeof s.maxItems === "number" && value.length > s.maxItems)
    )
      return false;
    if (s.uniqueItems && new Set(value.map(canonical)).size !== value.length)
      return false;
    if (s.items && !value.every((x) => validateSchema(s.items as Schema, x)))
      return false;
  }
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const data = value as Record<string, unknown>;
    const properties = (s.properties ?? {}) as Record<string, Schema>;
    const patterns = Object.entries(
      (s.patternProperties ?? {}) as Record<string, Schema>,
    );
    if (((s.required as string[]) ?? []).some((k) => !Object.hasOwn(data, k)))
      return false;
    for (const [k, v] of Object.entries(data)) {
      const schemas = [
        ...(Object.hasOwn(properties, k) ? [properties[k]] : []),
        ...patterns
          .filter(([pattern]) => new RegExp(pattern, "u").test(k))
          .map(([, schema]) => schema),
      ];
      if (!schemas.length && s.additionalProperties === false) return false;
      if (!schemas.every((schema) => validateSchema(schema, v))) return false;
    }
  }
  return true;
}
