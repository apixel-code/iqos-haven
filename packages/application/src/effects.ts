import type { ConsumerName } from "@ih/contracts";

/** Everything a consumer may know about its effect. Payload is the event's IDs-only payload. */
export interface EffectContext {
  readonly eventId: string;
  readonly effectId: string;
  readonly consumer: ConsumerName;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  /** 1-based attempt number of this effect. */
  readonly attempt: number;
}

/**
 * Database consumer: `apply` runs inside the completion transaction, so its writes and the
 * effect's completion commit together (architecture §8). It must perform no network I/O.
 */
export interface DatabaseEffectHandler<TTx> {
  readonly kind: "database";
  readonly consumer: ConsumerName;
  readonly maxAttempts?: number;
  apply(tx: TTx, context: EffectContext): Promise<void>;
}

/**
 * External consumer (e.g. email): `perform` runs outside any transaction while the lease is
 * heartbeated, then the receipt and completion are recorded together. If that record is lost,
 * a retry may repeat the external call: use provider idempotency keys where supported.
 */
export interface ExternalEffectHandler {
  readonly kind: "external";
  readonly consumer: ConsumerName;
  readonly maxAttempts?: number;
  perform(context: EffectContext, signal: AbortSignal): Promise<{ receipt?: string }>;
}

export type EffectHandler<TTx> = DatabaseEffectHandler<TTx> | ExternalEffectHandler;

function errorCode(code: string): string {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) throw new RangeError("Invalid effect error code");
  return code;
}

/** Throw for failures retrying cannot fix (invalid payload, rejected recipient). Goes to dead. */
export class PermanentEffectError extends Error {
  /** Persisted as `last_error`, so it must be a code, never a message. */
  constructor(readonly code: string) {
    super(errorCode(code));
  }
}
