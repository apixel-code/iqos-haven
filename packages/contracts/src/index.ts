import { z } from "zod";

/** Money on the wire: integer fils (AED × 100). Never a float. */
export const filsSchema = z.number().int().safe();

/** Standard error envelope returned by the implemented global API filter. */
export const errorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    fields: z.array(z.strictObject({ path: z.string().max(200), message: z.string().max(200) })),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const healthStatusSchema = z.enum(["ok", "degraded", "down"]);
export const dependencyStatusSchema = z.enum(["up", "down"]);

export const livenessResponseSchema = z.object({ status: z.literal("ok") });
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

export const readinessResponseSchema = z.object({
  status: healthStatusSchema,
  checks: z.object({ database: dependencyStatusSchema, queue: dependencyStatusSchema }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export * from "./events";
export * from "./auth";
