import { z } from "zod";

/**
 * Product media uploads (roadmap step 48, ADR 0018). The browser uploads straight into the
 * private quarantine bucket with a short-lived POST policy; bytes stay untrusted until processing
 * (step 49) marks the asset `ready`.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PRODUCT_IMAGES = 8;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MEDIA_STATES = [
  "pending",
  "uploaded",
  "processing",
  "ready",
  "rejected",
  "expired",
] as const;

export const mediaUploadRequestSchema = z.strictObject({
  contentType: z.enum(IMAGE_TYPES),
  /** The file's size; the upload policy refuses anything larger. */
  bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
});
export const mediaAssetSchema = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  state: z.enum(MEDIA_STATES),
  declaredType: z.enum(IMAGE_TYPES),
  declaredBytes: z.number().int(),
  observedBytes: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  error: z.string().nullable(),
  uploadExpiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const mediaUploadResponseSchema = z.strictObject({
  asset: mediaAssetSchema,
  /** POST these fields plus the file (last) as multipart/form-data to `url`. */
  upload: z.strictObject({
    url: z.url(),
    fields: z.record(z.string(), z.string()),
  }),
});
export const productMediaResponseSchema = z.strictObject({
  items: z.array(mediaAssetSchema).max(100),
});
export const mediaAssetParamsSchema = z.strictObject({ assetId: z.uuid() });

export type MediaUploadRequest = z.infer<typeof mediaUploadRequestSchema>;
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type MediaUploadResponse = z.infer<typeof mediaUploadResponseSchema>;
