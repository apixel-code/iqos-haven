import {
  productCreateRequestSchema,
  productUpdateRequestSchema,
  type ProductCreateRequest,
  type ProductResponse,
  type ProductUpdateRequest,
} from "@ih/contracts";
import { aedToFils, FormValidationError, validate } from "./management";

const text = (data: FormData, field: string) => String(data.get(field) ?? "").trim();
const optionalText = (data: FormData, field: string) => text(data, field) || undefined;
function optionalInt(data: FormData, field: string, label: string): number | undefined {
  const raw = text(data, field);
  if (!raw) return undefined;
  if (!/^\d{1,7}$/.test(raw)) throw new FormValidationError(`${label} must be a whole number.`);
  return Number(raw);
}
/** Free-form rows are entered one per line as "Label: value". */
export function extraSpecs(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(":");
      if (index < 1) throw new FormValidationError('Write extra specifications as "Label: value".');
      return { label: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
    });
}
export function formatExtraSpecs(rows: ReadonlyArray<{ label: string; value: string }>) {
  return rows.map((row) => `${row.label}: ${row.value}`).join("\n");
}
function specs(type: string, data: FormData) {
  const extra = extraSpecs(text(data, "specs.extra"));
  const defined = <T extends Record<string, unknown>>(value: T) =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  if (type === "kit")
    return defined({
      batteryMah: optionalInt(data, "specs.batteryMah", "Battery"),
      maxOutputW: optionalInt(data, "specs.maxOutputW", "Max output"),
      podCapacityMl: optionalText(data, "specs.podCapacityMl"),
      coilOhm: optionalText(data, "specs.coilOhm"),
      charging: optionalText(data, "specs.charging"),
      display: optionalText(data, "specs.display"),
      inTheBox: optionalText(data, "specs.inTheBox"),
      extra,
    });
  return defined({
    liquidMl: optionalText(data, "specs.liquidMl"),
    batteryMah: optionalInt(data, "specs.batteryMah", "Battery"),
    rechargeable: data.get("specs.rechargeable") === "on" ? true : undefined,
    charging: optionalText(data, "specs.charging"),
    extra,
  });
}
function fields(data: FormData, includeSeo: boolean) {
  const type = text(data, "type");
  const compare = text(data, "compareAt");
  return {
    type,
    name: text(data, "name"),
    slug: text(data, "slug"),
    brandId: text(data, "brandId"),
    categoryId: text(data, "categoryId"),
    puffCount: type === "kit" ? null : (optionalInt(data, "puffCount", "Puffs") ?? null),
    basePriceFils: aedToFils(text(data, "price")),
    compareAtPriceFils: compare ? aedToFils(compare) : null,
    description: text(data, "description"),
    isNew: data.get("isNew") === "on",
    specs: specs(type, data),
    ...(includeSeo
      ? {
          seo: {
            title: text(data, "seo.title") || null,
            description: text(data, "seo.description") || null,
          },
        }
      : {}),
  };
}
export function productCreateCommand(data: FormData, includeSeo: boolean): ProductCreateRequest {
  return validate(productCreateRequestSchema, fields(data, includeSeo));
}
export function productUpdateCommand(
  product: ProductResponse,
  data: FormData,
  includeSeo: boolean,
): ProductUpdateRequest {
  return validate(productUpdateRequestSchema, {
    ...fields(data, includeSeo),
    version: product.version,
  });
}
