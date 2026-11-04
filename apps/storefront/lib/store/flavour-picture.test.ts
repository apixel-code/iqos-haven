import { describe, expect, it } from "vitest";
import type { StoreProductResponse } from "@ih/contracts";
import { pictureIndex, variantThumb } from "./flavour-picture";

const picture = (name: string, variantId: string | null) => ({
  alt: name,
  width: 1000,
  height: 700,
  variantId,
  urls: {
    large: `https://media.test/${name}/large.webp`,
    medium: `https://media.test/${name}/medium.webp`,
    thumb: `https://media.test/${name}/thumb.webp`,
  },
});
const product = (images: StoreProductResponse["images"]) => ({ images }) as StoreProductResponse;

describe("flavour pictures (ADR 0107)", () => {
  const images = [
    picture("main", null),
    picture("amber", "v-amber"),
    picture("silver", "v-silver"),
  ];

  it("finds the chosen flavour's picture, and nothing without one", () => {
    expect(pictureIndex(images, "v-silver")).toBe(2);
    expect(pictureIndex(images, "v-other")).toBe(-1);
    expect(pictureIndex(images, null)).toBe(-1);
  });

  it("shows the flavour's own thumbnail in the cart, else the main picture", () => {
    expect(variantThumb(product(images), "v-amber")).toBe("https://media.test/amber/thumb.webp");
    expect(variantThumb(product(images), "v-other")).toBe("https://media.test/main/thumb.webp");
    expect(variantThumb(product([]), "v-amber")).toBeNull();
  });
});
