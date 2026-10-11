import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@ih/contracts";
import { FormValidationError } from "./management";

type ImageType = (typeof IMAGE_TYPES)[number];

/** Client-side pre-check only; the server policy and the processor decide. */
export function uploadRequestFor(file: { type: string; size: number }) {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type))
    throw new FormValidationError("Choose a JPEG, PNG or WebP image.");
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES)
    throw new FormValidationError("Images must be at most 8 MB.");
  return { contentType: file.type as ImageType, bytes: file.size };
}

/** Builds the storage POST: policy fields first, the file last (required by S3 POST). */
export function uploadForm(fields: Record<string, string>, file: Blob): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append("file", file);
  return form;
}

const REJECTIONS: Record<string, string> = {
  unsupported_format: "Not a JPEG, PNG or WebP image.",
  type_mismatch: "The file type does not match its contents.",
  decode_failed: "The image is damaged or incomplete.",
  animated: "Animated images are not supported.",
  dimensions: "Images must be 200–8000 px on each side.",
  too_many_pixels: "The image has too many pixels.",
  too_large: "The image is larger than 8 MB.",
  size_mismatch: "The uploaded file did not match the selected one.",
  object_changed: "The file changed after upload.",
  object_missing: "The file did not arrive.",
  presign_failed: "The upload could not start.",
};
export function rejectionMessage(code: string | null): string {
  return (code && REJECTIONS[code]) ?? "The image could not be processed.";
}

/** Moves one image id up or down; returns the new full order. */
export function moved(ids: readonly string[], id: string, offset: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
