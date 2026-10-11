export const sections = [
  { key: "orders", label: "Orders", permission: "orders.read", group: "Commerce" },
  { key: "products", label: "Products", permission: "catalog.read", group: "Commerce" },
  { key: "brands", label: "Brands", permission: "catalog.read", group: "Commerce" },
  { key: "categories", label: "Categories", permission: "catalog.read", group: "Commerce" },
  { key: "inventory", label: "Inventory", permission: "inventory.read", group: "Commerce" },
  { key: "customers", label: "Customers", permission: "customers.read", group: "Commerce" },
  {
    key: "notifications",
    label: "Notifications",
    permission: "notifications.read_own",
    group: "Workspace",
  },
  {
    key: "analytics",
    label: "Analytics",
    permission: "dashboard.financial_read",
    group: "Management",
  },
  { key: "reports", label: "Reports", permission: "reports.read", group: "Management" },
  { key: "staff", label: "Staff & roles", permission: "staff.manage", group: "Management" },
  { key: "delivery", label: "Delivery", permission: "delivery.manage", group: "Management" },
  { key: "settings", label: "Settings", permission: "settings.manage", group: "Management" },
  { key: "seo", label: "SEO", permission: "seo.write", group: "Management" },
] as const;
export function visibleSections(permissions: readonly string[]) {
  return sections.filter((section) => permissions.includes(section.permission));
}
