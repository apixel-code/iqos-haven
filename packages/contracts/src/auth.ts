import { z } from "zod";

/** The launch roles and their grants, so the admin's access summary shows the real model. */
export { PERMISSIONS, ROLE_PERMISSIONS, type PermissionKey, type RoleKey } from "@ih/domain";

/** POST /v1/auth/login. Bounds are generous for input but strict for abuse. */
export const loginRequestSchema = z.strictObject({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** GET /v1/auth/me (and the login response). Permissions are server-derived keys. */
export const meResponseSchema = z.strictObject({
  user: z.strictObject({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    role: z.enum(["owner", "staff"]),
  }),
  permissions: z.array(z.string()),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Generic response for every valid forgot request, including unknown/inactive accounts. */
export const forgotRequestSchema = z.strictObject({ email: z.string().min(1).max(320) });
export const forgotResponseSchema = z.strictObject({ accepted: z.literal(true) });
export const resetRequestSchema = z.strictObject({
  token: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
});

export const invitationRequestSchema = z.strictObject({
  email: z.email().max(254),
  name: z.string().min(1).max(100),
  role: z.enum(["owner", "staff"]),
});
export const invitationResponseSchema = z.strictObject({
  id: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export const invitationRevokeRequestSchema = z.strictObject({ invitationId: z.uuid() });
/** Invitations neither accepted nor revoked (parity G-A11); expired ones can still be revoked. */
export const pendingInvitationSchema = z.strictObject({
  id: z.uuid(),
  email: z.email().max(254),
  name: z.string().min(1).max(100),
  role: z.enum(["owner", "staff"]),
  invitedBy: z.string().max(100).nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
});
export const pendingInvitationsResponseSchema = z.strictObject({
  items: z.array(pendingInvitationSchema).max(100),
});
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;
export const invitationAcceptRequestSchema = z.strictObject({
  token: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
});

export const staffListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: z.uuid().optional(),
});
export const staffIdParamsSchema = z.strictObject({ id: z.uuid() });
export const staffEditRequestSchema = z
  .strictObject({
    version: z.number().int().min(1),
    name: z.string().min(1).max(100).optional(),
    email: z.email().max(254).optional(),
  })
  .refine((value) => value.name !== undefined || value.email !== undefined);
export const staffDeactivateRequestSchema = z.strictObject({ version: z.number().int().min(1) });
export const staffResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: z.enum(["owner", "staff"]),
  active: z.boolean(),
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime().nullable(),
});
export const staffListResponseSchema = z.strictObject({
  items: z.array(staffResponseSchema).max(100),
  nextCursor: z.uuid().nullable(),
});

export const staffRoleRequestSchema = z.strictObject({
  version: z.number().int().min(1),
  role: z.enum(["owner", "staff"]),
});
export const staffReactivateRequestSchema = z.strictObject({ version: z.number().int().min(1) });
