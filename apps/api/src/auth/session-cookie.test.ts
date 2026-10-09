import { describe, expect, it } from "vitest";
import {
  clearedSessionCookie,
  hashSessionToken,
  newSessionToken,
  readSessionToken,
  sessionCookie,
} from "./session-cookie";

describe("admin session cookie", () => {
  it("issues 256-bit tokens and hashes them to 32 bytes", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hashSessionToken(token)).toHaveLength(32);
    expect(newSessionToken()).not.toBe(token);
  });

  it("reads only a well-formed __Host-ih_admin value", () => {
    const token = "A".repeat(43);
    expect(readSessionToken(`theme=dark; __Host-ih_admin=${token}; x=1`)).toBe(token);
    expect(readSessionToken(`ih_admin=${token}`)).toBeNull();
    expect(readSessionToken(`__Host-ih_admin=${token}x`)).toBeNull();
    // A malformed first duplicate does not hide a valid later one.
    expect(readSessionToken(`__Host-ih_admin=bad; __Host-ih_admin=${token}`)).toBe(token);
    expect(readSessionToken("__Host-ih_admin=../../etc")).toBeNull();
    expect(readSessionToken(undefined)).toBeNull();
  });

  it("sets host-only, secure, strict cookies bounded by the absolute expiry", () => {
    const now = Date.parse("2026-10-09T10:00:00Z");
    expect(sessionCookie("t", new Date(now + 3_600_000), now)).toBe(
      "__Host-ih_admin=t; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Strict",
    );
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });
});
