import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkAcceptedQuote,
  quoteFingerprint,
  signQuote,
  verifyQuote,
  type QuoteFacts,
} from "./quote-token";
const key = (keyId: string) => ({ keyId, secret: randomBytes(32).toString("base64url") });
const K1 = key("k1");
const K2 = key("k2");
const NOW = new Date("2026-10-12T08:00:00.000Z");
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const facts = (changes: Partial<QuoteFacts> = {}): QuoteFacts => ({
  areaId: "018f2f6e-7b1a-7c3e-9d4a-2b6c8e0f1a35",
  deliveryFeeFils: 1500,
  couponCode: "WELCOME15",
  couponPercentBps: 1500,
  merchandiseSubtotalFils: 21999,
  discountFils: 3300,
  totalFils: 20199,
  lines: [
    { variantId: "00000000-0000-7000-8000-000000000002", quantity: 2, unitPriceFils: 4500 },
    { variantId: "00000000-0000-7000-8000-000000000001", quantity: 1, unitPriceFils: 12999 },
  ],
  ...changes,
});
describe("quote fingerprint", () => {
  it("is stable for the same facts in any line order and ID case", () => {
    const base = quoteFingerprint(facts());
    expect(base).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(quoteFingerprint(facts({ lines: [...facts().lines].reverse() }))).toBe(base);
    expect(
      quoteFingerprint(
        facts({
          areaId: facts().areaId.toUpperCase(),
          lines: facts().lines.map((line) => ({
            ...line,
            variantId: line.variantId.toUpperCase(),
          })),
        }),
      ),
    ).toBe(base);
  });
  it("changes when anything the shopper is charged for changes", () => {
    const base = quoteFingerprint(facts());
    const [first, second] = facts().lines as [
      QuoteFacts["lines"][number],
      QuoteFacts["lines"][number],
    ];
    for (const changed of [
      facts({ deliveryFeeFils: 1501 }),
      facts({ totalFils: 20200 }),
      facts({ discountFils: 3299 }),
      facts({ merchandiseSubtotalFils: 22000 }),
      facts({ couponCode: null }),
      facts({ couponCode: "WELCOME16" }),
      facts({ couponPercentBps: 1600 }),
      facts({ areaId: "018f2f6e-7b1a-7c3e-9d4a-2b6c8e0f1a36" }),
      facts({ lines: [{ ...first, quantity: 3 }, second] }),
      facts({ lines: [{ ...first, unitPriceFils: 4501 }, second] }),
      facts({ lines: [first] }),
      facts({
        lines: [first, second, { ...second, variantId: "00000000-0000-7000-8000-000000000003" }],
      }),
    ])
      expect(quoteFingerprint(changed)).not.toBe(base);
    expect(() => quoteFingerprint(facts({ totalFils: 201.99 }))).toThrow(RangeError);
  });
});
describe("quote token", () => {
  const fingerprint = quoteFingerprint(facts());
  it("verifies its own signature until it expires", () => {
    const token = signQuote(fingerprint, later(900), K1);
    expect(verifyQuote(token, [K1], NOW)).toEqual({
      ok: true,
      fingerprint,
      expiresAt: later(900),
    });
    expect(verifyQuote(token, [K1], later(899))).toMatchObject({ ok: true });
    expect(verifyQuote(token, [K1], later(900))).toEqual({ ok: false, reason: "expired" });
    // An older key still verifies during rotation; a removed key does not.
    expect(verifyQuote(token, [K2, K1], NOW)).toMatchObject({ ok: true });
    expect(verifyQuote(token, [K2], NOW)).toEqual({ ok: false, reason: "unknown_key" });
  });
  it("refuses any altered or foreign token", () => {
    const token = signQuote(fingerprint, later(900), K1);
    const [version, keyId, expiry, fp, signature] = token.split(".") as [
      string,
      string,
      string,
      string,
      string,
    ];
    const other = quoteFingerprint(facts({ totalFils: 1 }));
    const join = (...parts: string[]) => parts.join(".");
    for (const [forged, reason] of [
      [join(version, keyId, String(Number(expiry) + 3600), fp, signature), "bad_signature"],
      [join(version, keyId, expiry, other, signature), "bad_signature"],
      [
        join(
          version,
          keyId,
          expiry,
          fp,
          signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A"),
        ),
        "bad_signature",
      ],
      [signQuote(fingerprint, later(900), { ...K2, keyId: "k1" }), "bad_signature"],
      [join("v2", keyId, expiry, fp, signature), "malformed"],
      [join(version, keyId, expiry, fp), "malformed"],
      ["", "malformed"],
      ["x".repeat(300), "malformed"],
    ] as const)
      expect(verifyQuote(forged, [K1], NOW), forged.slice(0, 40)).toEqual({ ok: false, reason });
    expect(verifyQuote(undefined as never, [K1], NOW)).toEqual({ ok: false, reason: "malformed" });
  });
});
describe("accepted quote check", () => {
  const token = signQuote(quoteFingerprint(facts()), later(900), K1);
  it("accepts only the unchanged facts, in time", () => {
    expect(checkAcceptedQuote(token, [K1], NOW, facts())).toBe("ACCEPTED");
    expect(checkAcceptedQuote(token, [K1], later(900), facts())).toBe("QUOTE_EXPIRED");
    // A price that moved by one fil, in either direction, needs a new acceptance.
    expect(checkAcceptedQuote(token, [K1], NOW, facts({ totalFils: 20198 }))).toBe("QUOTE_CHANGED");
    expect(checkAcceptedQuote(token, [K1], NOW, facts({ totalFils: 20200 }))).toBe("QUOTE_CHANGED");
    expect(checkAcceptedQuote(token, [K1], NOW, facts({ couponCode: null }))).toBe("QUOTE_CHANGED");
    expect(checkAcceptedQuote("forged", [K1], NOW, facts())).toBe("QUOTE_CHANGED");
    expect(checkAcceptedQuote(token, [K2], NOW, facts())).toBe("QUOTE_CHANGED");
  });
});
