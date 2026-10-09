import { describe, expect, it } from "vitest";
import { defineFieldPolicy, fieldPolicyPermissions, filterFields } from "./field-policy";
import { PERMISSION_KEYS, ROLE_PERMISSIONS } from "./permissions";

const policy = defineFieldPolicy({
  lifetimeSpendFils: "customers.financial_read",
  orders: { revenueFils: "dashboard.financial_read" },
});
const staff = new Set<string>(ROLE_PERMISSIONS.staff);
const owner = new Set<string>(ROLE_PERMISSIONS.owner);

const customer = {
  id: "c1",
  phone: "+971500000000",
  lifetimeSpendFils: 1_234_500,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  orders: [
    { id: "o1", totalFils: 25_000, revenueFils: 20_000 },
    { id: "o2", totalFils: 5_000, revenueFils: 4_000 },
  ],
};

describe("response field policy", () => {
  it("strips Owner-only aggregates for Staff but keeps operational fields", () => {
    const result = filterFields(customer, policy, staff);
    expect(result).not.toHaveProperty("lifetimeSpendFils");
    expect(result.orders.every((order) => !("revenueFils" in order))).toBe(true);
    // Staff need unit prices/totals to fulfil an order.
    expect(result.orders.map((order) => order.totalFils)).toEqual([25_000, 5_000]);
    expect(result.createdAt).toBe(customer.createdAt);
    expect(result.phone).toBe(customer.phone);
  });

  it("keeps every field for the Owner", () => {
    expect(filterFields(customer, policy, owner)).toEqual(customer);
  });

  it("filters top-level arrays element by element and never mutates the input", () => {
    const list = [customer, { ...customer, id: "c2" }];
    const result = filterFields(list, policy, staff);
    expect(result.every((item) => !("lifetimeSpendFils" in item))).toBe(true);
    expect(customer.lifetimeSpendFils).toBe(1_234_500);
    expect(customer.orders[0]).toHaveProperty("revenueFils");
  });

  it("removes a denied field even when it holds null or a nested object", () => {
    const result = filterFields(
      { lifetimeSpendFils: null, orders: null },
      { lifetimeSpendFils: "customers.financial_read", orders: "reports.read" },
      new Set(),
    );
    expect(result).toEqual({});
  });

  it("does not consult inherited properties of the policy", () => {
    const result = filterFields({ toString: "x", constructor: 1 }, policy, new Set());
    expect(result).toEqual({ toString: "x", constructor: 1 });
  });

  it("only names catalogue permissions", () => {
    for (const key of fieldPolicyPermissions(policy)) expect(PERMISSION_KEYS).toContain(key);
    expect(fieldPolicyPermissions(policy).sort()).toEqual([
      "customers.financial_read",
      "dashboard.financial_read",
    ]);
  });
});
