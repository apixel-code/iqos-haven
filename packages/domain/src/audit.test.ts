import { describe, expect, it } from "vitest";
import { assertAuditEntry, buildAuditDiff, type AuditEntry } from "./audit";

const entry: AuditEntry = {
  actor: { type: "staff", id: "0199c4a2-7b1e-7c3a-9f00-1234567890ab" },
  action: "coupon.updated",
  entityType: "coupon",
  entityId: "0199c4a2-7b1e-7c3a-9f00-1234567890ac",
  requestId: "req-1",
  diff: {},
};

describe("buildAuditDiff", () => {
  it("records only changed fields", () => {
    expect(
      buildAuditDiff(
        { code: "EID10", basisPoints: 1000, active: true },
        { code: "EID10", basisPoints: 1500, active: true },
      ),
    ).toEqual({ basisPoints: { from: 1000, to: 1500 } });
  });

  it("never stores secret or PII values, only that they changed", () => {
    const diff = buildAuditDiff(
      { passwordHash: "old", customerPhone: "+971500000001", email: "a@x.ae" },
      { passwordHash: "new", customerPhone: "+971500000002", email: "a@x.ae" },
    );
    expect(diff).toEqual({ passwordHash: { redacted: true }, customerPhone: { redacted: true } });
    expect(JSON.stringify(diff)).not.toMatch(/old|new|\+971/);
  });

  it("redacts personal fields by default, including nested ones", () => {
    const diff = buildAuditDiff(
      {
        fullName: "Aisha",
        street: "A",
        ipAddress: "1.1.1.1",
        snapshot: { area: "Marina", phone: "+971500000001" },
      },
      {
        fullName: "Aisha K",
        street: "B",
        ipAddress: "2.2.2.2",
        snapshot: { area: "JLT", phone: "+971500000001" },
      },
    );
    expect(diff).toEqual({
      fullName: { redacted: true },
      ipAddress: { redacted: true },
      street: { redacted: true },
      snapshot: {
        from: { area: "Marina", phone: "[redacted]" },
        to: { area: "JLT", phone: "[redacted]" },
      },
    });
  });

  it("keeps operational fields and reveals only allowed non-secret fields", () => {
    const diff = buildAuditDiff(
      { name: "Pod A", unitPriceFils: 100, customerId: "c1", apiToken: "t1", label: "x" },
      { name: "Pod B", unitPriceFils: 120, customerId: "c2", apiToken: "t2", label: "y" },
      { reveal: ["name", "apiToken"], redact: ["label"] },
    );
    expect(diff).toEqual({
      name: { from: "Pod A", to: "Pod B" },
      unitPriceFils: { from: 100, to: 120 },
      customerId: { from: "c1", to: "c2" },
      apiToken: { redacted: true },
      label: { redacted: true },
    });
  });

  it("truncates oversize diffs instead of failing the mutation", () => {
    const before = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`f${i}`, "x".repeat(400)]),
    );
    const diff = buildAuditDiff(before, { ...before, f0: "changed", phone: "+97150" });
    expect(diff).toEqual({
      f0: { from: "x".repeat(400), to: "changed" },
      phone: { redacted: true },
    });
    const wide = buildAuditDiff(before, null);
    expect(Object.keys(wide)).toHaveLength(100);
    expect(wide.f0).toEqual({ truncated: true });
    expect(() => assertAuditEntry({ ...entry, diff: wide })).not.toThrow();
  });

  it("ignores prototype keys and strips NUL characters", () => {
    const before = JSON.parse('{"__proto__": {"x": 1}, "title": "a"}') as Record<string, unknown>;
    const diff = buildAuditDiff(before, { title: "b\u0000c" });
    expect(Object.keys(diff)).toEqual(["title"]);
    expect(diff.title).toEqual({ from: "a", to: "bc" });
  });

  it("serializes bigint, dates and creation/removal safely", () => {
    const at = new Date("2026-10-08T10:00:00.000Z");
    expect(buildAuditDiff(null, { totalFils: 9_007_199_254_740_993n, at })).toEqual({
      at: { from: null, to: "2026-10-08T10:00:00.000Z" },
      totalFils: { from: null, to: "9007199254740993" },
    });
    expect(buildAuditDiff({ active: true }, null)).toEqual({ active: { from: true, to: null } });
  });

  it("treats key order as equal and bounds long values", () => {
    expect(buildAuditDiff({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual({});
    const diff = buildAuditDiff({ note: "" }, { description: "x".repeat(2000) });
    expect((diff.description as { to: string }).to).toHaveLength(501);
  });
});

describe("assertAuditEntry", () => {
  it("accepts a valid staff and system entry", () => {
    expect(assertAuditEntry(entry)).toBe(entry);
    expect(
      assertAuditEntry({ ...entry, actor: { type: "system" }, reason: "nightly" }),
    ).toBeTruthy();
  });

  it.each([
    { action: "Coupon.Update" },
    { action: "updated" },
    { entityType: "Coupon" },
    { requestId: "" },
    { commandId: "x".repeat(129) },
    { reason: "   " },
    { actor: { type: "staff", id: "not-a-uuid" } },
  ] as Partial<AuditEntry>[])("rejects %o", (patch) => {
    expect(() => assertAuditEntry({ ...entry, ...patch })).toThrow(RangeError);
  });

  it("rejects oversize diffs", () => {
    const diff = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `f${i}`,
        { from: "x".repeat(400), to: "y".repeat(400) },
      ]),
    );
    expect(() => assertAuditEntry({ ...entry, diff })).toThrow("too large");
  });
});
