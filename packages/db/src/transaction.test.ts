import { describe, expect, it, vi } from "vitest";
import { type Database, Prisma } from "./client";
import { sortedForLocking, withTransaction, TransactionContentionError } from "./transaction";
describe("transaction policy", () => {
  it("dedupes and sorts lock ids", () => {
    expect(sortedForLocking(["v3", "v1", "v3", "v2"])).toEqual(["v1", "v2", "v3"]);
    expect(sortedForLocking([30, 4, 12])).toEqual([4, 12, 30]);
  });
  it("restarts the whole unit of work after a commit-time conflict", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({ code: "P2034" })
      .mockResolvedValueOnce("committed");
    const work = vi.fn();
    expect(await withTransaction({ $transaction: transaction } as unknown as Database, work)).toBe(
      "committed",
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledWith(
      work,
      expect.objectContaining({ isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
    );
  });
  it("retries approved raw-query PostgreSQL deadlocks but not unique violations", async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "40P01" } } },
      })
      .mockResolvedValueOnce("ok");
    expect(
      await withTransaction({ $transaction: transaction } as unknown as Database, vi.fn()),
    ).toBe("ok");
    const unique = vi.fn().mockRejectedValue({ code: "P2010", meta: { code: "23505" } });
    await expect(
      withTransaction({ $transaction: unique } as unknown as Database, vi.fn()),
    ).rejects.toBeDefined();
    expect(unique).toHaveBeenCalledTimes(1);
  });
  it("bounds retries and preserves non-transient failures", async () => {
    const contention = vi.fn().mockRejectedValue({ code: "P2034" });
    await expect(
      withTransaction({ $transaction: contention } as unknown as Database, vi.fn()),
    ).rejects.toBeInstanceOf(TransactionContentionError);
    expect(contention).toHaveBeenCalledTimes(3);
    const invalid = vi.fn().mockRejectedValue({ code: "P2002" });
    await expect(
      withTransaction({ $transaction: invalid } as unknown as Database, vi.fn()),
    ).rejects.toEqual({ code: "P2002" });
    expect(invalid).toHaveBeenCalledTimes(1);
  });
});
