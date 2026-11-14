import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readGuideBody } from "@ih/contracts";
import { GuideBody } from "@/components/guide-body";
import { JsonLd } from "@/components/json-ld";
import { Breadcrumbs } from "@/components/listing";
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

/** One guide (ADR 0117). Structured data only while the Owner offers the catalogue. */
export default async function GuidePage({ params }: Props) {
  const guide = await guideOf((await params).slug);
  if (!guide) notFound();
  const { blocks } = readGuideBody(guide.body);
  const trail = [
    { label: "Home", href: "/" },
    { label: "Guides", href: "/guides" },
    { label: guide.title },
  ];
  const offered = (await readSeoPolicy()).indexing === "catalogue";
  const origin = ageGate().runtime.origins[0]!;
  const updated = guide.updatedAt.slice(0, 10) !== guide.publishedAt.slice(0, 10);
  return (
    <article>
      {offered && (
        <>
          <JsonLd data={guideJsonLd(guide, origin, SITE.name)} />
          <JsonLd data={breadcrumbJsonLd(trail, origin)} />
        </>
      )}
      <Breadcrumbs trail={trail} />
      <header className="shop-head">
        <h1 className="h1">{guide.title}</h1>
        <p className="muted">{guide.summary}</p>
        <p className="text-sm text-ink-2">
          <time dateTime={guide.publishedAt}>{date.format(new Date(guide.publishedAt))}</time>
          {updated && (
            <>
              {" · Updated "}
              <time dateTime={guide.updatedAt}>{date.format(new Date(guide.updatedAt))}</time>
            </>
          )}
        </p>
      </header>
      <GuideBody blocks={blocks} />
    </article>
  );
}
