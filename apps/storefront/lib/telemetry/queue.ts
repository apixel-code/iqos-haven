import { MAX_EVENTS_PER_BATCH, type BrowsingEvent } from "@ih/contracts";

/**
 * Storefront telemetry queue (roadmap step 104, ADR 0070). Best effort by design:
 * - events wait in memory (never device storage) and leave in batches of at most 20;
 * - a full queue drops new events, a refused batch is dropped, and a failed send is tried once
 *   more with the same event IDs (the API counts a resend once);
 * - 429 or 503 pauses sending for a minute and drops what waits, so a struggling API is left
 *   alone;
 * - nothing here is awaited by the shop, and on checkout and confirmation pages nothing is
 *   recorded or sent at all.
 */
export type EventInput = BrowsingEvent extends infer E
  ? E extends { id: string }
    ? Omit<E, "id">
    : never
  : never;
export type SendOutcome = "ok" | "retry" | "drop" | "overloaded";
export interface TelemetryOptions {
  send: (batch: BrowsingEvent[], keepalive: boolean) => Promise<SendOutcome>;
  newId: () => string;
  now: () => number;
  /** Whether events may be recorded and sent right now (false on checkout pages). */
  enabled: () => boolean;
  /** Share of each type kept (0–1); 1 at launch. */
  sample?: Partial<Record<EventInput["type"], number>>;
  random?: () => number;
  maxQueue?: number;
}
export const PAUSE_MS = 60_000;

export function createTelemetry(options: TelemetryOptions) {
  const maxQueue = options.maxQueue ?? 100;
  // Sampling only; a cryptographic source because plain Math.random is banned project-wide.
  const random = options.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32);
  let queue: Array<{ event: BrowsingEvent; attempts: number }> = [];
  let pausedUntil = 0;
  let sending = false;
  let dropped = 0;

  function track(input: EventInput): void {
    if (!options.enabled()) return;
    const rate = options.sample?.[input.type] ?? 1;
    if (rate < 1 && random() >= rate) return;
    if (queue.length >= maxQueue || options.now() < pausedUntil) {
      dropped += 1;
      return;
    }
    queue.push({ event: { ...input, id: options.newId() } as BrowsingEvent, attempts: 0 });
  }

  /** Sends one batch; resolves when it is settled. Never throws. */
  async function flush(keepalive = false): Promise<void> {
    if (sending || !queue.length) return;
    // Entering a quiet page (checkout) drops what waits: nothing is sent from there.
    if (!options.enabled()) {
      dropped += queue.length;
      queue = [];
      return;
    }
    if (options.now() < pausedUntil) {
      dropped += queue.length;
      queue = [];
      return;
    }
    sending = true;
    const batch = queue.splice(0, MAX_EVENTS_PER_BATCH);
    try {
      let outcome: SendOutcome;
      try {
        outcome = await options.send(
          batch.map((item) => item.event),
          keepalive,
        );
      } catch {
        outcome = "retry";
      }
      if (outcome === "retry") {
        const again = batch.filter((item) => item.attempts < 1);
        dropped += batch.length - again.length;
        queue.unshift(...again.map((item) => ({ ...item, attempts: item.attempts + 1 })));
      } else if (outcome === "overloaded") {
        pausedUntil = options.now() + PAUSE_MS;
        dropped += batch.length + queue.length;
        queue = [];
      } else if (outcome === "drop") dropped += batch.length;
    } finally {
      sending = false;
    }
  }

  return {
    track,
    flush,
    /** For tests and diagnostics. */
    state: () => ({ queued: queue.length, dropped, pausedUntil }),
  };
}

/** What an HTTP answer means for the batch. */
export function outcomeOf(status: number): SendOutcome {
  if (status === 202) return "ok";
  if (status === 429 || status === 503) return "overloaded";
  if (status >= 500) return "retry";
  return "drop";
}

/** The device's rotating anonymous ID: a random UUID replaced after 24 hours. */
export const ANON_STORAGE_KEY = "ih_anon_v1";
export const ANON_LIFETIME_MS = 24 * 60 * 60_000;
export function anonymousIdFrom(
  stored: string | null,
  now: number,
  newId: () => string,
): { id: string; save: string | null } {
  try {
    const parsed = JSON.parse(stored ?? "null") as { id?: unknown; at?: unknown } | null;
    if (
      parsed &&
      typeof parsed.id === "string" &&
      /^[0-9a-f-]{36}$/i.test(parsed.id) &&
      typeof parsed.at === "number" &&
      now - parsed.at >= 0 &&
      now - parsed.at < ANON_LIFETIME_MS
    )
      return { id: parsed.id, save: null };
  } catch {
    // Unreadable: start a new one.
  }
  const id = newId();
  return { id, save: JSON.stringify({ id, at: now }) };
}

/** Pages where nothing is recorded or sent: checkout and its confirmation (and review links). */
export function isQuietPath(pathname: string): boolean {
  return /^\/(checkout|order-confirmation|review)(\/|$)/.test(pathname);
}
