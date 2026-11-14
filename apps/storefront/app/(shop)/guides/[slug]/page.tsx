import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { guidePlainText, readGuideBody, STORE_CARDS_MAX } from "@ih/contracts";
import {
  GuideBody,
  guideProductSlugs,
  guideSections,
  readingMinutes,
} from "@/components/guide-body";
import { SectionHead } from "@/components/home-sections";
import { Icon } from "@/components/icons";
import { JsonLd } from "@/components/json-ld";
import { Breadcrumbs } from "@/components/listing";
import { ProductRail } from "@/components/product-card";
import { guideTopicOf, RelatedGuides } from "@/components/related-guides";
import { ageGate } from "@/lib/age/runtime";
import { breadcrumbJsonLd, guideJsonLd } from "@/lib/seo-data";
import { readSeoPolicy } from "@/lib/seo-policy";
import { SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";

type Props = { params: Promise<{ slug: string }> };
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function guideOf(slug: string) {
  // A slug that cannot exist is not worth an API call.
  if (slug.length > 120 || !SLUG.test(slug)) return null;
  return storeRead((api, shopper) => api.guide(shopper, slug));
}

/** The products a guide links to, as cards. A failed read shows no row, never a failed page. */
async function productsOf(slugs: readonly string[]) {
  if (!slugs.length) return [];
  try {
    const { items } = await storeRead((api, shopper) =>
      api.productCards(shopper, slugs.slice(0, STORE_CARDS_MAX)),
    );
    return items.map((item) => item.card);
  } catch {
    return [];
  }
}

// Runs only for requests the routing gate let through, like every catalogue page (ADR 0114).
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const guide = await guideOf((await params).slug);
  if (!guide) return { title: SITE.name };
  return {
    title: `${guide.title} · ${SITE.name}`,
    description: guide.summary,
    alternates: { canonical: `/guides/${guide.slug}` },
  };
}

const date = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Asia/Dubai",
});

const SHOP = {
  terea: { href: "/sticks", label: "Shop TEREA sticks" },
  iqos: { href: "/devices", label: "Shop IQOS ILUMA devices" },
} as const;

/**
 * One guide (ADR 0117): a single reading column with the date and reading time, an "On this
 * page" list, the products the guide mentions, a way to order, and the other guides on the
 * topic. Structured data only while the Owner offers the catalogue.
 */
export default async function GuidePage({ params }: Props) {
  const guide = await guideOf((await params).slug);
  if (!guide) notFound();
  const { blocks } = readGuideBody(guide.body);
  const sections = guideSections(blocks);
  const topic = guideTopicOf(guide.slug);
  const [products, offered] = await Promise.all([
    productsOf(guideProductSlugs(blocks)),
    readSeoPolicy().then((policy) => policy.indexing === "catalogue"),
  ]);
  const trail = [
    { label: "Home", href: "/" },
    { label: "Guides", href: "/guides" },
    { label: guide.title },
  ];
  const origin = ageGate().runtime.origins[0]!;
  const updated = guide.updatedAt.slice(0, 10) !== guide.publishedAt.slice(0, 10);
  const minutes = readingMinutes(guidePlainText(blocks));
  return (
    <>
      {offered && (
        <>
          <JsonLd data={guideJsonLd(guide, origin, SITE.name)} />
          <JsonLd data={breadcrumbJsonLd(trail, origin)} />
        </>
      )}
      <article className="mx-auto w-full max-w-[760px] pb-4">
        <Breadcrumbs trail={trail} />
        <header className="mt-2 mb-6 flex flex-col gap-3 border-b border-line pb-6">
          <span className="eyebrow">Guide</span>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
            {guide.title}
          </h1>
          <p className="text-lg text-ink-2">{guide.summary}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
            <span>{SITE.name}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={guide.publishedAt}>{date.format(new Date(guide.publishedAt))}</time>
            {updated && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Updated{" "}
                  <time dateTime={guide.updatedAt}>{date.format(new Date(guide.updatedAt))}</time>
                </span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{minutes} min read</span>
          </p>
        </header>
        {sections.length >= 3 && (
          <nav
            aria-labelledby="toc-h"
            className="mb-8 rounded-lg border border-line bg-surface p-5"
          >
            <h2
              id="toc-h"
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-2"
            >
              On this page
            </h2>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-ink">
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="hover:underline">
                    {section.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <GuideBody blocks={blocks} />
        {topic && (
          <aside className="mt-4 flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-lg font-semibold text-ink">Ready to order?</p>
              <p className="text-sm text-ink-2">
                Delivery across the UAE, cash on delivery. Adults only, 18+.
              </p>
            </div>
            <Link href={SHOP[topic].href} prefetch={false} className="btn btn-primary">
              {SHOP[topic].label}
              <Icon name="arrow-r" />
            </Link>
          </aside>
        )}
      </article>
      {products.length > 0 && (
        <section className="sec" aria-labelledby="guide-products-h">
          <SectionHead
            id="guide-products-h"
            title="In this guide"
            sub="The products this guide mentions"
          />
          <ProductRail products={products} />
        </section>
      )}
      {topic && <RelatedGuides topic={topic} exclude={guide.slug} title="More guides" />}
    </>
  );
}
