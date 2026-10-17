import { parseArgs } from "node:util";
import { ROLLUP_PARTS, type RollupPart } from "@ih/db";
import { daysBetween, dubaiDate, MetricRangeError } from "@ih/domain";

/**
 * Controlled historical backfill of the daily tables (roadmap step 107, ADR 0073). An operator
 * names the Dubai days; each day is recomputed in its own short transaction and replaced whole,
 * so running it twice, or over days the scheduler also recomputes, never adds anything.
 */
export const USAGE = `Usage: pnpm analytics:backfill --from YYYY-MM-DD --to YYYY-MM-DD [--parts sales,products,search,wishlist]

Recomputes the daily analytics tables for Dubai days from..to (at most 366 days, none after
today). Search and saved-list rows of days older than the 90-day event retention are kept.`;

export interface BackfillDeps {
  readonly argv: readonly string[];
  readonly now: Date;
  backfill(
    from: string,
    to: string,
    parts: readonly RollupPart[],
    onDay: (day: string) => void,
  ): Promise<{ days: number }>;
  out(line: string): void;
}

export async function runBackfill(deps: BackfillDeps): Promise<0 | 1 | 2> {
  let from: string;
  let to: string;
  let parts: RollupPart[];
  try {
    const { values } = parseArgs({
      args: [...deps.argv],
      options: {
        from: { type: "string" },
        to: { type: "string" },
        parts: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.from || !values.to) throw new MetricRangeError("--from and --to are required");
    from = values.from;
    to = values.to;
    daysBetween(from, to);
    if (to > dubaiDate(deps.now)) throw new MetricRangeError("The range ends after today");
    parts = values.parts
      ? (values.parts.split(",").map((part) => part.trim()) as RollupPart[])
      : [...ROLLUP_PARTS];
    if (!parts.length || parts.some((part) => !ROLLUP_PARTS.includes(part)))
      throw new MetricRangeError("Unknown part");
  } catch (error) {
    deps.out((error instanceof Error ? error.message : "Invalid arguments") + "\n\n" + USAGE);
    return 2;
  }
  try {
    const { days } = await deps.backfill(from, to, parts, (day) => deps.out("recomputed " + day));
    deps.out(`Done: ${days} day(s) recomputed (${parts.join(", ")}).`);
    return 0;
  } catch {
    deps.out("Backfill stopped: a day could not be recomputed. Days already done are complete.");
    return 1;
  }
}
