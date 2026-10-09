import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Private service-to-service authentication (architecture §10 "Internal": private network plus
 * service auth; never an admin/shopper cookie). Each caller signs:
 *   v1 \n METHOD \n path?query \n timestamp \n nonce \n sha256(body)
 * with HMAC-SHA256 under a per-caller key id. Verifiers accept a ±30 s clock window and reject
 * reused nonces inside it.
 */
export const SERVICE_AUTH_HEADERS = {
  service: "x-ih-service",
  keyId: "x-ih-key-id",
  timestamp: "x-ih-timestamp",
  nonce: "x-ih-nonce",
  signature: "x-ih-signature",
} as const;

export const MAX_CLOCK_SKEW_MS = 30_000;
const VERSION = "v1";

export interface ServiceKey {
  readonly service: string;
  readonly keyId: string;
  /** base64url secret, ≥ 32 bytes once decoded (validated by @ih/config). */
  readonly secret: string;
}

export interface SignedRequest {
  readonly method: string;
  /** Path including the query string, exactly as the server will see it. */
  readonly path: string;
  readonly body?: Uint8Array | string | undefined;
}

function canonical(
  key: Pick<ServiceKey, "service" | "keyId">,
  request: SignedRequest,
  timestamp: string,
  nonce: string,
): string {
  const body = request.body ?? "";
  const bodyHash = createHash("sha256").update(body).digest("hex");
  // Service and key id are signed too (defence in depth beyond the key lookup).
  return [
    VERSION,
    key.service,
    key.keyId,
    request.method.toUpperCase(),
    request.path,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
}

function mac(secret: string, data: string): Buffer {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(data).digest();
}

/** Headers a calling service attaches to one request. */
export function signServiceRequest(
  key: ServiceKey,
  request: SignedRequest,
  now: number = Date.now(),
): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  const nonce = randomBytes(16).toString("base64url");
  return {
    [SERVICE_AUTH_HEADERS.service]: key.service,
    [SERVICE_AUTH_HEADERS.keyId]: key.keyId,
    [SERVICE_AUTH_HEADERS.timestamp]: timestamp,
    [SERVICE_AUTH_HEADERS.nonce]: nonce,
    [SERVICE_AUTH_HEADERS.signature]: mac(
      key.secret,
      canonical(key, request, timestamp, nonce),
    ).toString("base64url"),
  };
}

/**
 * Replay protection: a nonce may be used once within the clock window. Must be shared by every
 * verifying instance in production (RedisNonceStore in the API); the in-memory store is for a
 * single process and tests.
 */
export interface NonceStore {
  /** Atomically records the nonce; false if it was already used (or cannot be recorded). */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

/** Single-process store. When full of live nonces it refuses new ones instead of evicting. */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly maxEntries = 50_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const now = this.clock();
    for (const [stored, expiry] of this.seen) {
      if (expiry > now) break; // insertion order ≈ expiry order (fixed TTL)
      this.seen.delete(stored);
    }
    if (this.seen.has(key)) return false;
    // Evicting a live nonce would make it replayable: fail closed instead.
    if (this.seen.size >= this.maxEntries) return false;
    this.seen.set(key, now + ttlSeconds * 1000);
    return true;
  }
}

export type ServiceAuthFailure =
  | "MISSING_HEADERS"
  | "UNKNOWN_KEY"
  | "SERVICE_NOT_ALLOWED"
  | "STALE_TIMESTAMP"
  | "BAD_SIGNATURE"
  | "REPLAYED_NONCE";

export type ServiceAuthResult =
  | { readonly ok: true; readonly service: string; readonly keyId: string }
  | { readonly ok: false; readonly reason: ServiceAuthFailure };

export interface VerifyOptions {
  readonly keys: readonly ServiceKey[];
  readonly allowedServices: readonly string[];
  readonly nonces: NonceStore;
  readonly now?: number;
}

const header = (headers: Record<string, string | string[] | undefined>, name: string) => {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
};

export async function verifyServiceRequest(
  request: SignedRequest & { headers: Record<string, string | string[] | undefined> },
  options: VerifyOptions,
): Promise<ServiceAuthResult> {
  const now = options.now ?? Date.now();
  const service = header(request.headers, SERVICE_AUTH_HEADERS.service);
  const keyId = header(request.headers, SERVICE_AUTH_HEADERS.keyId);
  const timestamp = header(request.headers, SERVICE_AUTH_HEADERS.timestamp);
  const nonce = header(request.headers, SERVICE_AUTH_HEADERS.nonce);
  const signature = header(request.headers, SERVICE_AUTH_HEADERS.signature);
  if (!service || !keyId || !timestamp || !nonce || !signature)
    return { ok: false, reason: "MISSING_HEADERS" };
  if (!/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
    return { ok: false, reason: "MISSING_HEADERS" };
  const key = options.keys.find((entry) => entry.service === service && entry.keyId === keyId);
  if (!key) return { ok: false, reason: "UNKNOWN_KEY" };
  if (!options.allowedServices.includes(service))
    return { ok: false, reason: "SERVICE_NOT_ALLOWED" };
  const signedAt = Number(timestamp) * 1000;
  if (Math.abs(now - signedAt) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: "STALE_TIMESTAMP" };
  const expected = mac(key.secret, canonical(key, request, timestamp, nonce));
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "BAD_SIGNATURE" };
  // Only a correctly signed request may consume a nonce. Kept for the whole acceptance window
  // (±skew around the signed time), so a replay inside it always finds the nonce.
  let fresh: boolean;
  try {
    fresh = await options.nonces.claim(
      `ih:svc-nonce:${service}:${nonce}`,
      Math.ceil((2 * MAX_CLOCK_SKEW_MS) / 1000) + 1,
    );
  } catch {
    // A store outage must not turn replay protection off.
    fresh = false;
  }
  if (!fresh) return { ok: false, reason: "REPLAYED_NONCE" };
  return { ok: true, service, keyId };
}
