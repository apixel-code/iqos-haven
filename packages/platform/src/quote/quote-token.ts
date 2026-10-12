import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Accepted-quote token (roadmap step 71, ADR 0041). The API shows a shopper a total and hands
 * back a short-lived token over the facts that total was built from. Placing the order sends
 * the token back; the server recomputes the facts under its locks and creates the order only
 * if they are the ones the shopper accepted. The token proves the server issued that total
 * recently; it carries no price the server then trusts.
 */
export interface QuoteKey {
  readonly keyId: string;
  /** base64url, at least 32 bytes. Independent of every other purpose key. */
  readonly secret: string;
}
/** Everything the shopper is charged for, and nothing else. */
export interface QuoteFacts {
  areaId: string;
  deliveryFeeFils: number;
  couponCode: string | null;
  couponPercentBps: number;
  merchandiseSubtotalFils: number;
  discountFils: number;
  totalFils: number;
  lines: ReadonlyArray<{ variantId: string; quantity: number; unitPriceFils: number }>;
}
const whole = (value: number) => {
  if (!Number.isSafeInteger(value)) throw new RangeError("Quote facts must be integers");
  return value;
};
/**
 * One stable value for a set of facts. Arrays only (no object key order), lines sorted by
 * variant ID, IDs and code in a fixed case. A change of any amount, quantity, area or coupon
 * changes it; a change that does not alter what is charged (a description edit) does not.
 */
export function quoteFingerprint(facts: QuoteFacts): string {
  const lines = [...facts.lines]
    .map(
      (line) =>
        [line.variantId.toLowerCase(), whole(line.quantity), whole(line.unitPriceFils)] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = JSON.stringify([
    "ih:quote:v1",
    facts.areaId.toLowerCase(),
    whole(facts.deliveryFeeFils),
    facts.couponCode,
    whole(facts.couponPercentBps),
    whole(facts.merchandiseSubtotalFils),
    whole(facts.discountFils),
    whole(facts.totalFils),
    lines,
  ]);
  return createHash("sha256").update(canonical).digest("base64url");
}
const mac = (key: QuoteKey, expires: number, fingerprint: string) =>
  createHmac("sha256", Buffer.from(key.secret, "base64url"))
    .update(`ih:quote-token:v1:${key.keyId}:${expires}:${fingerprint}`)
    .digest("base64url");
/** `v1.<keyId>.<expiry, epoch seconds>.<fingerprint>.<mac>`, signed with the first key. */
export function signQuote(fingerprint: string, expiresAt: Date, key: QuoteKey): string {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  return `v1.${key.keyId}.${expires}.${fingerprint}.${mac(key, expires, fingerprint)}`;
}
export type QuoteTokenResult =
  | { ok: true; fingerprint: string; expiresAt: Date }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "expired" };
const TOKEN = /^v1\.([A-Za-z0-9_-]{1,64})\.(\d{10})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
export function verifyQuote(token: string, keys: readonly QuoteKey[], now: Date): QuoteTokenResult {
  const match = typeof token === "string" && token.length <= 256 ? TOKEN.exec(token) : null;
  if (!match) return { ok: false, reason: "malformed" };
  const [, keyId, expiry, fingerprint, signature] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  const key = keys.find((candidate) => candidate.keyId === keyId);
  if (!key) return { ok: false, reason: "unknown_key" };
  const expires = Number(expiry);
  const expected = Buffer.from(mac(key, expires, fingerprint));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, reason: "bad_signature" };
  if (now.getTime() >= expires * 1000) return { ok: false, reason: "expired" };
  return { ok: true, fingerprint, expiresAt: new Date(expires * 1000) };
}
/**
 * The order-time decision: was this exactly the total the shopper accepted, recently enough?
 * `current` is recomputed by the server inside the order transaction. Anything wrong with the
 * token other than age (forged, unknown key, malformed) is treated as a changed quote: the
 * shopper is shown the current total and must accept it.
 */
export function checkAcceptedQuote(
  token: string,
  keys: readonly QuoteKey[],
  now: Date,
  current: QuoteFacts,
): "ACCEPTED" | "QUOTE_EXPIRED" | "QUOTE_CHANGED" {
  const verified = verifyQuote(token, keys, now);
  if (!verified.ok) return verified.reason === "expired" ? "QUOTE_EXPIRED" : "QUOTE_CHANGED";
  return verified.fingerprint === quoteFingerprint(current) ? "ACCEPTED" : "QUOTE_CHANGED";
}
