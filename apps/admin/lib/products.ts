import {
  NEW_PRODUCT_TYPES,
  productCreateRequestSchema,
  type ProductType,
  productUpdateRequestSchema,
  type ProductCreateRequest,
  type ProductResponse,
  type ProductUpdateRequest,
} from "@ih/contracts";
import { aedToFils, FormValidationError, validate } from "./management";

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  device: "IQOS device",
  sticks: "TEREA sticks",
  disposable: "Disposable",
  kit: "Kit",
};
/** New products are heated tobacco (ADR 0101); a stored vape type stays selectable on its product. */
export function productTypeChoices(current?: ProductType): ProductType[] {
  return current && !NEW_PRODUCT_TYPES.some((type) => type === current)
    ? [...NEW_PRODUCT_TYPES, current]
    : [...NEW_PRODUCT_TYPES];
}

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
/**
 * TEREA flavour profiles (ADR 0103), one per line:
 * "flavour | body 1–5 | intensity 1–5 | cooling 0–5 | capsule or - | notes (optional)".
 */
export function flavourProfiles(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      const [flavour, body, intensity, cooling, capsule] = parts
        .slice(0, 5)
        .map((part) => part.trim());
      // Notes may contain "|" themselves: everything after the fifth separator, as typed.
      const note = parts.slice(5).join("|").trim();
      const score = (raw: string | undefined, min: number) =>
        raw !== undefined && /^\d$/.test(raw) && Number(raw) >= min && Number(raw) <= 5
          ? Number(raw)
          : undefined;
      const parsed = {
        flavour: flavour ?? "",
        body: score(body, 1),
        intensity: score(intensity, 1),
        cooling: score(cooling, 0),
        capsule: /^(capsule|yes)$/i.test(capsule ?? "")
          ? true
          : /^(-|no)$/i.test(capsule ?? "")
            ? false
            : undefined,
      };
      if (
        !parsed.flavour ||
        parsed.body === undefined ||
        parsed.intensity === undefined ||
        parsed.cooling === undefined ||
        parsed.capsule === undefined
      )
        throw new FormValidationError(
          `Write each flavour profile as "flavour | body 1-5 | intensity 1-5 | cooling 0-5 | capsule or - | notes": ${line.slice(0, 60)}`,
        );
      return {
        flavour: parsed.flavour.toLowerCase(),
        body: parsed.body,
        intensity: parsed.intensity,
        cooling: parsed.cooling,
        capsule: parsed.capsule,
        ...(note ? { notes: note } : {}),
      };
    });
}
export function formatFlavourProfiles(
  rows: ReadonlyArray<{
    flavour: string;
    body: number;
    intensity: number;
    cooling: number;
    capsule: boolean;
    notes?: string;
  }>,
) {
  return rows
    .map((row) =>
      [
        row.flavour,
        row.body,
        row.intensity,
        row.cooling,
        row.capsule ? "capsule" : "-",
        ...(row.notes ? [row.notes] : []),
      ].join(" | "),
    )
    .join("\n");
}
function specs(type: string, data: FormData) {
  const extra = extraSpecs(text(data, "specs.extra"));
  const defined = <T extends Record<string, unknown>>(value: T) =>
    Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  if (type === "device")
    return defined({
      compatibleSticks: optionalText(data, "specs.compatibleSticks"),
      sessionsPerCharge: optionalInt(data, "specs.sessionsPerCharge", "Uses per charge"),
      chargingTime: optionalText(data, "specs.chargingTime"),
      inTheBox: optionalText(data, "specs.inTheBox"),
      extra,
    });
  if (type === "sticks")
    return defined({
      origin: optionalText(data, "specs.origin"),
      sticksPerPack: optionalInt(data, "specs.sticksPerPack", "Sticks per pack"),
      packsPerUnit: optionalInt(data, "specs.packsPerUnit", "Packs per unit"),
      flavourNotes: optionalText(data, "specs.flavourNotes"),
      profiles: (() => {
        const rows = flavourProfiles(text(data, "specs.profiles"));
        return rows.length ? rows : undefined;
      })(),
      extra,
    });
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
    puffCount: type === "disposable" ? (optionalInt(data, "puffCount", "Puffs") ?? null) : null,
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
