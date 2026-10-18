import { describe, expect, it } from "vitest";
import type { BrandResponse } from "@ih/contracts";
import {
  brandCreateCommand,
  brandUpdateCommand,
  categoryCreateCommand,
  plural,
  slugify,
} from "./catalogue";
import { afterEach, vi } from "vitest";
import { ApiError } from "./auth";
import { FormValidationError, managementError, managementRequest } from "./management";

const data = (entries: Record<string, string>) => {
  const result = new FormData();
  for (const [key, value] of Object.entries(entries)) result.set(key, value);
  return result;
};
const brand: BrandResponse = {
  id: "0199c0de-0000-7000-8000-000000000001",
  name: "Synthetic",
  slug: "synthetic",
  description: "",
  active: true,
  sortOrder: 0,
  logoAssetId: null,
  publishedProductCount: 0,
  version: 3,
  trashedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("brand form commands", () => {
  it("suggests URL-safe slugs from names", () => {
    expect(slugify("  Élan Vapour — Pro 2 ")).toBe("elan-vapour-pro-2");
    expect(slugify("---")).toBe("");
    expect(slugify("a".repeat(200))).toHaveLength(150);
  });

  it("builds strict create/update commands with the current version", () => {
    expect(brandCreateCommand(data({ name: " Nova ", slug: "nova", active: "on" }), false)).toEqual(
      {
        name: "Nova",
        slug: "nova",
        description: "",
        active: true,
        sortOrder: 0,
      },
    );
    expect(
      brandUpdateCommand(brand, data({ name: "Nova", slug: "nova", sortOrder: "4" }), false),
    ).toEqual({
      version: 3,
      name: "Nova",
      slug: "nova",
      description: "",
      active: false,
      sortOrder: 4,
    });
  });

  it("sends SEO only for callers allowed to write it", () => {
    const form = data({ name: "Nova", slug: "nova", "seo.title": "Title" });
    expect(brandCreateCommand(form, false)).not.toHaveProperty("seo");
    expect(brandCreateCommand(form, true).seo).toEqual({ title: "Title", description: null });
  });

  it("rejects invalid slugs and display orders before sending", () => {
    expect(() => brandCreateCommand(data({ name: "Nova", slug: "Bad Slug" }), false)).toThrow(
      FormValidationError,
    );
    for (const sortOrder of ["-1", "1.5", "1000001"])
      expect(() =>
        brandCreateCommand(data({ name: "Nova", slug: "nova", sortOrder }), false),
      ).toThrow(FormValidationError);
  });

  it("builds category commands without a description", () => {
    const command = categoryCreateCommand(
      data({ name: "Disposables", slug: "disposables", description: "ignored", active: "on" }),
      false,
    );
    expect(command).toEqual({
      name: "Disposables",
      slug: "disposables",
      active: true,
      sortOrder: 0,
    });
  });

  it("pluralizes counts", () => {
    expect(plural(1, "product")).toBe("1 product");
    expect(plural(0, "product")).toBe("0 products");
  });
});

describe("brand logo and category image in the commands (parity G-A7)", () => {
  const image = "0199c0de-0000-7000-8000-0000000000aa";
  it("leaves the image unchanged when the form has no image field", () => {
    expect(brandCreateCommand(data({ name: "Nova", slug: "nova" }), false)).not.toHaveProperty(
      "logoAssetId",
    );
  });
  it("sends the chosen image, or null when it was removed", () => {
    expect(
      brandUpdateCommand(brand, data({ name: "Nova", slug: "nova", imageAssetId: image }), false),
    ).toMatchObject({ logoAssetId: image });
    expect(
      brandUpdateCommand(brand, data({ name: "Nova", slug: "nova", imageAssetId: "" }), false),
    ).toMatchObject({ logoAssetId: null });
    expect(
      categoryCreateCommand(data({ name: "Pods", slug: "pods", imageAssetId: image }), false),
    ).toMatchObject({ imageAssetId: image });
  });
});

describe("catalogue conflict messages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the stable 409 reason from the envelope and explains it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: "IN_USE", message: "x", requestId: "r", fields: [] } }),
            { status: 409 },
          ),
        ),
    );
    const error = await managementRequest("/brands/x/trash", { parse: (v) => v }, "POST", {}).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("IN_USE");
    expect(managementError(error, true)).toContain("published products or stock history");
    expect(managementError(new ApiError(409, null, "DUPLICATE"), true)).toContain("already used");
    expect(managementError(new ApiError(409, null, "TRASHED"), true)).toContain("Restore");
    expect(managementError(new ApiError(409), true)).toContain("Reload");
  });
});
