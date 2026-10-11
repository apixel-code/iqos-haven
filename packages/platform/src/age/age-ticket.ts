import {
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * Age ticket (architecture §9 "Age gate" and "Age-ticket keys and rotation", ADR 0024).
 *
 * Format: `v1.<kid>.<payload>.<signature>`, base64url parts. The signature is Ed25519 over
 * `ih-age-ticket/v1\n<kid>\n<payload>`. There is no algorithm field: the algorithm is fixed by
 * the format version, so a token cannot ask for a weaker one. Keys are found only by `kid` in the
 * verifier's own allowlist; nothing in a token can point at another key.
 *
 * Only the storefront acceptance handler holds a private key and calls `signAgeTicket`. Every
 * verifier (storefront routing gate, API `AgeGuard`) holds public keys only.
 *
 * This file has no dependencies beyond node:crypto so the storefront can import it through
 * `@ih/platform/age-ticket` without loading storage or image code.
 */
export const AGE_COOKIE = "ih_age";
export const AGE_TICKET_ISSUER = "ih-storefront";
export const AGE_TICKET_AUDIENCES = ["storefront", "api"] as const;
export type AgeTicketAudience = (typeof AGE_TICKET_AUDIENCES)[number];
/** Hard ceiling on a ticket's lifetime, whatever the configured duration is. */
export const MAX_AGE_TICKET_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AGE_TICKET_CLOCK_SKEW_SECONDS = 60;
const MAX_TICKET_LENGTH = 512;
const VERSION = "v1";
const DOMAIN = "ih-age-ticket/v1";
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const POLICY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
// DER prefixes for a raw 32-byte Ed25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface AgeTicketClaims {
  readonly iss: typeof AGE_TICKET_ISSUER;
  readonly aud: readonly AgeTicketAudience[];
  /** Seconds since the epoch. */
  readonly iat: number;
  readonly exp: number;
  /** Version of the age policy the shopper affirmed (business input BI-04). */
  readonly pol: string;
  readonly dec: "accepted";
}

export interface AgeTicketSigner {
  readonly kid: string;
  readonly privateKey: KeyObject;
}
/** Allowlisted verification keys by key id. A revoked key is simply absent. */
export type AgeTicketKeyRing = ReadonlyMap<string, KeyObject>;

function raw32(value: string, what: string): Buffer {
  if (!B64URL.test(value)) throw new RangeError(`${what} must be base64url`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value)
    throw new RangeError(`${what} must be a raw 32-byte Ed25519 key in canonical base64url`);
  return bytes;
}

/** Private signing key from its raw 32-byte seed (base64url). Storefront acceptance handler only. */
export function ageTicketSigner(kid: string, seed: string): AgeTicketSigner {
  if (!KID_PATTERN.test(kid)) throw new RangeError("Invalid age-ticket key id");
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw32(seed, "Age-ticket private key")]),
    format: "der",
    type: "pkcs8",
  });
  return { kid, privateKey };
}

/** Verification key ring from `kid:base64urlPublicKey` entries. Duplicate key ids are refused. */
export function ageTicketKeyRing(
  entries: ReadonlyArray<{ kid: string; publicKey: string }>,
): AgeTicketKeyRing {
  const ring = new Map<string, KeyObject>();
  for (const entry of entries) {
    if (!KID_PATTERN.test(entry.kid)) throw new RangeError("Invalid age-ticket key id");
    if (ring.has(entry.kid)) throw new RangeError("Duplicate age-ticket key id");
    ring.set(
      entry.kid,
      createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, raw32(entry.publicKey, "Age-ticket public key")]),
        format: "der",
        type: "spki",
      }),
    );
  }
  return ring;
}

/** The raw public key (base64url) of a signer, for provisioning verifiers. */
export function ageTicketPublicKey(signer: AgeTicketSigner): string {
  const spki = createPublicKey(signer.privateKey).export({ format: "der", type: "spki" });
  return spki.subarray(SPKI_PREFIX.length).toString("base64url");
}

const signingInput = (kid: string, payload: string) => Buffer.from(`${DOMAIN}\n${kid}\n${payload}`);

/** Mints a ticket for an explicit acceptance. `ttlSeconds` is capped at 30 days. */
export function signAgeTicket(
  signer: AgeTicketSigner,
  options: { policyVersion: string; ttlSeconds: number; now?: number },
): { ticket: string; claims: AgeTicketClaims } {
  if (!POLICY_PATTERN.test(options.policyVersion)) throw new RangeError("Invalid policy version");
  if (
    !Number.isInteger(options.ttlSeconds) ||
    options.ttlSeconds < 1 ||
    options.ttlSeconds > MAX_AGE_TICKET_TTL_SECONDS
  )
    throw new RangeError("Age-ticket lifetime must be between 1 second and 30 days");
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const claims: AgeTicketClaims = {
    iss: AGE_TICKET_ISSUER,
    aud: AGE_TICKET_AUDIENCES,
    iat,
    exp: iat + options.ttlSeconds,
    pol: options.policyVersion,
    dec: "accepted",
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign(null, signingInput(signer.kid, payload), signer.privateKey);
  return {
    ticket: `${VERSION}.${signer.kid}.${payload}.${signature.toString("base64url")}`,
    claims,
  };
}

export type AgeTicketFailure =
  | "MISSING"
  | "MALFORMED"
  | "UNKNOWN_KEY"
  | "BAD_SIGNATURE"
  | "INVALID_CLAIMS"
  | "WRONG_AUDIENCE"
  | "POLICY_CHANGED"
  | "NOT_YET_VALID"
  | "EXPIRED";
export type AgeTicketResult =
  | { readonly ok: true; readonly kid: string; readonly claims: AgeTicketClaims }
  | { readonly ok: false; readonly reason: AgeTicketFailure };

export interface AgeTicketVerifyOptions {
  readonly keys: AgeTicketKeyRing;
  readonly audience: AgeTicketAudience;
  /** The policy in force; a ticket for another version must pass the gate again. */
  readonly policyVersion: string;
  readonly now?: number;
}

function parseClaims(payload: string): AgeTicketClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  const { iss, aud, iat, exp, pol, dec } = claims;
  if (Object.keys(claims).length !== 6) return null;
  if (iss !== AGE_TICKET_ISSUER || dec !== "accepted") return null;
  if (typeof pol !== "string" || !POLICY_PATTERN.test(pol)) return null;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return null;
  if (
    !Array.isArray(aud) ||
    aud.length < 1 ||
    aud.length > AGE_TICKET_AUDIENCES.length ||
    !aud.every((item) => (AGE_TICKET_AUDIENCES as readonly unknown[]).includes(item))
  )
    return null;
  return {
    iss,
    aud: aud as AgeTicketAudience[],
    iat: iat as number,
    exp: exp as number,
    pol,
    dec,
  };
}

/**
 * Verifies a ticket for one audience. Order: shape → allowlisted key → signature → claims. No
 * claim is trusted, or even parsed, before the signature has been verified.
 */
export function verifyAgeTicket(
  ticket: string | null | undefined,
  options: AgeTicketVerifyOptions,
): AgeTicketResult {
  if (!ticket) return { ok: false, reason: "MISSING" };
  if (ticket.length > MAX_TICKET_LENGTH) return { ok: false, reason: "MALFORMED" };
  const parts = ticket.split(".");
  if (parts.length !== 4) return { ok: false, reason: "MALFORMED" };
  const [version, kid, payload, signature] = parts as [string, string, string, string];
  if (version !== VERSION || !KID_PATTERN.test(kid) || !B64URL.test(payload))
    return { ok: false, reason: "MALFORMED" };
  if (!B64URL.test(signature)) return { ok: false, reason: "MALFORMED" };
  const signatureBytes = Buffer.from(signature, "base64url");
  // Canonical encoding only: a re-encoded copy of a valid ticket is not another valid ticket.
  if (
    signatureBytes.length !== 64 ||
    !timingSafeEqual(Buffer.from(signatureBytes.toString("base64url")), Buffer.from(signature))
  )
    return { ok: false, reason: "MALFORMED" };
  const key = options.keys.get(kid);
  if (!key) return { ok: false, reason: "UNKNOWN_KEY" };
  if (!verify(null, signingInput(kid, payload), key, signatureBytes))
    return { ok: false, reason: "BAD_SIGNATURE" };
  const claims = parseClaims(payload);
  if (!claims) return { ok: false, reason: "INVALID_CLAIMS" };
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_AGE_TICKET_TTL_SECONDS)
    return { ok: false, reason: "INVALID_CLAIMS" };
  if (!claims.aud.includes(options.audience)) return { ok: false, reason: "WRONG_AUDIENCE" };
  if (claims.pol !== options.policyVersion) return { ok: false, reason: "POLICY_CHANGED" };
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.iat > now + AGE_TICKET_CLOCK_SKEW_SECONDS)
    return { ok: false, reason: "NOT_YET_VALID" };
  if (claims.exp <= now) return { ok: false, reason: "EXPIRED" };
  return { ok: true, kid, claims };
}

/**
 * The single value of the age cookie, or null. More than one distinct value is treated as none
 * (a planted second cookie must not be able to win), and oversized values are ignored.
 */
export function readAgeCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  let found: string | null = null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== AGE_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    if (!value || value.length > MAX_TICKET_LENGTH) return null;
    if (found !== null && found !== value) return null;
    found = value;
  }
  return found;
}
