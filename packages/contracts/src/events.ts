import { z } from "zod";

/**
 * Domain event catalogue (architecture §8). Delivery is at least once.
 *
 * `consumers` is the REQUIRED set snapshotted into `consumer_effects` when an event is written;
 * the event completes only when each of those effects is completed or skipped with a reason.
 * A consumer moves from `plannedConsumers` into `consumers` in the roadmap step that implements
 * its handler, together with an explicit replay/backfill decision for already-written events.
 * Never add a consumer here without that decision: it would redefine completion of old events.
 *
 * Payloads carry IDs (and non-personal enums) only. Consumers load authorized data themselves.
 */

export const CONSUMERS = [
  "system_probe",
  "notification",
  "email",
  "analytics_rollup",
  "storefront_revalidate",
  "media_processor",
  "report_builder",
] as const;
export type ConsumerName = (typeof CONSUMERS)[number];

export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const AGGREGATE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Serialized payload bound; mirrors the `outbox_events_payload_ck` CHECK (bytes). */
export const MAX_EVENT_PAYLOAD_BYTES = 4096;

const id = z.uuid();
const orderStatus = z.enum([
  "pending",
  "confirmed",
  "processing",
  "out_for_delivery",
  "delivered",
  "cancelled",
]);

interface EventDefinition<P extends z.ZodType> {
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly payload: P;
  readonly consumers: readonly ConsumerName[];
  /** Documentation of future wiring, as `consumer: roadmap step`. Not snapshotted. */
  readonly plannedConsumers: Readonly<Partial<Record<ConsumerName, number>>>;
}

const define = <P extends z.ZodType>(definition: EventDefinition<P>) => definition;

export const EVENT_CATALOGUE = {
  /** Synthetic event for the Milestone 2 gate and operational smoke checks. */
  "system.probe": define({
    schemaVersion: 1,
    aggregateType: "system",
    payload: z.strictObject({ probeId: id }),
    consumers: ["system_probe"],
    plannedConsumers: {},
  }),
  "order.created": define({
    schemaVersion: 1,
    aggregateType: "order",
    payload: z.strictObject({ orderId: id }),
    consumers: [],
    plannedConsumers: { notification: 78, email: 78, analytics_rollup: 106 },
  }),
  "order.updated": define({
    schemaVersion: 1,
    aggregateType: "order",
    payload: z.strictObject({ orderId: id }),
    consumers: [],
    plannedConsumers: { analytics_rollup: 106 },
  }),
  "order.status_changed": define({
    schemaVersion: 1,
    aggregateType: "order",
    payload: z.strictObject({ orderId: id, from: orderStatus, to: orderStatus }),
    consumers: [],
    plannedConsumers: { notification: 91, analytics_rollup: 106 },
  }),
  "order.cancelled": define({
    schemaVersion: 1,
    aggregateType: "order",
    payload: z.strictObject({ orderId: id }),
    consumers: [],
    plannedConsumers: { notification: 91, analytics_rollup: 106 },
  }),
  "order.collection_recorded": define({
    schemaVersion: 1,
    aggregateType: "order",
    payload: z.strictObject({ orderId: id }),
    consumers: [],
    plannedConsumers: { analytics_rollup: 106 },
  }),
  "inventory.low": define({
    schemaVersion: 1,
    aggregateType: "variant",
    payload: z.strictObject({ variantId: id }),
    consumers: [],
    plannedConsumers: { notification: 92, email: 92 },
  }),
  "catalog.changed": define({
    schemaVersion: 1,
    aggregateType: "catalog",
    payload: z.strictObject({
      entityType: z.enum(["brand", "category", "product", "variant"]),
      entityId: id,
    }),
    consumers: [],
    plannedConsumers: { storefront_revalidate: 52 },
  }),
  "content.published": define({
    schemaVersion: 1,
    aggregateType: "content",
    payload: z.strictObject({ contentId: id }),
    consumers: [],
    plannedConsumers: { storefront_revalidate: 97 },
  }),
  "review.submitted": define({
    schemaVersion: 1,
    aggregateType: "review",
    payload: z.strictObject({ reviewId: id }),
    consumers: [],
    plannedConsumers: { notification: 94 },
  }),
  "media.uploaded": define({
    schemaVersion: 1,
    aggregateType: "media_asset",
    payload: z.strictObject({ mediaAssetId: id }),
    consumers: [],
    plannedConsumers: { media_processor: 49 },
  }),
  "report.requested": define({
    schemaVersion: 1,
    aggregateType: "report_job",
    payload: z.strictObject({ reportJobId: id }),
    consumers: [],
    plannedConsumers: { report_builder: 112 },
  }),
} as const;

export type EventType = keyof typeof EVENT_CATALOGUE;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_CATALOGUE)[T]["payload"]>;

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_CATALOGUE, value);
}

/** Validated event ready for the outbox writer (step 20). */
export interface DomainEvent<T extends EventType = EventType> {
  readonly type: T;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion?: number;
  readonly payload: EventPayload<T>;
  readonly consumers: readonly ConsumerName[];
}

/**
 * Builds an event from the catalogue: strict payload, bounded size, current schema version and
 * the required consumer snapshot. Throws on any contract violation.
 */
export function defineEvent<T extends EventType>(
  type: T,
  aggregateId: string,
  payload: EventPayload<T>,
  aggregateVersion?: number,
): DomainEvent<T> {
  const definition = EVENT_CATALOGUE[type];
  const parsed = definition.payload.parse(payload) as EventPayload<T>;
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_EVENT_PAYLOAD_BYTES)
    throw new RangeError("Event payload too large");
  if (!aggregateId || aggregateId.length > 128) throw new RangeError("Invalid aggregate ID");
  if (
    aggregateVersion !== undefined &&
    (!Number.isSafeInteger(aggregateVersion) || aggregateVersion < 0)
  )
    throw new RangeError("Invalid aggregate version");
  return {
    type,
    schemaVersion: definition.schemaVersion,
    aggregateType: definition.aggregateType,
    aggregateId,
    ...(aggregateVersion === undefined ? {} : { aggregateVersion }),
    payload: parsed,
    consumers: [...definition.consumers],
  };
}

/**
 * Stable queue job IDs for one effect. They reduce duplicate jobs while a job exists; the
 * UNIQUE (event_id, consumer) row remains the durable deduplication key.
 * BullMQ rejects custom IDs containing ":" (except its legacy 3-part form), so IDs use "-".
 */
export function effectJobId(eventId: string, consumer: ConsumerName): string {
  return jobId(["effect", eventId, consumer]);
}

/** Delayed retry of attempt `attempt`: one job per attempt, deduplicated across runners. */
export function effectRetryJobId(eventId: string, consumer: ConsumerName, attempt: number): string {
  return jobId(["effect", eventId, consumer, "retry", String(attempt)]);
}

/** Reconciler re-enqueue in time bucket `bucket`: replicas in the same bucket deduplicate. */
export function effectReconcileJobId(
  eventId: string,
  consumer: ConsumerName,
  bucket: number,
): string {
  return jobId(["effect", eventId, consumer, "rc", String(bucket)]);
}

function jobId(parts: readonly string[]): string {
  const id = parts.join("-");
  if (id.includes(":")) throw new RangeError("Invalid queue job ID");
  return id;
}
