import { DUBAI_UTC_OFFSET_MINUTES } from "./schedule";

/**
 * Financial metric definitions (roadmap step 105, ADR 0071; architecture §14). Three money
 * bases are never mixed: booked (by placement day), delivered (by delivery day) and collected
 * (by the day cash was collected, the latest record in effect). Days are Asia/Dubai calendar
 * days; amounts are integer fils (AED). Prices are final as entered: there is no separate VAT
 * or excise line (ADR 0036). Bump the version when a definition changes.
 */
export const METRIC_DEFINITION_VERSION = 1;
export const METRIC_TIMEZONE = "Asia/Dubai";
export const METRIC_CURRENCY = "AED";
export const TAX_NOTE =
  "Prices are final as entered and include any tax; no separate VAT or excise is calculated.";
export const MAX_METRIC_RANGE_DAYS = 366;

export const METRIC_DEFINITIONS = {
  booked: {
    label: "Booked sales",
    dateBasis: "placed (order created), Dubai day",
    definition:
      "Orders placed in the range. Merchandise net = items after discount; delivery shown separately. Split by current state: active (not cancelled) and cancelled.",
  },
  delivered: {
    label: "Delivered sales",
    dateBasis: "delivered, Dubai day",
    definition:
      "Orders delivered in the range. Merchandise net = items after discount; delivery shown separately. Delivered is not collected.",
  },
  collected: {
    label: "Collected cash",
    dateBasis: "cash collected, Dubai day (latest record in effect after corrections)",
    definition:
      "Cash recorded as collected in the range: the amount and time of each order's latest collection record. A reconciliation measure.",
  },
  aov: {
    label: "Average order value",
    dateBasis: "same as the measure it divides",
    definition:
      "The order total (merchandise net plus delivery; collected: the cash amount) divided by the orders the basis counts, rounded half-up to the fil. Shown per basis; none when no order is counted.",
  },
  cancellationRate: {
    label: "Cancellation rate",
    dateBasis: "placed, Dubai day (placement cohort)",
    definition:
      "Orders placed in the range that are cancelled now, divided by orders placed in the range.",
  },
} as const;

export class MetricRangeError extends Error {}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60_000;

/**
 * The UTC instants that bound Dubai calendar days `from`..`to` (inclusive): `start` is
 * `from` 00:00 Dubai, `end` is the day after `to` 00:00 Dubai (exclusive).
 */
export function dubaiDayRange(from: string, to: string): { start: Date; end: Date; days: number } {
  const startUtc = ISO_DATE.test(from) ? Date.parse(from + "T00:00:00Z") : NaN;
  const toUtc = ISO_DATE.test(to) ? Date.parse(to + "T00:00:00Z") : NaN;
  if (
    !Number.isFinite(startUtc) ||
    !Number.isFinite(toUtc) ||
    new Date(startUtc).toISOString().slice(0, 10) !== from ||
    new Date(toUtc).toISOString().slice(0, 10) !== to
  )
    throw new MetricRangeError("Dates must be real calendar dates (YYYY-MM-DD)");
  const days = Math.round((toUtc - startUtc) / DAY_MS) + 1;
  if (days < 1) throw new MetricRangeError("The range ends before it starts");
  if (days > MAX_METRIC_RANGE_DAYS) throw new MetricRangeError("The range is longer than a year");
  const offset = DUBAI_UTC_OFFSET_MINUTES * 60_000;
  return {
    start: new Date(startUtc - offset),
    end: new Date(toUtc + DAY_MS - offset),
    days,
  };
}

/** Integer division rounded half-up: the AED-fils average of a non-negative total. */
export function averageFils(totalFils: bigint, count: number): number | null {
  if (count <= 0) return null;
  if (totalFils < 0n) throw new RangeError("A sales total cannot be negative");
  const n = BigInt(count);
  const average = (totalFils * 2n + n) / (2n * n);
  if (average > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Average out of range");
  return Number(average);
}

/** A share in basis points (1% = 100), rounded half-up; none when nothing is counted. */
export function rateBps(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.floor((part * 20_000 + whole) / (2 * whole));
}

/** The Dubai calendar day (`YYYY-MM-DD`) an instant falls on. */
export function dubaiDate(instant: Date): string {
  const time = instant.getTime();
  if (!Number.isFinite(time)) throw new MetricRangeError("Invalid instant");
  return new Date(time + DUBAI_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** `day` moved by `count` calendar days (negative = earlier). */
export function addDays(day: string, count: number): string {
  dubaiDayRange(day, day); // validates the date
  if (!Number.isSafeInteger(count)) throw new MetricRangeError("Invalid day count");
  return new Date(Date.parse(day + "T00:00:00Z") + count * DAY_MS).toISOString().slice(0, 10);
}

/** `from`..`to` inclusive, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const { days } = dubaiDayRange(from, to);
  return Array.from({ length: days }, (_, i) => addDays(from, i));
}
