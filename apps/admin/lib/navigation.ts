/** `sub` is the prototype's line under the page title (`pageHead`), where it is fixed text. */
export const sections = [
  { key: "orders", label: "Orders", permission: "orders.read", group: "Commerce" },
  { key: "products", label: "Products", permission: "catalog.read", group: "Commerce" },
  {
    key: "brands",
    label: "Brands",
    permission: "catalog.read",
    group: "Commerce",
    sub: "Brand pages and the Shop by Brand section use these.",
  },
  {
    key: "categories",
    label: "Categories",
    permission: "catalog.read",
    group: "Commerce",
    sub: "Shown in the store menu and filters, in this order.",
  },
  { key: "inventory", label: "Inventory", permission: "inventory.read", group: "Commerce" },
  { key: "customers", label: "Customers", permission: "customers.read", group: "Commerce" },
  { key: "reviews", label: "Reviews", permission: "reviews.moderate", group: "Commerce" },
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
  {
    key: "reports",
    label: "Reports",
    permission: "reports.read",
    group: "Management",
    sub: "Structured data for accounting, stock counts and planning. Export as CSV.",
  },
  {
    key: "staff",
    label: "Staff & roles",
    permission: "staff.manage",
    group: "Management",
    sub: "Who can sign in to the admin and what they can do.",
  },
  {
    key: "discounts",
    label: "Discounts",
    permission: "coupons.manage",
    group: "Management",
    sub: "Percentage coupon codes customers enter at checkout.",
  },
  {
    key: "delivery",
    label: "Delivery",
    permission: "delivery.manage",
    group: "Management",
    sub: "The delivery fee, the promise shown to customers and the areas served.",
  },
  {
    key: "content",
    label: "Storefront content",
    permission: "content.manage",
    group: "Management",
    sub: "Edit the main home page sections. Changes go live when you save.",
  },
  {
    key: "settings",
    label: "Settings",
    permission: "settings.manage",
    group: "Management",
    sub: "Owner-only store configuration.",
  },
  {
    key: "seo",
    label: "SEO",
    permission: "seo.write",
    group: "Management",
    sub: "Titles, descriptions and share images for search engines and social links.",
  },
] as const;
export function visibleSections(permissions: readonly string[]) {
  return sections.filter((section) => permissions.includes(section.permission));
}

/** Which attention count a navigation entry carries (from the dashboard read). */
export type NavCount = "pendingOrders" | "lowStock" | "pendingReviews";
export interface NavItem {
  /** A section key, or `dashboard` for the home page. */
  key: string;
  label: string;
  icon: string;
  count?: NavCount;
  /** Shown under the item in the full sidebar (prototype: Categories and Brands under Products). */
  sub?: readonly NavItem[];
}
/**
 * The prototype's sidebar (`navItems`, ADR 0097): groups, icons and counts. Entries the signed-in
 * user's rights do not cover are left out (`visibleNav`); the API still decides every request.
 * Delivery sits with Settings; Notifications are reached from the bell.
 */
export const NAV: ReadonlyArray<{ group: string | null; items: readonly NavItem[] }> = [
  { group: null, items: [{ key: "dashboard", label: "Dashboard", icon: "home" }] },
  {
    group: "Commerce",
    items: [
      { key: "orders", label: "Orders", icon: "orders", count: "pendingOrders" },
      {
        key: "products",
        label: "Products",
        icon: "box",
        sub: [
          { key: "categories", label: "Categories", icon: "folder" },
          { key: "brands", label: "Brands", icon: "award" },
        ],
      },
      { key: "inventory", label: "Inventory", icon: "layers", count: "lowStock" },
      { key: "customers", label: "Customers", icon: "users" },
      { key: "reviews", label: "Reviews", icon: "star", count: "pendingReviews" },
      { key: "discounts", label: "Discounts", icon: "percent" },
    ],
  },
  {
    group: "Storefront",
    items: [
      { key: "content", label: "Storefront Content", icon: "layout" },
      { key: "seo", label: "SEO", icon: "globe" },
    ],
  },
  {
    group: "Insights",
    items: [
      { key: "analytics", label: "Analytics", icon: "chart" },
      { key: "reports", label: "Reports", icon: "file" },
    ],
  },
  {
    group: "Administration",
    items: [
      { key: "settings", label: "Settings", icon: "settings" },
      { key: "delivery", label: "Delivery", icon: "truck" },
      { key: "staff", label: "Staff & Roles", icon: "shield" },
    ],
  },
];

const allowed = (key: string, permissions: readonly string[]) =>
  key === "dashboard" ||
  sections.some((section) => section.key === key && permissions.includes(section.permission));

/** The sidebar for these rights: hidden entries and empty groups left out. */
export function visibleNav(permissions: readonly string[]) {
  return NAV.map(({ group, items }) => ({
    group,
    items: items.flatMap((item): NavItem[] => {
      const sub = item.sub?.filter((child) => allowed(child.key, permissions)) ?? [];
      if (allowed(item.key, permissions)) return [{ ...item, ...(item.sub ? { sub } : {}) }];
      // Products hidden but its children allowed: the children stand on their own.
      return sub;
    }),
  })).filter((group) => group.items.length > 0);
}

export const navHref = (key: string) => (key === "dashboard" ? "/" : `/workspace/${key}`);
