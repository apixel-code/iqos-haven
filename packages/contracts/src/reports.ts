import { REPORT_TYPES, SALES_REPORT_BASES } from "@ih/domain";
import { z } from "zod";

/**
 * Report requests and jobs (roadmap step 110, ADR 0076). Parameters are typed per report; a
 * date range is Dubai days, at most 366 (checked again by the server). Inventory and customers
 * are snapshots and take no range.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = { from: isoDate, to: isoDate };
export const reportParamsSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("sales"), ...range, basis: z.enum(SALES_REPORT_BASES) }),
  z.strictObject({ type: z.literal("orders"), ...range }),
  z.strictObject({ type: z.literal("products"), ...range }),
  z.strictObject({ type: z.literal("inventory") }),
  z.strictObject({ type: z.literal("customers") }),
]);
export type ReportParams = z.infer<typeof reportParamsSchema>;

/** `commandId` makes a retried request return the same job; another body with it is refused. */
export const reportRequestSchema = z.strictObject({
  commandId: z.uuid(),
  report: reportParamsSchema,
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;

export const reportJobParamsSchema = z.strictObject({ id: z.uuid() });
export const reportJobSchema = z.strictObject({
  id: z.uuid(),
  type: z.enum(REPORT_TYPES),
  report: reportParamsSchema,
  /** `stream`: generated when downloaded; `file`: built by the worker and kept a few days. */
  delivery: z.enum(["stream", "file"]),
  status: z.enum(["ready", "queued", "running", "completed", "failed", "expired"]),
  estimatedRows: z.number().int().min(0),
  rowCount: z.number().int().min(0).nullable(),
  errorCode: z.string().max(64).nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  /** After this the job can no longer be downloaded. */
  expiresAt: z.iso.datetime().nullable(),
  /** Ready to download now (the download itself checks the rights again; step 112). */
  available: z.boolean(),
});
export type ReportJob = z.infer<typeof reportJobSchema>;
export const reportJobsResponseSchema = z.strictObject({
  items: z.array(reportJobSchema).max(50),
});
export type ReportJobsResponse = z.infer<typeof reportJobsResponseSchema>;
