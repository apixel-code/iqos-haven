/**
 * Schedule slots (architecture §8 Scheduling). A slot is the instant a run is due; each
 * (job, slot) runs once across all replicas. Report/schedule dates use Asia/Dubai.
 */
export type ScheduleSpec =
  | { readonly kind: "interval"; readonly everyMs: number }
  /** Local wall-clock time at a fixed UTC offset. Asia/Dubai is UTC+04:00 with no DST. */
  | {
      readonly kind: "daily";
      readonly hour: number;
      readonly minute: number;
      readonly utcOffsetMinutes: number;
    };

export const DUBAI_UTC_OFFSET_MINUTES = 240;
const DAY_MS = 86_400_000;

/** Daily at hh:mm Asia/Dubai, e.g. the 09:00 daily summary. */
export function dubaiDaily(hour: number, minute = 0): ScheduleSpec {
  return { kind: "daily", hour, minute, utcOffsetMinutes: DUBAI_UTC_OFFSET_MINUTES };
}

function period(spec: ScheduleSpec): { lengthMs: number; phaseMs: number } {
  if (spec.kind === "interval") {
    if (!Number.isSafeInteger(spec.everyMs) || spec.everyMs < 1000)
      throw new RangeError("Interval must be at least one second");
    return { lengthMs: spec.everyMs, phaseMs: 0 };
  }
  if (
    !Number.isInteger(spec.hour) ||
    spec.hour < 0 ||
    spec.hour > 23 ||
    !Number.isInteger(spec.minute) ||
    spec.minute < 0 ||
    spec.minute > 59
  )
    throw new RangeError("Invalid daily schedule time");
  const localMs = (spec.hour * 60 + spec.minute) * 60_000;
  const phase = (((localMs - spec.utcOffsetMinutes * 60_000) % DAY_MS) + DAY_MS) % DAY_MS;
  return { lengthMs: DAY_MS, phaseMs: phase };
}

/**
 * The most recent `catchUp` slots that are due at `now` (oldest first). `catchUp = 1` runs only
 * the latest missed slot; larger values replay that many missed slots after downtime. A newly
 * registered job therefore never back-fills more than its catch-up window.
 */
export function dueSlots(spec: ScheduleSpec, now: Date, catchUp: number): Date[] {
  if (!Number.isSafeInteger(catchUp) || catchUp < 1 || catchUp > 100)
    throw new RangeError("Catch-up must be 1–100 slots");
  const { lengthMs, phaseMs } = period(spec);
  const latest = Math.floor((now.getTime() - phaseMs) / lengthMs) * lengthMs + phaseMs;
  return Array.from({ length: catchUp }, (_, i) => new Date(latest - (catchUp - 1 - i) * lengthMs));
}
