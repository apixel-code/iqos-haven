import { z } from "zod";
import type { EmailTemplate } from "./template";
export const staffInvitationTemplate: EmailTemplate<z.ZodObject<{ inviteUrl: z.ZodURL }>> = {
  id: "staff.invitation",
  version: 1,
  schema: z.strictObject({ inviteUrl: z.url().max(2048) }),
  render: ({ inviteUrl }, html) => ({
    subject: "Your Iqos Haven admin invitation",
    text: `Accept your admin invitation within 24 hours:\n${inviteUrl}\nIf you did not expect this invitation, ignore this email.\n`,
    html: html`<p>Accept your admin invitation within 24 hours:</p>
      <p><a href="${inviteUrl}">Accept invitation</a></p>
      <p>If you did not expect this invitation, ignore this email.</p>`,
  }),
};
