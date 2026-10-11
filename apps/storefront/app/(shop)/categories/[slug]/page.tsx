import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";
import { ListingPage } from "../../listing-page";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function categoryOf(slug: string) {
  const { items } = await storeRead((api, shopper) => api.categories(shopper));
  return items.find((category) => category.slug === slug) ?? null;
}

// Runs only for requests the routing gate let through.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const category = await categoryOf((await params).slug);
  return { title: category ? `${category.name} · ${SITE.name}` : SITE.name };
}

/** A catalogue category managed in the admin (beyond the two fixed product types). */
export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const category = await categoryOf(slug);
  if (!category) notFound();
  return (
    <ListingPage
      path={`/categories/${category.slug}`}
      searchParams={searchParams}
      fixed={{ category: category.slug }}
      trail={[
        { label: "Home", href: "/" },
        { label: "Shop", href: "/shop" },
        { label: category.name },
      ]}
      head={{ title: category.name }}
      emptyBody="This category has no products available right now."
    />
  );
}
