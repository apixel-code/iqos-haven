import {
  contentSchema,
  CURRENT_CONTENT_SCHEMA,
  type ContentLink,
  type ContentSectionKey,
} from "@ih/contracts";
import { FormValidationError } from "./management";

/** Tab labels and help, in the prototype's order (`VIEWS.content`). */
export const CONTENT_TABS: ReadonlyArray<{ key: ContentSectionKey; label: string; help: string }> =
  [
    {
      key: "ticker",
      label: "Promotional bar",
      help: "Short messages that scroll across the top of the store, in this order.",
    },
    { key: "hero", label: "Hero banner", help: "The large banner at the top of the home page." },
    {
      key: "featured",
      label: "Featured products",
      help: "Shown in the Featured row on the home page. Out-of-stock products stay visible with an Out of stock label.",
    },
    {
      key: "best_sellers",
      label: "Best sellers",
      help: "Automatic uses units sold in the last 30 days, or pick the products yourself.",
    },
    {
      key: "brands",
      label: "Shop by brand",
      help: "Which brands appear in Shop by brand, and their order. Inactive brands can't be shown.",
    },
    {
      key: "campaign_banner",
      label: "Promo banners",
      help: "Up to two banners further down the home page.",
    },
    {
      key: "offers",
      label: "Offers section",
      help: "Products to highlight in the Offers section.",
    },
  ];

/** A new hero slide (ADR 0097). Blank text is filled in before saving. */
export function emptyHeroSlide(): Record<string, unknown> {
  return {
    style: "navy",
    eyebrow: null,
    title: "",
    subtitle: null,
    cta: null,
    secondaryCta: null,
    image: null,
  };
}

/** A starting document for a section never saved. Blank text is filled in before saving. */
export function emptyContent(key: ContentSectionKey): Record<string, unknown> {
  switch (key) {
    case "ticker":
      return { enabled: false, messages: ["", ""] };
    case "hero":
      return { slides: [emptyHeroSlide()] };
    case "featured":
      return { productIds: [] };
    case "best_sellers":
      return { mode: "auto", productIds: [] };
    case "brands":
      return { brandIds: [] };
    case "campaign_banner":
      return { banners: [] };
    case "offers":
      return { enabled: false, title: "", productIds: [] };
  }
}

/** Checks the draft with the same schema the API uses; returns the field paths at fault. */
export function checkDraft(key: ContentSectionKey, draft: unknown): Record<string, unknown> {
  const parsed = contentSchema(key, CURRENT_CONTENT_SCHEMA[key]).safeParse(draft);
  if (parsed.success) return parsed.data as Record<string, unknown>;
  const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].filter(
    Boolean,
  );
  throw new FormValidationError(
    `Check these fields: ${paths.slice(0, 6).join(", ") || "the section"}. Text is plain (no < or >), and every required field needs a value.`,
  );
}

const REASONS: Record<string, string> = {
  missing: "no longer exists",
  not_visible: "is not visible in the store (draft, hidden or in Trash)",
  not_ready: "is not a processed image yet",
};
const KINDS: Record<string, string> = {
  product: "A product",
  brand: "A brand",
  category: "A category",
  image: "An image",
};
/** One line per reference that stops publishing (`fields` of a CONTENT_REFERENCES answer). */
export function problemLines(
  problems: ReadonlyArray<{ kind: string; id: string; reason: string }>,
  names: Readonly<Record<string, string>> = {},
): string[] {
  return problems.map(
    (problem) =>
      `${names[problem.id] ? `“${names[problem.id]}”` : (KINDS[problem.kind] ?? "An item")} ${REASONS[problem.reason] ?? "can't be shown"}.`,
  );
}

export const LINK_KINDS: ReadonlyArray<{ kind: ContentLink["kind"]; label: string }> = [
  { kind: "shop", label: "All products" },
  { kind: "category", label: "A category" },
  { kind: "brand", label: "A brand" },
  { kind: "product", label: "A product" },
];

/** Moves one entry up or down. */
export function move<T>(list: readonly T[], index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
