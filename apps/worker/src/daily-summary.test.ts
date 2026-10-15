import { dueSlots } from "@ih/domain";
import { createLogger } from "@ih/logger";
import { describe, expect, it } from "vitest";
import { createDailySummaryJob, DAILY_SUMMARY_JOB } from "./daily-summary";

describe("daily summary registration", () => {
  const job = createDailySummaryJob({ log: createLogger({ service: "test", level: "silent" }) });

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

  it("completes its slot without sending anything until analytics exist", async () => {
    await expect(job.run(new Date("2026-10-15T05:00:00Z"))).resolves.toBeUndefined();
  });
});
