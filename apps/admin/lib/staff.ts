import { ROLE_PERMISSIONS, type PermissionKey, type RoleKey } from "@ih/contracts";

/**
 * The prototype's access summary (`PERMS`, V-A15), read from the real role grants: each area is
 * allowed for a role when the role holds the permission that unlocks it. Nothing is hand-set.
 */
export const ACCESS_AREAS: ReadonlyArray<readonly [label: string, permission: PermissionKey]> = [
  ["Orders: view, confirm and deliver", "orders.transition"],
  ["Create and edit orders", "orders.create"],
  ["Record cash collection", "orders.collect"],
  ["Cancel after dispatch, correct a collection", "orders.cancel_after_dispatch"],
  ["Products, categories and brands", "catalog.write"],
  ["Publish and move to Trash", "catalog.publish"],
  ["Delete permanently", "catalog.purge"],
  ["Inventory", "inventory.adjust"],
  ["Customer lookup for order support", "customers.read"],
  ["Customer spend and export", "customers.export"],
  ["Revenue and analytics", "dashboard.financial_read"],
  ["Reports and exports", "reports.export"],
  ["Reviews", "reviews.moderate"],
  ["Discounts", "coupons.manage"],
  ["Storefront content", "content.manage"],
  ["SEO", "seo.write"],
  ["Settings and delivery", "settings.manage"],
  ["Staff accounts", "staff.manage"],
];

export function roleCan(role: RoleKey, permission: PermissionKey): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** The prototype's initials avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}
