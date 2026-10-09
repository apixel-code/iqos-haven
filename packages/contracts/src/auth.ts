import { z } from "zod";

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
