export type JobTokenClaims = { jobId: string; sessionId: string; exp: number };

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded =
      value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return base64url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function validClaims(value: unknown): value is JobTokenClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    typeof record.jobId === "string" &&
    record.jobId.length > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.exp === "number" &&
    Number.isSafeInteger(record.exp) &&
    record.exp > 0
  );
}

async function mac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left[index] ^ right[index];
  return difference === 0;
}

/** Signs raw UTF-8 JSON bytes, then base64url encodes payload and signature. */
export async function signJobToken(
  claims: JobTokenClaims,
  secret: string,
): Promise<string> {
  if (!secret || !validClaims(claims)) throw Error("TOKEN_INVALID");
  const payload = JSON.stringify({
    jobId: claims.jobId,
    sessionId: claims.sessionId,
    exp: claims.exp,
  });
  return `${base64url(encoder.encode(payload))}.${base64url(await mac(secret, payload))}`;
}

export async function verifyJobToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<JobTokenClaims | null> {
  if (!secret || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payloadBytes = fromBase64url(parts[0]);
  const signature = fromBase64url(parts[1]);
  if (!payloadBytes || !signature) return null;
  let payload: string;
  let claims: unknown;
  try {
    payload = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    claims = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!validClaims(claims) || claims.exp <= now) return null;
  return equal(signature, await mac(secret, payload)) ? claims : null;
}
