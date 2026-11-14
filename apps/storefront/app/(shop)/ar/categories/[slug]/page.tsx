import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AR, arabicCategory, languageAlternates } from "@/lib/ar";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";
import { ListingPage } from "../../../listing-page";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** A category with an Arabic page (TEREA editions, ILUMA models), under its current slug only. */
async function categoryOf(slug: string) {
  const { items } = await storeRead((api, shopper) => api.categories(shopper));
  const category = items.find((item) => item.slug === slug && item.productCount > 0);
  const ar = category ? arabicCategory(category) : null;
  return category && ar ? { category, ar } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await categoryOf((await params).slug);
  if (!found) return { title: SITE.name };
  return {
    title: `${found.ar.title} · ${SITE.name}`,
    description: found.ar.lead,
    alternates: languageAlternates(`/ar/categories/${found.category.slug}`, "ar"),
  };
}

/** Arabic category page (ADR 0120): the category's products with an Arabic heading. */
export default async function ArabicCategoryPage({ params, searchParams }: Props) {
  const found = await categoryOf((await params).slug);
  if (!found) notFound();
  const { category, ar } = found;
  const parent = category.slug.startsWith("terea")
    ? { label: AR.sticks, href: "/ar/sticks" }
    : { label: AR.devices, href: "/ar/devices" };
  return (
    <div lang="ar" dir="rtl">
      <ListingPage
        path={`/ar/categories/${category.slug}`}
        searchParams={searchParams}
        fixed={{ category: category.slug }}
        trail={[{ label: AR.home, href: "/ar" }, parent, { label: ar.title }]}
        head={{ title: ar.title, lead: ar.lead }}
        emptyBody={AR.noProducts}
      />
    </div>
  );
}
