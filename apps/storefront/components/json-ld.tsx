import { jsonLdText } from "@/lib/seo-data";

/** Structured data for search engines (ADR 0114). A data block: nothing in it is executed. */
export function JsonLd({ data }: { data: unknown }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />
  );
}
