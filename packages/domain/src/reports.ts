import type { PermissionKey } from "./permissions";

/**
 * CSV reports (roadmap steps 110–112, ADR 0076; architecture §10, §14). The prototype's five
 * reports; a sixth is a separate scope decision.
 */
export const REPORT_TYPES = ["sales", "orders", "products", "inventory", "customers"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const SALES_REPORT_BASES = ["booked", "delivered", "collected"] as const;

/** Up to this many rows a report is streamed on download; above it, a file is built. */
export const REPORT_STREAM_MAX_ROWS = 5000;
/** A streamed report's link, and every download link, lasts at most 15 minutes. */
export const REPORT_LINK_MINUTES = 15;
/** A built report file is kept 7 days (BI-08). */
export const REPORT_FILE_RETENTION_DAYS = 7;

/**
 * The rights a report needs, to request it and again to download it. Every report needs
 * `reports.export`; the customers report holds personal data and also needs `customers.export`.
 */
export function reportPermissions(type: ReportType): PermissionKey[] {
  return type === "customers" ? ["reports.export", "customers.export"] : ["reports.export"];
}
