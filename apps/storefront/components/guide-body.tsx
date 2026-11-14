import Link from "next/link";
import type { GuideBlock, GuideInline } from "@ih/contracts";

/** Inline text of a guide: plain text, bold and store links. React escapes all of it. */
function Inline({ parts }: { parts: readonly GuideInline[] }) {
  return parts.map((part, index) =>
    part.kind === "strong" ? (
      <strong key={index}>{part.text}</strong>
    ) : part.kind === "link" ? (
      <Link key={index} href={part.href} prefetch={false} className="underline">
        {part.text}
      </Link>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

/** A stable in-page anchor for a section heading ("The two designs" → "the-two-designs"). */
export const headingId = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "section";

/** The section headings of a guide, for its "On this page" list. */
export const guideSections = (blocks: readonly GuideBlock[]) =>
  blocks.flatMap((block) =>
    block.kind === "h2" ? [{ id: headingId(block.text), text: block.text }] : [],
  );

/** Product pages a guide links to, in order and once each (`/p/<slug>`), for its product row. */
export function guideProductSlugs(blocks: readonly GuideBlock[]): string[] {
  const parts = blocks.flatMap((block) =>
    block.kind === "p"
      ? block.inline
      : block.kind === "ul" || block.kind === "ol"
        ? block.items.flat()
        : [],
  );
  const slugs = parts.flatMap((part) => {
    const match = part.kind === "link" ? /^\/p\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(part.href) : null;
    return match ? [match[1]!] : [];
  });
  return [...new Set(slugs)];
}

/** Minutes to read at about 200 words a minute, at least one. */
export const readingMinutes = (text: string) =>
  Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / 200));

/**
 * A guide's body (ADR 0117), from the blocks `readGuideBody` produced. No HTML from the text is
 * ever rendered; links are store paths only (the API refuses anything else).
 */
export function GuideBody({ blocks }: { blocks: readonly GuideBlock[] }) {
  return (
    <div className="prose guide-prose">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "h2":
            return (
              <h2 key={index} id={headingId(block.text)} className="h2">
                {block.text}
              </h2>
            );
          case "h3":
            return <h3 key={index}>{block.text}</h3>;
          case "p":
            return (
              <p key={index}>
                <Inline parts={block.inline} />
              </p>
            );
          case "ul":
          case "ol": {
            const List = block.kind;
            return (
              <List key={index}>
                {block.items.map((item, at) => (
                  <li key={at}>
                    <Inline parts={item} />
                  </li>
                ))}
              </List>
            );
          }
        }
      })}
    </div>
  );
}
