import {
  brandCreateRequestSchema,
  brandUpdateRequestSchema,
  categoryCreateRequestSchema,
  categoryUpdateRequestSchema,
  type BrandCreateRequest,
  type BrandResponse,
  type BrandUpdateRequest,
  type CategoryCreateRequest,
  type CategoryResponse,
  type CategoryUpdateRequest,
} from "@ih/contracts";
import { FormValidationError, validate } from "./management";

/** URL slug suggestion from a name (ASCII letters/digits, single hyphens). The server validates. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150)
    .replace(/-+$/g, "");
}
const text = (data: FormData, field: string) => String(data.get(field) ?? "").trim();
function sortOrder(data: FormData): number {
  const raw = text(data, "sortOrder") || "0";
  if (!/^\d{1,6}$/.test(raw))
    throw new FormValidationError("Display order must be a whole number from 0 to 100000.");
  return Number(raw);
}
/** SEO fields are sent only by callers holding `seo.write`; others leave them unchanged. */
function seo(data: FormData) {
  return {
    title: text(data, "seo.title") || null,
    description: text(data, "seo.description") || null,
  };
}
export function brandCreateCommand(data: FormData, includeSeo: boolean): BrandCreateRequest {
  return validate(brandCreateRequestSchema, {
    name: text(data, "name"),
    slug: text(data, "slug"),
    description: text(data, "description"),
    active: data.get("active") === "on",
    sortOrder: sortOrder(data),
    ...(includeSeo ? { seo: seo(data) } : {}),
  });
}
export function brandUpdateCommand(
  brand: BrandResponse,
  data: FormData,
  includeSeo: boolean,
): BrandUpdateRequest {
  return validate(brandUpdateRequestSchema, {
    version: brand.version,
    name: text(data, "name"),
    slug: text(data, "slug"),
    description: text(data, "description"),
    active: data.get("active") === "on",
    sortOrder: sortOrder(data),
    ...(includeSeo ? { seo: seo(data) } : {}),
  });
}
export function categoryCreateCommand(data: FormData, includeSeo: boolean): CategoryCreateRequest {
  return validate(categoryCreateRequestSchema, {
    name: text(data, "name"),
    slug: text(data, "slug"),
    active: data.get("active") === "on",
    sortOrder: sortOrder(data),
    ...(includeSeo ? { seo: seo(data) } : {}),
  });
}
export function categoryUpdateCommand(
  category: CategoryResponse,
  data: FormData,
  includeSeo: boolean,
): CategoryUpdateRequest {
  return validate(categoryUpdateRequestSchema, {
    version: category.version,
    name: text(data, "name"),
    slug: text(data, "slug"),
    active: data.get("active") === "on",
    sortOrder: sortOrder(data),
    ...(includeSeo ? { seo: seo(data) } : {}),
  });
}
export function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
