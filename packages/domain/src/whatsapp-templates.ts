/**
 * Order message templates for staff (roadmap step 90, ADR 0058). The Owner's templates use
 * `{{store_name}}`, `{{order_number}}`, `{{status}}`, `{{total}}` and `{{support_phone}}`
 * (validated in the settings contract). The result is plain text for a `wa.me` link the staff
 * member opens and sends themselves; nothing here sends or records a message.
 */
export const DEFAULT_WHATSAPP_TEMPLATES = {
  orderConfirmation:
    "Hi, this is {{store_name}}. We received your order {{order_number}} for {{total}}, cash on delivery. Please reply YES to confirm delivery.",
  statusUpdate: "Hi, this is {{store_name}}. Your order {{order_number}} is now: {{status}}.",
} as const;
export type WhatsappTemplateKind = keyof typeof DEFAULT_WHATSAPP_TEMPLATES;
export interface WhatsappTemplateValues {
  store_name: string;
  order_number: string;
  status: string;
  total: string;
  support_phone: string;
}
const PLACEHOLDER = /\{\{(store_name|order_number|status|total|support_phone)\}\}/g;
/** Fills the placeholders. Values are plain text; anything left unknown stays as typed. */
export function renderWhatsappTemplate(template: string, values: WhatsappTemplateValues): string {
  return template.replace(PLACEHOLDER, (_all, key: keyof WhatsappTemplateValues) =>
    // Line breaks in a value could make it look like part of the template.
    values[key].replace(/[\r\n]+/g, " "),
  );
}
/** `https://wa.me/<digits>?text=<encoded>` for an E.164 phone, or null for anything else. */
export function whatsappMessageHref(phoneE164: string, text: string): string | null {
  if (!/^\+[1-9]\d{7,14}$/.test(phoneE164)) return null;
  return `https://wa.me/${phoneE164.slice(1)}?text=${encodeURIComponent(text)}`;
}
