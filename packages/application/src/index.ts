/**
 * Application layer: use cases orchestrate domain rules inside one transaction.
 * Use cases receive ports (interfaces) — never import apps or framework code here.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Who is acting and how to correlate it. Passed into every command for audit. */
export interface CommandContext {
  readonly requestId: string;
  readonly actorId: string | null;
  readonly commandId?: string;
}
export * from "./audit";
export * from "./events";
export * from "./effects";
