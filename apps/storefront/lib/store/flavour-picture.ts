import type { StoreProductResponse } from "@ih/contracts";

/**
 * Flavour pictures (ADR 0107). The buy box announces the variant the shopper has chosen; the
 * gallery on the same page brings that variant's picture forward. A plain window event keeps the
 * two client components independent (the page between them is a server component).
 */
export const VARIANT_CHOSEN = "ih:variant-chosen";
export type VariantChosen = CustomEvent<{ productSlug: string; variantId: string | null }>;

export function announceVariant(productSlug: string, variantId: string | null) {
  window.dispatchEvent(new CustomEvent(VARIANT_CHOSEN, { detail: { productSlug, variantId } }));
}

/** Position of the picture showing this variant, or -1 when it has none. */
export function pictureIndex(images: StoreProductResponse["images"], variantId: string | null) {
  return variantId ? images.findIndex((image) => image.variantId === variantId) : -1;
}

/** The thumbnail for a cart line or toast: the variant's own picture, else the main one. */
export function variantThumb(product: StoreProductResponse, variantId: string) {
  const at = pictureIndex(product.images, variantId);
  return (product.images[at] ?? product.images[0])?.urls.thumb ?? null;
}
