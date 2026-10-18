import { describe, expect, it } from "vitest";
import { navHref, visibleNav, visibleSections } from "./navigation";
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
    ).toEqual([
      "orders",
      "products",
      "brands",
      "categories",
      "inventory",
      "customers",
      "notifications",
    ]);
  });
  it("uses individual server grants rather than a client role label or wildcard", () => {
    expect(visibleSections(["staff.manage"]).map((s) => s.key)).toEqual(["staff"]);
    expect(visibleSections(["delivery.manage"]).map((s) => s.key)).toEqual(["delivery"]);
    expect(visibleSections(["coupons.manage"]).map((s) => s.key)).toEqual(["discounts"]);
    expect(visibleSections(["reviews.moderate"]).map((s) => s.key)).toEqual(["reviews"]);
    expect(visibleSections(["content.manage"]).map((s) => s.key)).toEqual(["content"]);
    expect(visibleSections(["owner", "*"])).toEqual([]);
    expect(visibleSections([])).toEqual([]);
  });
  it("drops navigation immediately when refreshed permissions are revoked", () => {
    expect(visibleSections(["reports.read"])).toHaveLength(1);
    expect(visibleSections(["orders.read"]).some((s) => s.key === "reports")).toBe(false);
  });
});

describe("sidebar (prototype navItems)", () => {
  it("keeps the dashboard for everyone and leaves out what the rights do not cover", () => {
    const nav = visibleNav(["orders.read"]);
    expect(nav.map((group) => group.group)).toEqual([null, "Commerce"]);
    expect(nav[1]!.items.map((item) => item.key)).toEqual(["orders"]);
  });
  it("nests categories and brands under products", () => {
    const commerce = visibleNav(["catalog.read"]).find((group) => group.group === "Commerce")!;
    expect(commerce.items.map((item) => item.key)).toEqual(["products"]);
    expect(commerce.items[0]!.sub!.map((item) => item.key)).toEqual(["categories", "brands"]);
  });
  it("links the dashboard to the home page", () => {
    expect(navHref("dashboard")).toBe("/");
    expect(navHref("orders")).toBe("/workspace/orders");
  });
});
