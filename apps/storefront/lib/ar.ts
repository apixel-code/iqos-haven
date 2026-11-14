import type { Emirate } from "@ih/contracts";

/**
 * Arabic landing pages (ADR 0120): the copy the Arabic pages are built from. Facts (products,
 * categories, fee, delivery time, areas) come from the API like on the English pages; only the
 * headings and sentences around them are written here. Brand and product names stay in Latin
 * letters, as on the packs.
 */
export const AR_PREFIX = "/ar";

export const AR = {
  siteTitle: "إيكوس هيفن",
  homeTitle: "أجهزة إيكوس إيلوما وأعواد تيريا في الإمارات",
  homeLead:
    "متجر للبالغين فقط يوصل أجهزة IQOS ILUMA وأعواد TEREA إلى جميع إمارات الدولة، والدفع نقداً عند الاستلام.",
  devices: "أجهزة إيكوس إيلوما",
  devicesLead: "جميع موديلات IQOS ILUMA وألوانها. جميعها تعمل مع أعواد TEREA فقط.",
  sticks: "أعواد تيريا",
  sticksLead: "أعواد TEREA لأجهزة IQOS ILUMA من سبع إصدارات، تُباع بالكرتونة (10 علب).",
  editions: "إصدارات تيريا",
  models: "موديلات إيلوما",
  delivery: "التوصيل في الإمارات",
  deliveryLead: "اختر إمارتك لترى المناطق التي نوصل إليها. الدفع نقداً عند الاستلام.",
  home: "الرئيسية",
  shopAll: "عرض الكل",
  adults: "للبالغين من عمر 18 عاماً فما فوق فقط.",
  cod: "الدفع نقداً عند الاستلام",
  english: "English",
  noProducts: "ستظهر المنتجات هنا فور توفرها.",
} as const;

/** TEREA editions by their country, as their category slug names them. */
const COUNTRIES: Readonly<Record<string, string>> = {
  "terea-uae": "الإمارات",
  "terea-japan": "اليابان",
  "terea-indonesia": "إندونيسيا",
  "terea-kazakhstan": "كازاخستان",
  "terea-kyrgyzstan": "قيرغيزستان",
  "terea-uzbekistan": "أوزبكستان",
  "terea-swiss": "سويسرا",
};

export const EMIRATE_NAMES_AR: Readonly<Record<Emirate, string>> = {
  abu_dhabi: "أبوظبي",
  dubai: "دبي",
  sharjah: "الشارقة",
  ajman: "عجمان",
  umm_al_quwain: "أم القيوين",
  ras_al_khaimah: "رأس الخيمة",
  fujairah: "الفجيرة",
};

/** An Arabic heading and lead for a category, or null when the category has no Arabic page. */
export function arabicCategory(category: { slug: string; name: string; productCount: number }) {
  const country = COUNTRIES[category.slug];
  if (country)
    return {
      title: `أعواد تيريا ${country} (${category.name})`,
      lead: `أعواد TEREA من إصدار ${country} لأجهزة IQOS ILUMA: ${category.productCount} ${category.productCount === 1 ? "نكهة" : "نكهات"}. التوصيل إلى جميع الإمارات والدفع عند الاستلام.`,
    };
  if (category.slug.startsWith("iqos-iluma"))
    return {
      title: `جهاز ${category.name}`,
      lead: `${category.name} بجميع الألوان المتوفرة (${category.productCount}). يعمل مع أعواد TEREA فقط. التوصيل إلى جميع الإمارات والدفع عند الاستلام.`,
    };
  return null;
}

/** The English page an Arabic page mirrors, and back: `/ar/sticks` ↔ `/sticks`, `/ar` ↔ `/`. */
export const englishPath = (arabicPath: string) =>
  arabicPath === AR_PREFIX ? "/" : arabicPath.slice(AR_PREFIX.length);
export const arabicPath = (englishPath: string) =>
  englishPath === "/" ? AR_PREFIX : `${AR_PREFIX}${englishPath}`;

/**
 * Canonical and language alternates (hreflang) for a page that exists in both languages.
 * English is the default for searchers whose language matches neither.
 */
export function languageAlternates(path: string, language: "en" | "ar") {
  const en = language === "en" ? path : englishPath(path);
  const ar = language === "ar" ? path : arabicPath(path);
  return { canonical: path, languages: { en, ar, "x-default": en } };
}
