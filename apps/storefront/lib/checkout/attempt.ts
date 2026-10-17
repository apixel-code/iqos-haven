/**
 * The checkout attempt key (roadmap step 80, architecture §7 step 1). One random key names one
 * attempt to place an order: it is sent as `Idempotency-Key`, so pressing "Place order" again,
 * a refresh or a lost answer can never make a second order. It is kept on the device with the
 * time it was made, and nothing else is: no name, phone, address, total or token.
 * A new key is made only after an acknowledged order or when the shopper starts a new order.
 */
export const ATTEMPT_STORAGE_KEY = "ih_checkout_attempt_v1";
const KEY = /^[A-Za-z0-9_-]{43}$/;

export interface Attempt {
  key: string;
  createdAt: string;
}
/** The stored attempt, or null for anything that is not exactly one (never repaired). */
export function parseAttempt(text: string | null): Attempt | null {
  if (!text || text.length > 200) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object") return null;
    const { key, createdAt } = value as Record<string, unknown>;
    if (typeof key !== "string" || !KEY.test(key)) return null;
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
    return { key, createdAt };
  } catch {
    return null;
  }
}
/** 256 random bits, URL-safe. */
export function newAttempt(now: Date, random: (bytes: Uint8Array) => Uint8Array): Attempt {
  const bytes = random(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const key = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { key, createdAt: now.toISOString() };
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/**
 * Reads the attempt from the first store that has one, or makes one and writes it to the first
 * store that accepts it. Local storage first; session storage (which still survives a reload)
 * when local storage is refused. `memory` is used only when no store works at all: the attempt
 * then lives for this page, and a reload after a lost answer is not protected.
 */
export function attemptFrom(
  stores: ReadonlyArray<() => Store>,
  memory: Attempt | null,
  make: () => Attempt,
): { attempt: Attempt; stored: boolean } {
  let readable = false;
  for (const open of stores) {
    try {
      const found = parseAttempt(open().getItem(ATTEMPT_STORAGE_KEY));
      readable = true;
      if (found) return { attempt: found, stored: true };
    } catch {
      // This store is blocked; try the next.
    }
  }
  // A store that can be read and holds nothing means no attempt is open (another tab may have
  // just finished it): a remembered key is used only when nothing could be read.
  const attempt = (!readable && memory) || make();
  for (const open of stores) {
    try {
      open().setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
      return { attempt, stored: true };
    } catch {
      // Blocked or full; try the next.
    }
  }
  return { attempt, stored: false };
}
const STORES = [() => window.localStorage, () => window.sessionStorage];
let memory: Attempt | null = null;
/** The current attempt, made and stored on first use. Browser only. */
export function currentAttempt(): Attempt {
  const { attempt } = attemptFrom(STORES, memory, () =>
    newAttempt(new Date(), (bytes) => crypto.getRandomValues(bytes)),
  );
  return (memory = attempt);
}
/** Ends the attempt: after an acknowledged order, or when the shopper asks for another order. */
export function endAttempt(): void {
  memory = null;
  for (const open of STORES) {
    try {
      open().removeItem(ATTEMPT_STORAGE_KEY);
    } catch {
      // Nothing was stored there.
    }
  }
}
