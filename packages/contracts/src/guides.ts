import { z } from "zod";

/**
 * Guides (ADR 0117, SEO plan 2026-11-13): articles the Owner writes in the admin and the store
 * shows under `/guides`. Plain text with a small, fixed markup, never HTML:
 *
 * - blocks are separated by a blank line;
 * - `## ` starts a section heading and `### ` a sub-heading (one line);
 * - a block whose every line starts with `- ` is a bullet list, `1. ` (any number) a numbered list;
 * - anything else is a paragraph;
 * - inside text, `**bold**` and `[link text](/path)`. Links go to store pages only (a path
 *   starting with `/`), so a guide can never send a shopper to another site.
 *
 * The parser is shared by the API (validation), the admin (preview) and the store (rendering),
 * so all three read a guide the same way.
 */
export const GUIDE_LIMITS = { slug: 120, title: 120, summary: 300, body: 30_000 } as const;

/** Controls and invisible or direction-changing marks; a newline is allowed only in the body. */
const HIDDEN =
  "\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}";
const HIDDEN_OR_MARKUP = new RegExp(`[${HIDDEN}<>]`, "u");
/** One line of plain text, spaces collapsed and trimmed; angle brackets are refused. */
const line = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.normalize("NFC").replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .refine((value) => !HIDDEN_OR_MARKUP.test(value), "Plain text only"),
    );

export const guideSlugSchema = z
  .string()
  .min(1)
  .max(GUIDE_LIMITS.slug)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** A store path a guide may link to: lower-case, no host, no query, an optional `#section`. */
const INTERNAL_HREF = /^\/[a-z0-9\-/]{0,198}(#[a-z0-9-]{1,60})?$/;
const INLINE = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]*)\)/g;

export type GuideInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string };
export type GuideBlock =
  | { kind: "h2" | "h3"; text: string }
  | { kind: "p"; inline: GuideInline[] }
  | { kind: "ul" | "ol"; items: GuideInline[][] };

/** Text with `**bold**` and `[text](/path)`. A link to anything but a store path is a problem. */
function parseInline(text: string, problems: string[]): GuideInline[] {
  const out: GuideInline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ kind: "strong", text: match[1] });
    else {
      const href = match[3]!;
      if (!INTERNAL_HREF.test(href) || href.includes("//"))
        problems.push(`Link "${match[2]}" must point to a store page, such as /sticks`);
      out.push({ kind: "link", text: match[2]!, href });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const BULLET = /^- +/;
const NUMBERED = /^\d{1,3}\. +/;

/** The body as blocks, and what is wrong with it (empty when it can be published). */
export function readGuideBody(body: string): { blocks: GuideBlock[]; problems: string[] } {
  const problems: string[] = [];
  const blocks: GuideBlock[] = [];
  const chunks = body
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((value) => value.trim());
    const heading = /^(#{2,3}) +(.+)$/.exec(chunk);
    if (heading && lines.length === 1) {
      blocks.push({ kind: heading[1] === "##" ? "h2" : "h3", text: heading[2]!.trim() });
    } else if (lines.every((value) => BULLET.test(value))) {
      blocks.push({
        kind: "ul",
        items: lines.map((value) => parseInline(value.replace(BULLET, ""), problems)),
      });
    } else if (lines.every((value) => NUMBERED.test(value))) {
      blocks.push({
        kind: "ol",
        items: lines.map((value) => parseInline(value.replace(NUMBERED, ""), problems)),
      });
    } else {
      if (/^#/.test(chunk)) problems.push("A heading is one line starting with ## or ###");
      blocks.push({ kind: "p", inline: parseInline(lines.join(" "), problems) });
    }
  }
  if (!blocks.length) problems.push("Write the guide");
  return { blocks, problems: [...new Set(problems)] };
}

/** The body as plain text (markup removed), for a description or a word count. */
export function guidePlainText(blocks: readonly GuideBlock[]): string {
  const inline = (parts: readonly GuideInline[]) => parts.map((part) => part.text).join("");
  return blocks
    .map((block) => {
      if (block.kind === "p") return inline(block.inline);
      if ("items" in block) return block.items.map(inline).join(" ");
      return block.text;
    })
    .join(" ");
}

/** Multi-line body text: newlines kept, other hidden marks and angle brackets refused. */
const body = z
  .string()
  .transform((value) => value.normalize("NFC").replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(GUIDE_LIMITS.body)
      .refine((value) => !HIDDEN_OR_MARKUP.test(value), "Plain text only"),
  )
  .superRefine((value, ctx) => {
    for (const message of readGuideBody(value).problems) ctx.addIssue({ code: "custom", message });
  });

const version = z.number().int().min(1).max(2147483646);
const fields = {
  slug: guideSlugSchema,
  title: line(1, GUIDE_LIMITS.title),
  /** Shown in the guide list and used as the page's search description. */
  summary: line(1, GUIDE_LIMITS.summary),
  body,
  /** Visible in the store. A published guide's link (slug) cannot change. */
  published: z.boolean(),
};
export const guideCreateRequestSchema = z.strictObject(fields);
export const guideUpdateRequestSchema = z.strictObject({ ...fields, version });
export const guideParamsSchema = z.strictObject({ id: z.uuid() });
export const guideResponseSchema = z.strictObject({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  published: z.boolean(),
  /** When it was first published; it stays when the guide is hidden again. */
  publishedAt: z.iso.datetime().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
/** Every guide, newest change first. Bounded: the admin shows them on one page. */
export const MAX_GUIDES = 500;
export const guidesResponseSchema = z.strictObject({
  items: z.array(guideResponseSchema).max(MAX_GUIDES),
});

/** Store reads (age ticket required, like every store read). */
export const storeGuideSummarySchema = z.strictObject({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  publishedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const storeGuidesResponseSchema = z.strictObject({
  items: z.array(storeGuideSummarySchema).max(MAX_GUIDES),
});
export const storeGuideResponseSchema = storeGuideSummarySchema.extend({ body: z.string() });
export const storeGuideParamsSchema = z.strictObject({ slug: guideSlugSchema });

export type GuideCreateRequest = z.input<typeof guideCreateRequestSchema>;
export type GuideUpdateRequest = z.input<typeof guideUpdateRequestSchema>;
export type GuideResponse = z.infer<typeof guideResponseSchema>;
export type GuidesResponse = z.infer<typeof guidesResponseSchema>;
export type StoreGuideSummary = z.infer<typeof storeGuideSummarySchema>;
export type StoreGuidesResponse = z.infer<typeof storeGuidesResponseSchema>;
export type StoreGuideResponse = z.infer<typeof storeGuideResponseSchema>;
