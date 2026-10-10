import { describe, expect, it } from "vitest";
import { visibleSections } from "./navigation";
describe("permission-derived navigation", () => {
  it("hides financial/settings/staff/SEO sections from operational Staff grants", () => {
    expect(
      visibleSections([
        "orders.read",
        "catalog.read",
        "inventory.read",
        "customers.read",
        "notifications.read_own",
      ]).map((s) => s.key),
    ).toEqual(["orders", "products", "brands", "inventory", "customers", "notifications"]);
  });
  it("uses individual server grants rather than a client role label or wildcard", () => {
    expect(visibleSections(["staff.manage"]).map((s) => s.key)).toEqual(["staff"]);
    expect(visibleSections(["delivery.manage"]).map((s) => s.key)).toEqual(["delivery"]);
    expect(visibleSections(["owner", "*"])).toEqual([]);
    expect(visibleSections([])).toEqual([]);
  });
  it("drops navigation immediately when refreshed permissions are revoked", () => {
    expect(visibleSections(["reports.read"])).toHaveLength(1);
    expect(visibleSections(["orders.read"]).some((s) => s.key === "reports")).toBe(false);
  });
});
