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
