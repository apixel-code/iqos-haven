import Link from "next/link";
import { SectionHead } from "@/components/home-sections";
import { storeRead } from "@/lib/store/server";

/** Which guides a page points to: TEREA pages to the TEREA guides, device pages to the ILUMA ones. */
export type GuideTopic = "terea" | "iqos";

/**
 * Links to the published guides on a topic (ADR 0119): they tie the catalogue and the guides
 * together for shoppers and search engines. Guides are matched by their slug's first word, so
 * a new guide joins the right pages when it is published and a hidden one drops out. A failed
 * read shows nothing: the page around it must never fail because of this box.
 */
export async function RelatedGuides({ topic, limit = 3 }: { topic: GuideTopic; limit?: number }) {
  let guides;
  try {
    guides = (await storeRead((api, shopper) => api.guides(shopper))).items;
  } catch {
    return null;
  }
  const shown = guides.filter((guide) => guide.slug.startsWith(`${topic}-`)).slice(0, limit);
  if (!shown.length) return null;
  return (
    <section className="sec" aria-labelledby={`guides-${topic}-h`}>
      <SectionHead
        id={`guides-${topic}-h`}
        title="Guides"
        sub={topic === "terea" ? "Choosing a TEREA flavour" : "Choosing an IQOS ILUMA"}
        more={{ label: "All guides", href: "/guides" }}
      />
      <ul className="grid gap-4 sm:grid-cols-3">
        {shown.map((guide) => (
          <li key={guide.slug}>
            <Link
              href={`/guides/${guide.slug}`}
              prefetch={false}
              className="flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-4 hover:border-line-2"
            >
              <span className="font-semibold text-ink">{guide.title}</span>
              <span className="muted text-sm">{guide.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The topic of a category or product, from its slugs; null when no guide topic fits. */
export function guideTopicOf(slug: string): GuideTopic | null {
  if (slug.startsWith("terea")) return "terea";
  if (slug.startsWith("iqos")) return "iqos";
  return null;
}
