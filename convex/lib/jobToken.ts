/** Compact HMAC token helpers shared by the VM signer and Convex HTTP boundary. */
export type JobTokenPayload = { jobId: string; sessionId: string; exp: number };

const encoder = new TextEncoder();
function b64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function unb64url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error("TOKEN_INVALID");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function key(secret: string) {
  if (!secret) throw Error("TOKEN_SECRET_MISSING");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function signJobToken(payload: JobTokenPayload, secret: string) {
  if (!payload.jobId || !payload.sessionId || !Number.isSafeInteger(payload.exp)) throw Error("TOKEN_INVALID");
  const encoded = b64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(encoded)));
  return `${encoded}.${b64url(signature)}`;
}
export async function verifyJobToken(token: string, secret: string, now = Date.now()): Promise<JobTokenPayload> {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw Error("TOKEN_INVALID");
  const valid = await crypto.subtle.verify("HMAC", await key(secret), unb64url(signature), encoder.encode(encoded));
  if (!valid) throw Error("TOKEN_INVALID");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(unb64url(encoded))); } catch { throw Error("TOKEN_INVALID"); }
  if (!parsed || typeof parsed !== "object") throw Error("TOKEN_INVALID");
  const value = parsed as Record<string, unknown>;
  if (typeof value.jobId !== "string" || typeof value.sessionId !== "string" || typeof value.exp !== "number" || !Number.isSafeInteger(value.exp) || value.exp <= now) throw Error("TOKEN_EXPIRED");
  return { jobId: value.jobId, sessionId: value.sessionId, exp: value.exp };
}
