import { z } from "zod";
import type { EmailTemplate } from "./template";

export const passwordResetTemplate: EmailTemplate<z.ZodObject<{ resetUrl: z.ZodURL }>> = {
  id: "staff.password_reset",
  version: 1,
  schema: z.strictObject({ resetUrl: z.url().max(2048) }),
  render: ({ resetUrl }, html) => ({
    subject: "Reset your Iqos Haven admin password",
    text: `Use this link to reset your admin password within 30 minutes:\n${resetUrl}\nIf you did not request this, ignore this email.\n`,
    html: html`<p>Use this link to reset your admin password within 30 minutes:</p>
      <p><a href="${resetUrl}">Reset password</a></p>
      <p>If you did not request this, ignore this email.</p>`,
  }),
};
