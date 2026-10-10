import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * Untrusted image processing (roadmap step 49, architecture §11 Media upload). Never trusts the
 * extension or declared MIME: magic bytes must match the declaration, the decoder must agree on
 * the format, animated/oversized/pixel-bomb inputs are refused, and only re-encoded WebP
 * derivatives (metadata stripped, EXIF orientation applied) leave this module.
 */
export type SourceImageType = "image/jpeg" | "image/png" | "image/webp";

export interface ImageLimits {
  readonly maxBytes: number;
  readonly maxSide: number;
  readonly minSide: number;
  readonly maxPixels: number;
}
export const IMAGE_LIMITS: ImageLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxSide: 8000,
  minSide: 200,
  maxPixels: 40_000_000,
};

/** Public sizes (longest side); smaller sources are never enlarged. */
export const DERIVATIVE_SIZES = { large: 1600, medium: 800, thumb: 320 } as const;
export type DerivativeName = keyof typeof DERIVATIVE_SIZES;

export type ImageRejection =
  | "too_large"
  | "type_mismatch"
  | "unsupported_format"
  | "animated"
  | "dimensions"
  | "too_many_pixels"
  | "decode_failed";
export class ImageRejectedError extends Error {
  constructor(readonly code: ImageRejection) {
    super(code);
    this.name = "ImageRejectedError";
  }
}

// Processing is CPU/memory bound and must not retain decoded pixels between jobs.
sharp.cache(false);

/** Detects the container from its signature; anything else is unsupported. */
export function sniffImageType(bytes: Uint8Array): SourceImageType | null {
  const at = (offset: number, signature: number[]) =>
    signature.every((value, index) => bytes[offset + index] === value);
  if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]))
    return "image/webp";
  return null;
}

/**
 * APNG keeps a valid first frame, so decoders may report one page: refuse any PNG whose chunks
 * declare animation (`acTL`) before the image data.
 */
export function isAnimatedPng(bytes: Uint8Array): boolean {
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length =
      ((bytes[offset]! << 24) |
        (bytes[offset + 1]! << 16) |
        (bytes[offset + 2]! << 8) |
        bytes[offset + 3]!) >>>
      0;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "acTL") return true;
    if (type === "IDAT" || type === "IEND") return false;
    offset += 12 + length;
  }
  return false;
}

const FORMAT: Record<SourceImageType, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface ProcessedImage {
  /** Displayed (orientation-corrected) source dimensions. */
  readonly width: number;
  readonly height: number;
  /** SHA-256 of the original bytes. */
  readonly sha256: string;
  readonly derivatives: ReadonlyArray<{
    readonly name: DerivativeName;
    readonly width: number;
    readonly height: number;
    readonly contentType: "image/webp";
    readonly body: Buffer;
  }>;
}

export async function processImage(
  bytes: Uint8Array,
  declared: SourceImageType,
  limits: ImageLimits = IMAGE_LIMITS,
): Promise<ProcessedImage> {
  if (bytes.byteLength < 1 || bytes.byteLength > limits.maxBytes)
    throw new ImageRejectedError("too_large");
  const sniffed = sniffImageType(bytes);
  if (!sniffed) throw new ImageRejectedError("unsupported_format");
  if (sniffed !== declared) throw new ImageRejectedError("type_mismatch");
  if (sniffed === "image/png" && isAnimatedPng(bytes)) throw new ImageRejectedError("animated");
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const options = {
    // The decoder refuses inputs above the pixel budget before allocating them.
    limitInputPixels: limits.maxPixels,
    // Strict: anything libvips reports even as a warning (truncation, bad CRC) is refused.
    failOn: "warning" as const,
    animated: false,
  };
  let metadata;
  try {
    metadata = await sharp(input, options).metadata();
  } catch {
    throw new ImageRejectedError("decode_failed");
  }
  if (metadata.format !== FORMAT[declared]) throw new ImageRejectedError("type_mismatch");
  if ((metadata.pages ?? 1) > 1) throw new ImageRejectedError("animated");
  const rawWidth = metadata.width ?? 0;
  const rawHeight = metadata.height ?? 0;
  if (rawWidth * rawHeight > limits.maxPixels) throw new ImageRejectedError("too_many_pixels");
  // EXIF orientations 5–8 rotate by 90°, swapping the displayed sides.
  const swapped = (metadata.orientation ?? 1) >= 5;
  const width = swapped ? rawHeight : rawWidth;
  const height = swapped ? rawWidth : rawHeight;
  if (Math.min(width, height) < limits.minSide || Math.max(width, height) > limits.maxSide)
    throw new ImageRejectedError("dimensions");
  try {
    const derivatives = [];
    for (const [name, side] of Object.entries(DERIVATIVE_SIZES) as Array<
      [DerivativeName, number]
    >) {
      // rotate() applies orientation; sharp writes no metadata unless asked to keep it.
      const { data, info } = await sharp(input, options)
        .rotate()
        .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      derivatives.push({
        name,
        width: info.width,
        height: info.height,
        contentType: "image/webp" as const,
        body: data,
      });
    }
    return {
      width,
      height,
      sha256: createHash("sha256").update(input).digest("hex"),
      derivatives,
    };
  } catch {
    throw new ImageRejectedError("decode_failed");
  }
}
