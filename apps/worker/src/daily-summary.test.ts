import { dailySummaryTemplate, renderEmail } from "@ih/application";
import type { Database, RollupPart } from "@ih/db";
import { dueSlots } from "@ih/domain";
import { createLogger } from "@ih/logger";
import { describe, expect, it } from "vitest";
import { runBackfill } from "./cli/rollup-backfill";
import { createDailySummaryJob, DAILY_SUMMARY_JOB } from "./daily-summary";

describe("daily summary registration", () => {
  const job = createDailySummaryJob({
    db: {} as Database,
    log: createLogger({ service: "test", level: "silent" }),
  });

  it("has one slot a day at 09:00 Asia/Dubai and never replays old days", () => {
    expect(job.name).toBe(DAILY_SUMMARY_JOB);
    expect(job.catchUp).toBe(1);
    expect(dueSlots(job.spec, new Date("2026-10-15T04:59:59Z"), job.catchUp)).toEqual([
      new Date("2026-10-14T05:00:00Z"),
    ]);
    expect(dueSlots(job.spec, new Date("2026-10-15T05:00:00Z"), job.catchUp)).toEqual([
      new Date("2026-10-15T05:00:00Z"),
    ]);
  });

  it("renders figures per basis with the date meaning, escaped", () => {
    const email = renderEmail(dailySummaryTemplate, {
      day: "2026-10-15",
      booked: { orders: 3, total: "AED 1,200.00" },
      cancelled: { orders: 1 },
      delivered: { orders: 2, total: "AED 800.50" },
      collected: { orders: 1, amount: "AED 400.00" },
      computedAt: "2026-10-16 09:00",
      taxNote: "Prices are final.",
      topProducts: [{ name: "Pod <X>", units: 4 }],
    });
    expect(email.subject).toBe("Daily summary for 2026-10-15");
    expect(email.text).toContain("Delivered: 2 orders, AED 800.50 (by delivery date)");
    expect(email.text).toContain("Pod <X>: 4");
    expect(email.html).toContain("Pod &lt;X&gt;: 4");
    expect(email.html).not.toContain("<X>");
  });
});

describe("analytics backfill command", () => {
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const calls: Array<[string, string, readonly RollupPart[]]> = [];
    const code = await runBackfill({
      argv,
      now: new Date("2026-10-16T10:00:00Z"),
      backfill: async (from, to, parts, onDay) => {
        calls.push([from, to, parts]);
        onDay(from);
        return { days: 1 };
      },
      out: (line) => out.push(line),
    });
    return { code, out: out.join("\n"), calls };
  };

  it("recomputes the named range, all parts unless told otherwise", async () => {
    const all = await run(["--from", "2026-09-01", "--to", "2026-09-30"]);
    expect(all.code).toBe(0);
    expect(all.calls).toEqual([
      ["2026-09-01", "2026-09-30", ["sales", "products", "search", "wishlist"]],
    ]);
    const some = await run(["--from", "2026-10-16", "--to", "2026-10-16", "--parts", "sales"]);
    expect(some.calls[0]![2]).toEqual(["sales"]);
  });

  it("refuses a missing, impossible, over-long or future range and unknown parts", async () => {
    for (const argv of [
      [],
      ["--from", "2026-09-01"],
      ["--from", "2026-02-30", "--to", "2026-03-01"],
      ["--from", "2026-10-01", "--to", "2026-09-01"],
      ["--from", "2024-01-01", "--to", "2026-01-01"],
      ["--from", "2026-10-16", "--to", "2026-10-17"],
      ["--from", "2026-10-01", "--to", "2026-10-02", "--parts", "sales,orders"],
      ["--from", "2026-10-01", "--to", "2026-10-02", "--extra"],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.out).toContain("Usage: pnpm analytics:backfill");
    }
  });

  it("says a failed run stopped without hiding which days are done", async () => {
    const out: string[] = [];
    const code = await runBackfill({
      argv: ["--from", "2026-10-01", "--to", "2026-10-02"],
      now: new Date("2026-10-16T10:00:00Z"),
      backfill: async () => {
        throw new Error("connection refused at 10.0.0.1");
      },
      out: (line) => out.push(line),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).not.toContain("10.0.0.1");
  });
});
