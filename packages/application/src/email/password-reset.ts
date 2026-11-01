import { z } from "zod";
import { brandedEmail } from "./layout";
import type { EmailTemplate } from "./template";

export const passwordResetTemplate: EmailTemplate<z.ZodObject<{ resetUrl: z.ZodURL }>> = {
  id: "staff.password_reset",
  version: 2,
  schema: z.strictObject({ resetUrl: z.url().max(2048) }),
  render: ({ resetUrl }, html) => ({
    subject: "Reset your Iqos Haven admin password",
    text: `Use this link to reset your admin password within 30 minutes:\n${resetUrl}\n\nIf you did not request this, ignore this email. Your password stays the same.\n`,
    html: brandedEmail(html, {
      preheader: "Reset your Iqos Haven admin password. The link is valid for 30 minutes.",
      heading: "Reset your admin password",
      body: html`<p style="margin:0">
          We received a request to reset the password of your Iqos Haven admin account.
        </p>
        <p style="margin:12px 0 0">
          The link is valid for <strong>30 minutes</strong> and can be used once.
        </p>`,
      action: { label: "Reset password", url: resetUrl },
      footnote: "If you did not request this, ignore this email. Your password stays the same.",
    }),
  }),
};
