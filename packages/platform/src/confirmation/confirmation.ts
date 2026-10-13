import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
export const ORDER_COOKIE = "__Host-ih_order";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export type ConfirmationKey = { keyId: string; secret: string };
export function confirmationHash(token: string): Buffer {
  if (!TOKEN.test(token) || Buffer.from(token, "base64url").toString("base64url") !== token)
    throw new Error("Invalid confirmation capability");
  return createHash("sha256").update(token).digest();
}
export function readConfirmationCookie(header: string | undefined): string | null {
  const matches = (header ?? "")
    .split(";")
    .filter((part) => part.slice(0, part.indexOf("=")).trim() === ORDER_COOKIE);
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(matches[0]!.indexOf("=") + 1).trim();
  try {
    confirmationHash(token);
    return token;
  } catch {
    return null;
  }
}
export function orderConfirmationCookie(token: string, expiresAt: Date, now = Date.now()) {
  confirmationHash(token);
  const seconds = Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000));
  return `${ORDER_COOKIE}=${token}; Max-Age=${seconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
/** API-only authenticated encryption. AAD binds replay material to its exact idempotency key. */
export class ConfirmationCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly active: string;
  constructor(keys: readonly ConfirmationKey[]) {
    if (!keys.length) throw new Error("Confirmation encryption key required");
    this.keys = new Map(
      keys.map(({ keyId, secret }) => {
        const decoded = Buffer.from(secret, "base64url");
        if (
          !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) ||
          decoded.length !== 32 ||
          decoded.toString("base64url") !== secret
        )
          throw new Error("Invalid confirmation encryption key");
        return [keyId, decoded];
      }),
    );
    if (this.keys.size !== keys.length) throw new Error("Duplicate confirmation encryption key");
    this.active = keys[0]!.keyId;
  }
  mint(binding: string) {
    const token = randomBytes(32).toString("base64url");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.active)!, iv);
    cipher.setAAD(Buffer.from("ih:confirmation:v1:" + binding));
    const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return {
      hash: confirmationHash(token),
      material: Buffer.from(
        [
          this.active,
          iv.toString("base64url"),
          encrypted.toString("base64url"),
          cipher.getAuthTag().toString("base64url"),
        ].join("."),
      ),
    };
  }
  open(material: Buffer, binding: string): string | null {
    try {
      if (material.length > 256) return null;
      const parts = material.toString().split(".");
      if (parts.length !== 4) return null;
      const [id, nonce, body, tag] = parts as [string, string, string, string];
      const key = this.keys.get(id);
      if (!key) return null;
      const decode = (s: string) => {
        const b = Buffer.from(s, "base64url");
        if (b.toString("base64url") !== s) throw new Error("Invalid encoding");
        return b;
      };
      const iv = decode(nonce),
        auth = decode(tag);
      if (iv.length !== 12 || auth.length !== 16) return null;
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from("ih:confirmation:v1:" + binding));
      decipher.setAuthTag(auth);
      const token = Buffer.concat([decipher.update(decode(body)), decipher.final()]).toString();
      confirmationHash(token);
      return token;
    } catch {
      return null;
    }
  }
}
