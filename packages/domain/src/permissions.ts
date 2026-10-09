/**
 * Launch permission model (architecture §11 "Launch permissions"). Granular keys, explicit
 * grants only: Owner receives every key as its own row and Staff an explicit operational list.
 * There is no wildcard. The identity migration seeds exactly these values; an integration test
 * keeps database seeds and this catalogue identical. Custom roles are deferred.
 */
export const PERMISSIONS = {
  // Orders
  "orders.read": "View orders and their history",
  "orders.create": "Create manual orders",
  "orders.edit": "Edit orders before dispatch",
  "orders.transition": "Move orders through normal status transitions",
  "orders.cancel_before_dispatch": "Cancel an order before it is handed to the courier",
  "orders.collect": "Record cash-on-delivery collection",
  "orders.cancel_after_dispatch": "Cancel after handoff (return flow)",
  "orders.collection_correct": "Correct a recorded collection",
  // Catalogue and media
  "catalog.read": "View products, variants, brands and categories",
  "catalog.write": "Create and edit catalogue entries",
  "catalog.publish": "Publish and unpublish catalogue entries",
  "catalog.trash": "Move catalogue entries to trash and restore them",
  "catalog.purge": "Permanently purge catalogue entries (reference-checked)",
  "media.upload": "Upload catalogue images",
  // Inventory
  "inventory.read": "View stock levels and movements",
  "inventory.adjust": "Make reasoned stock adjustments",
  // Customers
  "customers.read": "View operational customer contact and order history",
  "customers.financial_read": "View customer aggregate spend",
  "customers.export": "Export customer data",
  // SEO
  "seo.write": "Edit SEO fields and redirects",
  "seo.reports": "View SEO reports",
  // Dashboard, analytics and reports
  "dashboard.financial_read": "View revenue and analytics",
  "reports.read": "View reports",
  "reports.export": "Export reports",
  // Moderation, marketing, content and configuration
  "reviews.moderate": "Approve or reject reviews",
  "coupons.manage": "Manage coupons",
  "content.manage": "Edit and publish storefront content",
  "settings.manage": "Change store settings",
  "delivery.manage": "Manage delivery areas, fees and ETAs",
  "staff.manage": "Invite, edit and deactivate staff",
  // Operations
  "audit.read": "View the audit trail",
  "effects.replay": "Inspect and replay dead background effects",
  // Notifications
  "notifications.read_own": "Read one's own eligible notifications",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const ROLE_KEYS = ["owner", "staff"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/** Staff: day-to-day operations only. No SEO, purge, exports, financial aggregates or config. */
export const STAFF_PERMISSIONS: readonly PermissionKey[] = [
  "orders.read",
  "orders.create",
  "orders.edit",
  "orders.transition",
  "orders.cancel_before_dispatch",
  "orders.collect",
  "catalog.read",
  "catalog.write",
  "catalog.publish",
  "catalog.trash",
  "media.upload",
  "inventory.read",
  "inventory.adjust",
  "customers.read",
  "notifications.read_own",
];

export const ROLE_PERMISSIONS: Readonly<Record<RoleKey, readonly PermissionKey[]>> = {
  owner: PERMISSION_KEYS,
  staff: STAFF_PERMISSIONS,
};

export function roleHasPermission(role: RoleKey, permission: PermissionKey): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
