import { z } from "zod";
import { catalogueText } from "./catalogue";

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
  "removed",
] as const;

export const mediaUploadRequestSchema = z.strictObject({
  contentType: z.enum(IMAGE_TYPES),
  /** The file's size; the upload policy refuses anything larger. */
  bytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
});
export const mediaAssetSchema = z.strictObject({
  id: z.uuid(),
  /** Null for a content image (home sections, step 97), which belongs to no product. */
  productId: z.uuid().nullable(),
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

// --- Gallery (step 50, ADR 0020) ---
const version = z.number().int().min(1).max(2147483646);
export const DERIVATIVE_NAMES = ["large", "medium", "thumb"] as const;
export const galleryImageSchema = z.strictObject({
  id: z.uuid(),
  mediaAssetId: z.uuid(),
  isPrimary: z.boolean(),
  sortOrder: z.number().int().min(0),
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  version: z.number().int().positive(),
  /** Short-lived signed links to sanitized derivatives (admin preview only; never public). */
  urls: z.strictObject({ large: z.url(), medium: z.url(), thumb: z.url() }),
});
export const productGalleryResponseSchema = z.strictObject({
  productId: z.uuid(),
  images: z.array(galleryImageSchema).max(MAX_PRODUCT_IMAGES),
  /** Uploads not (yet) in the gallery, newest first: processing state and failures to recover. */
  uploads: z.array(mediaAssetSchema).max(50),
});
export const galleryAttachRequestSchema = z.strictObject({
  mediaAssetId: z.uuid(),
  alt: catalogueText(0, 500).default(""),
});
export const galleryUpdateRequestSchema = z.strictObject({
  version,
  alt: catalogueText(0, 500),
  /** `true` moves the primary image here; the primary cannot be unset directly. */
  isPrimary: z.boolean(),
});
export const galleryReorderRequestSchema = z.strictObject({
  /** Every current image exactly once, in the new order. */
  imageIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_PRODUCT_IMAGES)
    .refine((ids) => new Set(ids).size === ids.length, "Each image once"),
});
export const galleryRemoveRequestSchema = z.strictObject({ version });
export const galleryImageParamsSchema = z.strictObject({ id: z.uuid(), imageId: z.uuid() });

export type GalleryImage = z.infer<typeof galleryImageSchema>;
export type ProductGalleryResponse = z.infer<typeof productGalleryResponseSchema>;
export type GalleryAttachRequest = z.input<typeof galleryAttachRequestSchema>;
export type GalleryUpdateRequest = z.infer<typeof galleryUpdateRequestSchema>;
export type GalleryReorderRequest = z.infer<typeof galleryReorderRequestSchema>;

// --- Brand logos and category images (parity G-A7, ADR 0091) ---
/** Upload status of a catalogue image, with a short-lived preview link once processed. */
export const catalogueImageResponseSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(MEDIA_STATES),
  error: z.string().nullable(),
  url: z.url().nullable(),
});
export type CatalogueImageResponse = z.infer<typeof catalogueImageResponseSchema>;
