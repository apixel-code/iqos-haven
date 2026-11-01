import { z } from "zod";
import { brandedEmail } from "./layout";
import type { EmailTemplate } from "./template";
export const staffInvitationTemplate: EmailTemplate<z.ZodObject<{ inviteUrl: z.ZodURL }>> = {
  id: "staff.invitation",
  version: 2,
  schema: z.strictObject({ inviteUrl: z.url().max(2048) }),
  render: ({ inviteUrl }, html) => ({
    subject: "Your Iqos Haven admin invitation",
    text: `You have been invited to the Iqos Haven admin.\n\nAccept the invitation within 24 hours:\n${inviteUrl}\n\nIf you did not expect this invitation, ignore this email.\n`,
    html: brandedEmail(html, {
      preheader: "You have been invited to the Iqos Haven admin. The link is valid for 24 hours.",
      heading: "You're invited to the Iqos Haven admin",
      body: html`<p style="margin:0">
          You have been invited to join the Iqos Haven store admin. Accept the invitation to set
          your password and sign in.
        </p>
        <p style="margin:12px 0 0">
          The link is valid for <strong>24 hours</strong> and can be used once.
        </p>`,
      action: { label: "Accept invitation", url: inviteUrl },
      footnote: "If you did not expect this invitation, you can safely ignore this email.",
    }),
  }),
};
