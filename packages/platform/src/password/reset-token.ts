import { createHash, createHmac } from "node:crypto";

export interface ResetKey {
  readonly keyId: string;
  readonly secret: string;
}
/** Random UUID selector plus a 256-bit, purpose-separated PRF secret. Only its SHA-256 is stored.
 * The dedicated key lets the durable email worker reproduce the same link without storing it.
 */
export function resetToken(id: string, key: ResetKey): string {
  const secret = createHmac("sha256", Buffer.from(key.secret, "base64url"))
    .update(`ih:password-reset:v1:${id}`)
    .digest("base64url");
  return `${id}.${secret}`;
}
export function resetTokenId(token: string): string | null {
  return (
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/.exec(
      token,
    )?.[1] ?? null
  );
}
export function resetTokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
/** Keyed recipient fingerprint: do not redirect a previously issued link after an email change. */
export function resetRecipientHash(email: string, key: ResetKey): Buffer {
  return createHmac("sha256", Buffer.from(key.secret, "base64url"))
    .update(`ih:password-reset-recipient:v1:${email}`)
    .digest();
}
