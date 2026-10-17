import { z } from "zod";

/**
 * Staff notification inbox (roadmap step 91, ADR 0059). One shared, immutable notification
 * per event (ADR 0047) with a read flag per user. Nothing here carries customer data.
 */
export const inboxNotificationSchema = z.strictObject({
  id: z.uuid(),
  type: z.string().min(1).max(64),
  title: z.string().min(1).max(150),
  body: z.string().max(500),
  link: z.string().max(300).nullable(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export const inboxQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** The last notification of the previous page (keyset, newest first). */
  after: z.uuid().optional(),
  unread: z.enum(["true", "false"]).optional(),
});
export const inboxResponseSchema = z.strictObject({
  items: z.array(inboxNotificationSchema).max(50),
  unreadCount: z.number().int().min(0),
  nextCursor: z.uuid().nullable(),
});
export const notificationParamsSchema = z.strictObject({ id: z.uuid() });
export const notificationReadResponseSchema = z.strictObject({
  id: z.uuid(),
  readAt: z.iso.datetime(),
});
/** Marks as read every notification up to and including `upTo` (what the user has seen). */
export const notificationsReadAllRequestSchema = z.strictObject({ upTo: z.uuid() });
export const notificationsReadAllResponseSchema = z.strictObject({
  updated: z.number().int().min(0),
});
export type InboxNotification = z.infer<typeof inboxNotificationSchema>;
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type InboxResponse = z.infer<typeof inboxResponseSchema>;
