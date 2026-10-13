import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConfirmationCipher,
  confirmationHash,
  ORDER_COOKIE,
  orderConfirmationCookie,
  readConfirmationCookie,
} from "./confirmation";
const old = { keyId: "old", secret: randomBytes(32).toString("base64url") };
const next = { keyId: "next", secret: randomBytes(32).toString("base64url") };
describe("cookie-only encrypted order confirmation", () => {
  it("mints independent 256-bit capabilities and stores only authenticated ciphertext", () => {
    const cipher = new ConfirmationCipher([old]);
    const a = cipher.mint("scope:key"),
      b = cipher.mint("scope:key");
    const token = cipher.open(a.material, "scope:key")!;
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(confirmationHash(token)).toEqual(a.hash);
    expect(a.hash).not.toEqual(b.hash);
    expect(a.material.toString()).not.toContain(token);
  });
  it("rejects tampered ciphertext and a different attempt binding", () => {
    const cipher = new ConfirmationCipher([old]);
    const a = cipher.mint("one");
    expect(cipher.open(a.material, "two")).toBeNull();
    const changed = Buffer.from(a.material);
    changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 1;
    expect(cipher.open(changed, "one")).toBeNull();
    expect(cipher.open(Buffer.alloc(257), "one")).toBeNull();
  });
  it("rotates encryption while retaining old decrypt keys and fails closed after retirement", () => {
    const a = new ConfirmationCipher([old]).mint("binding");
    const rotated = new ConfirmationCipher([next, old]);
    expect(rotated.open(a.material, "binding")).toBeTruthy();
    expect(rotated.mint("binding").material.toString()).toMatch(/^next\./);
    expect(new ConfirmationCipher([next]).open(a.material, "binding")).toBeNull();
  });
  it("requires distinct exact AES keys and a non-empty key ring", () => {
    expect(() => new ConfirmationCipher([])).toThrow();
    expect(() => new ConfirmationCipher([old, old])).toThrow();
    expect(
      () =>
        new ConfirmationCipher([{ keyId: "bad", secret: randomBytes(33).toString("base64url") }]),
    ).toThrow();
  });
  it("reads exactly one canonical cookie and rejects duplicates or other credentials", () => {
    const token = randomBytes(32).toString("base64url");
    expect(readConfirmationCookie(`other=abc; ${ORDER_COOKIE}=${token}`)).toBe(token);
    for (const value of [
      undefined,
      "orderNumber=IH-001001",
      `${ORDER_COOKIE}=bad`,
      `${ORDER_COOKIE}=${token}; ${ORDER_COOKIE}=${token}`,
    ])
      expect(readConfirmationCookie(value)).toBeNull();
  });
  it("sets secure host-only HttpOnly lax cookie without extending replay expiry", () => {
    const token = randomBytes(32).toString("base64url"),
      expires = new Date(1800000);
    const cookie = orderConfirmationCookie(token, expires, 0);
    expect(cookie).toBe(
      `${ORDER_COOKIE}=${token}; Max-Age=1800; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
    expect(orderConfirmationCookie(token, expires, 600000)).toContain("Max-Age=1200");
    expect(cookie).not.toContain("Domain=");
  });
});
