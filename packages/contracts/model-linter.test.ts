import { expect, test } from "vitest";
import {
  lintModelSchema,
  modelSchemas,
} from "../../scripts/lint-model-schemas";
import { loadSchemas, type Schema } from "../../scripts/schema-utils";
const registry = loadSchemas();
for (const name of modelSchemas)
  test(`${name} Spark structural limits`, () =>
    expect(() =>
      lintModelSchema(registry[`${name}.json`], `${name}.json`, registry),
    ).not.toThrow());
const closed = (properties: Record<string, Schema> = {}): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
for (const [name, schema, message] of [
  ["open", { type: "object", properties: {} }, "closed"],
  [
    "optional",
    { ...closed({ x: { type: "string" } }), required: [] },
    "required",
  ],
  ["oneOf", { oneOf: [] }, "forbidden"],
  ["allOf", { allOf: [] }, "forbidden"],
  ["root anyOf", { anyOf: [] }, "root anyOf"],
] as const)
  test(`reject ${name}`, () =>
    expect(() => lintModelSchema(schema, "test.json", {})).toThrow(message));
test("resolves external and local refs before enforcing limits", () => {
  const bad = { ...closed({ x: { type: "string" } }), required: [] };
  expect(() =>
    lintModelSchema(
      closed({ child: { $ref: "other.json#/$defs/Bad" } }),
      "test.json",
      { "other.json": { $defs: { Bad: bad } } },
    ),
  ).toThrow("required");
});
test("reject recursion through external refs", () => {
  const a = closed({ child: { $ref: "b.json" } }),
    b = closed({ child: { $ref: "a.json" } });
  expect(() =>
    lintModelSchema(a, "a.json", { "a.json": a, "b.json": b }),
  ).toThrow("Recursive");
});
test("depth 10 passes, 11 fails and shared refs are not recursion", () => {
  let node: Schema = { type: "string" };
  for (let i = 0; i < 10; i++) node = closed({ child: node });
  expect(() => lintModelSchema(node, "test.json", {})).not.toThrow();
  expect(() =>
    lintModelSchema(closed({ child: node }), "test.json", {}),
  ).toThrow("nesting");
  expect(() =>
    lintModelSchema(
      closed({ a: { $ref: "s.json" }, b: { $ref: "s.json" } }),
      "test.json",
      { "s.json": closed() },
    ),
  ).not.toThrow();
});
test("nested anyOf is allowed but checked", () => {
  expect(() =>
    lintModelSchema(
      closed({ x: { anyOf: [closed(), { type: "null" }] } }),
      "test.json",
      {},
    ),
  ).not.toThrow();
  expect(() =>
    lintModelSchema(
      closed({ x: { anyOf: [{ type: "object" }] } }),
      "test.json",
      {},
    ),
  ).toThrow("closed");
});
