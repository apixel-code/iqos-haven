import { z } from "zod";
const version = z.number().int().min(0).max(2147483646);
export const deliveryConfigurationSchema = z.strictObject({
  flatFeeFils: z.number().int().min(0).max(1_000_000_000),
  etaText: z.string().trim().min(1).max(500),
  freeThresholdFils: z.null(),
});
export const deliveryConfigurationWriteRequestSchema = z.strictObject({
  version,
  value: deliveryConfigurationSchema.nullable(),
});
export const deliveryConfigurationResponseSchema = z.strictObject({
  version: z.number().int().min(0),
  value: deliveryConfigurationSchema.nullable(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.uuid().nullable(),
});
const name = z.string().trim().min(1).max(100);
export const deliveryAreaCreateRequestSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  name,
  active: z.boolean(),
});
export const deliveryAreaUpdateRequestSchema = z.strictObject({
  version: version.min(1),
  name,
  active: z.boolean(),
});
export const deliveryAreaResponseSchema = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  name,
  emirate: z.literal("dubai"),
  active: z.boolean(),
  version: z.number().int().positive(),
  updatedBy: z.uuid(),
  updatedAt: z.iso.datetime(),
});
export const deliveryAreasQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.uuid().optional(),
});
export const deliveryAreaParamsSchema = z.strictObject({ id: z.uuid() });
export const deliveryConfigurationQuerySchema = z.strictObject({});
export const deliveryAreasResponseSchema = z.strictObject({
  items: z.array(deliveryAreaResponseSchema).max(100),
  nextCursor: z.uuid().nullable(),
});
export type DeliveryAreaCreateRequest = z.infer<typeof deliveryAreaCreateRequestSchema>;
export type DeliveryAreaUpdateRequest = z.infer<typeof deliveryAreaUpdateRequestSchema>;
export type DeliveryConfigurationWriteRequest = z.infer<
  typeof deliveryConfigurationWriteRequestSchema
>;
export type DeliveryAreasQuery = z.infer<typeof deliveryAreasQuerySchema>;
