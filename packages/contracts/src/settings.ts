import { z } from "zod";
export const settingKeySchema = z.enum(["store", "contact", "notifications", "whatsapp"]);
const socialUrl = z
  .url()
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  })
  .nullable();
const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/)
  .nullable();
const text = (max: number) => z.string().trim().min(1).max(max);
const template = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .regex(/^(?:[^{}]|\{\{(?:store_name|order_number|status|total|support_phone)\}\})+$/)
  .nullable();
export const storeSettingsSchema = z.strictObject({
  name: text(100),
  domain: z
    .string()
    .max(253)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  legalName: text(200).nullable(),
});
export const contactSettingsSchema = z.strictObject({
  email: z.email().max(254).nullable(),
  phone,
  address: text(500).nullable(),
  openingHours: text(500).nullable(),
  footerNote: text(500).nullable(),
  social: z.strictObject({ instagram: socialUrl, tiktok: socialUrl, facebook: socialUrl }),
});
export const notificationSettingsSchema = z
  .strictObject({
    inApp: z.boolean(),
    newOrderEmail: z
      .strictObject({ enabled: z.boolean(), recipients: z.array(z.email().max(254)).max(10) })
      .refine((value) => !value.enabled || value.recipients.length > 0)
      .refine(
        (value) =>
          new Set(value.recipients.map((email) => email.toLowerCase())).size ===
          value.recipients.length,
      ),
    /**
     * Low-stock email (step 92), to the same recipient list. Optional so that values saved before
     * it read as "off".
     */
    lowStockEmail: z.boolean().optional(),
  })
  .refine((value) => !value.lowStockEmail || value.newOrderEmail.recipients.length > 0, {
    path: ["lowStockEmail"],
  });
export const whatsappSettingsSchema = z.strictObject({
  number: phone,
  templates: z.strictObject({
    orderConfirmation: template,
    statusUpdate: template,
    support: template,
  }),
});
const values = {
  store: storeSettingsSchema,
  contact: contactSettingsSchema,
  notifications: notificationSettingsSchema,
  whatsapp: whatsappSettingsSchema,
};
const version = z.number().int().min(0);
export const settingsWriteRequestSchema = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("store"), version, value: values.store.nullable() }),
  z.strictObject({ key: z.literal("contact"), version, value: values.contact.nullable() }),
  z.strictObject({
    key: z.literal("notifications"),
    version,
    value: values.notifications.nullable(),
  }),
  z.strictObject({ key: z.literal("whatsapp"), version, value: values.whatsapp.nullable() }),
]);
const metadata = {
  version,
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.uuid().nullable(),
};
export const settingResponseSchema = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("store"), ...metadata, value: values.store.nullable() }),
  z.strictObject({ key: z.literal("contact"), ...metadata, value: values.contact.nullable() }),
  z.strictObject({
    key: z.literal("notifications"),
    ...metadata,
    value: values.notifications.nullable(),
  }),
  z.strictObject({ key: z.literal("whatsapp"), ...metadata, value: values.whatsapp.nullable() }),
]);
export const settingsResponseSchema = z.strictObject({
  items: z.array(settingResponseSchema).length(4),
});
export const settingsQuerySchema = z.strictObject({});
export type SettingsWriteRequest = z.infer<typeof settingsWriteRequestSchema>;
