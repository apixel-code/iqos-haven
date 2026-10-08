import { createHash } from "node:crypto";
import type { z } from "zod";

/** Rendered message content. Subject is a single header line; html is fully escaped. */
export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * A versioned email template. Bump `version` whenever wording changes: it is part of the
 * delivery key, so a re-rendered message is never mistaken for a different one.
 * Copy and branding are business input (BI-01/BI-07); templates arrive with their features.
 */
export interface EmailTemplate<S extends z.ZodType> {
  readonly id: string;
  readonly version: number;
  readonly schema: S;
  render(data: z.infer<S>, html: HtmlBuilder): { subject: string; text: string; html: string };
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

/** Tagged template that escapes every interpolated value; templates never build raw HTML. */
export type HtmlBuilder = (strings: TemplateStringsArray, ...values: unknown[]) => string;
const html: HtmlBuilder = (strings, ...values) =>
  strings.reduce(
    (out, part, i) => out + part + (i < values.length ? escapeHtml(String(values[i])) : ""),
    "",
  );

export class EmailTemplateError extends Error {
  constructor(readonly code: "INVALID_TEMPLATE_DATA" | "INVALID_SUBJECT") {
    super(code);
  }
}

export function renderEmail<S extends z.ZodType>(
  template: EmailTemplate<S>,
  data: unknown,
): RenderedEmail {
  const parsed = template.schema.safeParse(data);
  if (!parsed.success) throw new EmailTemplateError("INVALID_TEMPLATE_DATA");
  const rendered = template.render(parsed.data, html);
  const subject = rendered.subject.trim();
  // A newline in a header value would allow header injection.
  if (!subject || subject.length > 200 || /[\r\n]/.test(subject))
    throw new EmailTemplateError("INVALID_SUBJECT");
  return { subject, text: rendered.text, html: rendered.html };
}

/**
 * Stable delivery key for one message: source event + template id/version + recipient set
 * (order-insensitive, case-insensitive). Used as Message-ID and provider idempotency key.
 */
export function emailDeliveryKey(
  eventId: string,
  template: { id: string; version: number },
  recipients: readonly string[],
): string {
  const normalized = [
    ...new Set(recipients.map((recipient) => recipient.trim().toLowerCase())),
  ].sort();
  const digest = createHash("sha256")
    .update([eventId, `${template.id}@${template.version}`, ...normalized].join("\n"))
    .digest("hex");
  return "email-" + digest.slice(0, 40);
}
