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

/** Reports holding personal data (customer names and phones): the orders and customers ones. */
export const PERSONAL_DATA_REPORTS: readonly ReportType[] = ["orders", "customers"];
/** A streamed download stops beyond this many data rows (the estimate may have grown). */
export const REPORT_STREAM_HARD_LIMIT = REPORT_STREAM_MAX_ROWS * 4;

/**
 * The rights a report needs, to request it and again to download it. Every report needs
 * `reports.export`; one holding personal data also needs `customers.export` (step 111).
 */
export function reportPermissions(type: ReportType): PermissionKey[] {
  return PERSONAL_DATA_REPORTS.includes(type)
    ? ["reports.export", "customers.export"]
    : ["reports.export"];
}

/** A built file stops beyond this many data rows (memory bound for one worker job). */
export const REPORT_FILE_MAX_ROWS = 200_000;
/** A signed file link is good for this long (at most the 15-minute report limit). */
export const REPORT_FILE_LINK_SECONDS = 5 * 60;
/** A file job still queued or running after this long is marked failed. */
export const REPORT_BUILD_STALE_HOURS = 6;
