/** Dubai calendar day of an instant, `YYYY-MM-DD`. */
export function dubaiDay(instant: Date): string {
  return new Date(instant.getTime() + 4 * 60 * 60_000).toISOString().slice(0, 10);
}

/** The last `days` Dubai days up to and including today. */
export function analyticsRange(days: number, now: Date) {
  const to = dubaiDay(now);
  const from = new Date(Date.parse(to + "T00:00:00Z") - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to, preset: days as number | null };
}

/** Basis points as a percentage with one decimal, e.g. 1234 → "12.3%". Integer math only. */
export function percent(bps: number | null): string {
  if (bps === null) return "—";
  const tenths = Math.floor((bps + 5) / 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** "+12.0% vs previous period", or a plain note when there is nothing to compare with. */
export function signedChange(
  now: number | null,
  before: number | null,
  format: (value: number) => string,
): string {
  if (now === null || before === null) return "No comparison";
  if (before === 0) return now === 0 ? "Same as previous period" : `Previous period: ${format(0)}`;
  const bps = Math.round(((now - before) * 10_000) / before);
  if (bps === 0) return "Same as previous period";
  return `${bps > 0 ? "+" : "−"}${percent(Math.abs(bps))} vs previous period`;
}

/** Every day `from`..`to` inclusive, oldest first (both `YYYY-MM-DD`). */
export function rangeDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86_400_000)
    days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/**
 * The prototype's delta (`deltaHtml`) in basis points of the earlier figure, integer math;
 * null when there is nothing to compare with (no earlier figure, or it was zero).
 */
export function changeBps(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return Math.round(((now - before) * 10_000) / before);
}
