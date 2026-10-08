import type { ConsumerName } from "@ih/contracts";

/** Queue names. Jobs are disposable copies of durable outbox/effect rows (roadmap steps 19–24). */
export const QUEUES = {
  system: "ih-system",
} as const;

/** One queue per consumer so a slow or failing consumer (e.g. email) never blocks others. */
export function effectQueueName(consumer: ConsumerName): string {
  return "ih-effect-" + consumer.replaceAll("_", "-");
}

/** Effect job data: IDs only. Consumers load authorized data from the database. */
export interface EffectJobData {
  readonly eventId: string;
  readonly effectId: string;
  readonly consumer: ConsumerName;
}
