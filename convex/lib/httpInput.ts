import type { Id, TableNames } from "../_generated/dataModel";
import { errorCode } from "../errorCodes";
import { stage, stageStatus } from "../validators";

type Parser<T> = (value: unknown) => T;
function reject(): never {
  throw Error("INVALID_REQUEST");
}
export const string: Parser<string> = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 1024
    ? value
    : reject();
export const number: Parser<number> = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : reject();
export const integer: Parser<number> = (value) => {
  const n = number(value);
  return Number.isSafeInteger(n) ? n : reject();
};
export const optional =
  <T>(parse: Parser<T>): Parser<T | undefined> =>
  (value) =>
    value === undefined ? undefined : parse(value);
export const nullable =
  <T>(parse: Parser<T>): Parser<T | null> =>
  (value) =>
    value === null ? null : parse(value);
export function enumeration<const T extends string>(
  values: readonly T[],
): Parser<T> {
  return (value) =>
    typeof value === "string" && values.some((item) => item === value)
      ? (value as T)
      : reject();
}
// Only a nonempty bounded string is branded here; Convex's v.id validator validates the
// table id before entering a mutation. Token ids instead use db.normalizeId in-transaction.
export const id = <T extends TableNames>(_table: T): Parser<Id<T>> => {
  void _table;
  return (value) => string(value) as Id<T>;
};
export const parseStage = enumeration(
  stage.members.map((member) => member.value),
);
export const parseStageStatus = enumeration(
  stageStatus.members.map((member) => member.value),
);
export const parseError = enumeration(
  errorCode.members.map((member) => member.value),
);
export function object<S extends Record<string, Parser<unknown>>>(
  value: unknown,
  shape: S,
): { [K in keyof S]: ReturnType<S[K]> } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return reject();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !Object.hasOwn(shape, key)))
    return reject();
  // Every property is constructed by its parser; the mapped type preserves that relation.
  return Object.fromEntries(
    Object.entries(shape).map(([key, parse]) => [key, parse(record[key])]),
  ) as { [K in keyof S]: ReturnType<S[K]> };
}
export async function readBody(
  request: Request,
  limit = 32_768,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return reject();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return reject();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
