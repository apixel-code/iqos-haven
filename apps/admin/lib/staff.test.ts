import { describe, expect, it } from "vitest";
import { ACCESS_AREAS, initials, roleCan } from "./staff";

describe("access summary (V-A15)", () => {
  it("follows the real grants: Staff runs operations, the Owner has everything", () => {
    expect(roleCan("staff", "orders.transition")).toBe(true);
    expect(roleCan("staff", "catalog.write")).toBe(true);
    expect(roleCan("staff", "customers.read")).toBe(true);
    expect(roleCan("staff", "catalog.purge")).toBe(false);
    expect(roleCan("staff", "customers.export")).toBe(false);
    expect(roleCan("staff", "staff.manage")).toBe(false);
    for (const [, permission] of ACCESS_AREAS) expect(roleCan("owner", permission)).toBe(true);
  });
  it("lists each area once", () => {
    const labels = ACCESS_AREAS.map(([label]) => label);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("makes initials from one or more names", () => {
    expect(initials("Owner QA")).toBe("OQ");
    expect(initials("Noor")).toBe("N");
    expect(initials("  ana maria  lopez ")).toBe("AL");
  });
});
