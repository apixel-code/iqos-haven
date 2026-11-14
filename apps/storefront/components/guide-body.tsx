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

/**
 * A guide's body (ADR 0117), from the blocks `readGuideBody` produced. No HTML from the text is
 * ever rendered; links are store paths only (the API refuses anything else).
 */
export function GuideBody({ blocks }: { blocks: readonly GuideBlock[] }) {
  return (
    <div className="prose">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "h2":
            return (
              <h2 key={index} className="h2">
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
              <List key={index} className={block.kind === "ol" ? "list-decimal" : undefined}>
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
