import { createHash, randomBytes } from "node:crypto";

/**
 * Admin session cookie (architecture §11): `__Host-` prefix, Secure, HttpOnly, SameSite=Strict,
 * Path=/, no Domain — set from the admin origin through the same-origin gateway. The value is a
 * 256-bit random token; only its SHA-256 is stored.
 */
export const SESSION_COOKIE = "__Host-ih_admin";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Every well-formed value of our cookie (duplicates are possible); malformed ones are ignored. */
export function readSessionTokens(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) return [];
  const tokens: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    if (TOKEN_PATTERN.test(value) && !tokens.includes(value)) tokens.push(value);
    if (tokens.length >= 4) break;
  }
  return tokens;
}

/** The session token to authenticate with: the first well-formed value of our cookie. */
export function readSessionToken(cookieHeader: string | undefined): string | null {
  return readSessionTokens(cookieHeader)[0] ?? null;
}

export function sessionCookie(token: string, expiresAt: Date, now = Date.now()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000));
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
