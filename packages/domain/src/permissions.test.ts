import { describe, expect, it } from "vitest";
import {
  PERMISSION_KEYS,
  ROLE_PERMISSIONS,
  STAFF_PERMISSIONS,
  roleHasPermission,
  type PermissionKey,
} from "./permissions";

describe("launch permission matrix (architecture §11)", () => {
  it("uses granular dotted keys with no wildcard", () => {
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      expect(key).not.toContain("*");
    }
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it("grants the Owner every permission explicitly", () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("gives Staff only known, duplicate-free operational permissions", () => {
    expect(new Set(STAFF_PERMISSIONS).size).toBe(STAFF_PERMISSIONS.length);
    for (const key of STAFF_PERMISSIONS) expect(PERMISSION_KEYS).toContain(key);
  });

  it.each<PermissionKey>([
    "orders.read",
    "orders.create",
    "orders.edit",
    "orders.transition",
    "orders.cancel_before_dispatch",
    "orders.collect",
    "catalog.write",
    "catalog.publish",
    "catalog.trash",
    "inventory.read",
    "inventory.adjust",
    "customers.read",
    "notifications.read_own",
  ])("Staff may %s", (permission) => {
    expect(roleHasPermission("staff", permission)).toBe(true);
  });

  it.each<PermissionKey>([
    "orders.cancel_after_dispatch",
    "orders.collection_correct",
    "catalog.purge",
    "customers.financial_read",
    "customers.export",
    "seo.write",
    "seo.reports",
    "dashboard.financial_read",
    "reports.read",
    "reports.export",
    "reviews.moderate",
    "coupons.manage",
    "content.manage",
    "settings.manage",
    "delivery.manage",
    "staff.manage",
    "audit.read",
    "effects.replay",
  ])("Staff may NOT %s (Owner only)", (permission) => {
    expect(roleHasPermission("staff", permission)).toBe(false);
    expect(roleHasPermission("owner", permission)).toBe(true);
  });
});
