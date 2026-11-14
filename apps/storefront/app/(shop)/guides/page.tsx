import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, PageHead } from "@/components/listing";
import { pageDescription, SITE } from "@/lib/site";
import { storeRead } from "@/lib/store/server";

export const metadata: Metadata = {
  title: `Guides to IQOS ILUMA and TEREA · ${SITE.name}`,
  description: pageDescription("Guides to IQOS ILUMA devices and TEREA flavours."),
  alternates: { canonical: "/guides" },
};

const date = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Asia/Dubai",
});

/** Guides (ADR 0117): the Owner's published articles, newest first. */
export default async function GuidesPage() {
  const { items } = await storeRead((api, shopper) => api.guides(shopper));
  return (
    <>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Guides" }]} />
      <PageHead
        title="Guides"
        lead="How the IQOS ILUMA devices differ, what each TEREA flavour tastes like, and how ordering works."
      />
      {items.length === 0 ? (
        <p className="muted pb-12">The first guides are on their way.</p>
      ) : (
        <ul className="grid gap-4 pb-12 sm:grid-cols-2">
          {items.map((guide) => (
            <li key={guide.slug}>
              <Link
                href={`/guides/${guide.slug}`}
                prefetch={false}
                className="flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-5 hover:border-line-2"
              >
                <h2 className="text-lg font-semibold text-ink">{guide.title}</h2>
                <p className="muted">{guide.summary}</p>
                <time dateTime={guide.publishedAt} className="mt-auto text-sm text-ink-2">
                  {date.format(new Date(guide.publishedAt))}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
