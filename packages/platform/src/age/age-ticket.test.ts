import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGE_COOKIE,
  MAX_AGE_TICKET_TTL_SECONDS,
  ageTicketKeyRing,
  ageTicketPublicKey,
  ageTicketSigner,
  readAgeCookie,
  signAgeTicket,
  verifyAgeTicket,
  type AgeTicketSigner,
} from "./age-ticket";

function newSigner(kid: string): AgeTicketSigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return ageTicketSigner(kid, seed.toString("base64url"));
}
const ringOf = (...signers: AgeTicketSigner[]) =>
  ageTicketKeyRing(signers.map((s) => ({ kid: s.kid, publicKey: ageTicketPublicKey(s) })));
const NOW = Date.UTC(2026, 9, 11, 12);
const DAY = 24 * 60 * 60;
const signer = newSigner("k1");
const keys = ringOf(signer);
const options = { keys, audience: "api", policyVersion: "p1", now: NOW } as const;
const mint = (overrides: Partial<Parameters<typeof signAgeTicket>[1]> = {}, by = signer) =>
  signAgeTicket(by, { policyVersion: "p1", ttlSeconds: 30 * DAY, now: NOW, ...overrides }).ticket;
/** A correctly signed ticket with arbitrary claims, as only a key holder could produce. */
function forge(claims: unknown, by = signer): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(`ih-age-ticket/v1\n${by.kid}\n${payload}`),
    by.privateKey,
  );
  return `v1.${by.kid}.${payload}.${signature.toString("base64url")}`;
}
const iat = Math.floor(NOW / 1000);
const valid = {
  iss: "ih-storefront",
  aud: ["storefront", "api"],
  iat,
  exp: iat + DAY,
  pol: "p1",
  dec: "accepted",
};
const reason = (ticket: string | null, extra: object = {}) => {
  const result = verifyAgeTicket(ticket, { ...options, ...extra });
  return result.ok ? "ok" : result.reason;
};

describe("age ticket", () => {
  it("round-trips for both audiences with fixed issuer, decision, policy and expiry", () => {
    const { ticket, claims } = signAgeTicket(signer, {
      policyVersion: "p1",
      ttlSeconds: 30 * DAY,
      now: NOW,
    });
    expect(claims).toEqual({ ...valid, exp: iat + 30 * DAY });
    for (const audience of ["api", "storefront"] as const)
      expect(verifyAgeTicket(ticket, { ...options, audience })).toEqual({
        ok: true,
        kid: "k1",
        claims,
      });
    // The format carries no algorithm field.
    expect(ticket.split(".")).toHaveLength(4);
    expect(ticket.startsWith("v1.k1.")).toBe(true);
  });

  it("expires exactly at exp and tolerates only bounded clock skew on iat", () => {
    const ticket = mint({ ttlSeconds: 60 });
    expect(reason(ticket, { now: NOW + 59_000 })).toBe("ok");
    expect(reason(ticket, { now: NOW + 60_000 })).toBe("EXPIRED");
    expect(reason(ticket, { now: NOW - 60_000 })).toBe("ok");
    expect(reason(ticket, { now: NOW - 61_000 })).toBe("NOT_YET_VALID");
  });

  it("refuses to sign, and to accept, a lifetime above 30 days", () => {
    expect(() => mint({ ttlSeconds: MAX_AGE_TICKET_TTL_SECONDS + 1 })).toThrow(RangeError);
    expect(() => mint({ ttlSeconds: 0 })).toThrow(RangeError);
    expect(() => mint({ policyVersion: "Bad Policy" })).toThrow(RangeError);
    expect(reason(forge({ ...valid, exp: iat + MAX_AGE_TICKET_TTL_SECONDS + 1 }))).toBe(
      "INVALID_CLAIMS",
    );
    expect(reason(forge({ ...valid, exp: iat }))).toBe("INVALID_CLAIMS");
  });

  it("rejects tampering with any part", () => {
    const ticket = mint();
    const [version, kid, payload, signature] = ticket.split(".") as [
      string,
      string,
      string,
      string,
    ];
    const longer = Buffer.from(JSON.stringify({ ...valid, exp: iat + 400 * DAY })).toString(
      "base64url",
    );
    expect(reason([version, kid, longer, signature].join("."))).toBe("BAD_SIGNATURE");
    const flipped =
      signature.slice(0, -2) + (signature.at(-2) === "A" ? "B" : "A") + signature.at(-1);
    expect(reason([version, kid, payload, flipped].join("."))).toMatch(/BAD_SIGNATURE|MALFORMED/);
    expect(reason(["v2", kid, payload, signature].join("."))).toBe("MALFORMED");
    expect(reason([version, kid, payload].join("."))).toBe("MALFORMED");
    expect(reason(ticket + ".x")).toBe("MALFORMED");
    expect(reason(ticket + "=")).toBe("MALFORMED");
    expect(reason("x".repeat(600))).toBe("MALFORMED");
    expect(reason("")).toBe("MISSING");
    expect(reason(null)).toBe("MISSING");
  });

  it("binds the key id into the signature and only trusts allowlisted keys", () => {
    const other = newSigner("k2");
    const both = ringOf(signer, other);
    const ticket = mint();
    // Relabelling a ticket to another allowlisted key id must not verify.
    expect(reason(ticket.replace("v1.k1.", "v1.k2."), { keys: both })).toBe("BAD_SIGNATURE");
    // A ticket signed by a key the verifier does not list (never provisioned, or revoked).
    expect(reason(mint({}, other))).toBe("UNKNOWN_KEY");
    expect(reason(mint({}, other), { keys: both })).toBe("ok");
    // An attacker's own key under a known key id fails the signature.
    expect(reason(mint({}, newSigner("k1")))).toBe("BAD_SIGNATURE");
    expect(reason(ticket, { keys: ageTicketKeyRing([]) })).toBe("UNKNOWN_KEY");
  });

  it("supports rotation: old tickets verify until the old public key is retired", () => {
    const next = newSigner("k2");
    const old = mint();
    const overlap = ringOf(signer, next);
    expect(reason(old, { keys: overlap })).toBe("ok");
    expect(reason(mint({}, next), { keys: overlap })).toBe("ok");
    expect(reason(old, { keys: ringOf(next) })).toBe("UNKNOWN_KEY");
  });

  it("requires the audience, the current policy and exact claims, even when correctly signed", () => {
    expect(reason(forge({ ...valid, aud: ["storefront"] }))).toBe("WRONG_AUDIENCE");
    expect(reason(mint({ policyVersion: "p0" }))).toBe("POLICY_CHANGED");
    for (const bad of [
      { ...valid, dec: "rejected" },
      { ...valid, iss: "someone-else" },
      { ...valid, aud: ["api", "admin"] },
      { ...valid, aud: "api" },
      { ...valid, aud: [] },
      { ...valid, iat: "now" },
      { ...valid, exp: 1.5 },
      { ...valid, extra: true },
      { iss: valid.iss, aud: valid.aud, iat, exp: valid.exp, pol: "p1" },
      [valid],
      "accepted",
    ])
      expect(reason(forge(bad)), JSON.stringify(bad)).toBe("INVALID_CLAIMS");
  });

  it("validates key material and refuses duplicate key ids", () => {
    const publicKey = ageTicketPublicKey(signer);
    expect(Buffer.from(publicKey, "base64url")).toHaveLength(32);
    expect(() =>
      ageTicketKeyRing([
        { kid: "k1", publicKey },
        { kid: "k1", publicKey },
      ]),
    ).toThrow(RangeError);
    expect(() => ageTicketKeyRing([{ kid: "bad kid", publicKey }])).toThrow(RangeError);
    expect(() => ageTicketKeyRing([{ kid: "k1", publicKey: "short" }])).toThrow(RangeError);
    expect(() => ageTicketSigner("k1", "c2hvcnQ")).toThrow(RangeError);
  });
});

describe("age cookie", () => {
  it("reads the single ih_age value among other cookies", () => {
    expect(readAgeCookie(`a=1; ${AGE_COOKIE}=ticket; __Host-ih_admin=x`)).toBe("ticket");
    expect(readAgeCookie("a=1")).toBeNull();
    expect(readAgeCookie(undefined)).toBeNull();
    expect(readAgeCookie(`${AGE_COOKIE}=`)).toBeNull();
    expect(readAgeCookie(`x${AGE_COOKIE}=ticket`)).toBeNull();
  });

  it("treats conflicting or oversized values as no cookie", () => {
    expect(readAgeCookie(`${AGE_COOKIE}=one; ${AGE_COOKIE}=two`)).toBeNull();
    expect(readAgeCookie(`${AGE_COOKIE}=same; ${AGE_COOKIE}=same`)).toBe("same");
    expect(readAgeCookie(`${AGE_COOKIE}=${"x".repeat(513)}`)).toBeNull();
  });
});
