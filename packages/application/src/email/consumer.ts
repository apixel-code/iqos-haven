import { z } from "zod";
import { PermanentEffectError, type EffectContext, type ExternalEffectHandler } from "../effects";
import { EmailTemplateError, emailDeliveryKey, renderEmail, type EmailTemplate } from "./template";

/** One message per effect; recipients are sent as Bcc so staff never see each other. */
export interface EmailMessage {
  readonly deliveryKey: string;
  readonly from: string;
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailSendResult {
  /** Provider message identifier or other receipt; stored as the effect's external receipt. */
  readonly receipt: string;
  readonly accepted: number;
  readonly rejected: number;
}

/**
 * Provider port. Implementations pass `deliveryKey` as the provider idempotency key where
 * supported; plain SMTP has none, so delivery is at least once (docs/email-delivery.md).
 * Throw PermanentEffectError for definitive rejections; anything else is retried.
 */
export interface EmailAdapter {
  send(message: EmailMessage, signal: AbortSignal): Promise<EmailSendResult>;
}

/** What to send for one event. `null` (or no recipients) completes the effect without sending. */
export interface EmailPlan {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly template: EmailTemplate<any>;
  readonly data: unknown;
  readonly recipients: readonly string[];
}

/** Loads authorized data/recipients for an event (from the database, never the payload). */
export type EmailPlanner = (context: EffectContext) => Promise<EmailPlan | null>;

const recipient = z.email().max(254);

export function createEmailConsumer(options: {
  readonly adapter: EmailAdapter;
  readonly from: string;
  readonly planners: Readonly<Record<string, EmailPlanner>>;
  readonly maxAttempts?: number;
}): ExternalEffectHandler {
  return {
    kind: "external",
    consumer: "email",
    ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
    async perform(context, signal) {
      const planner = Object.hasOwn(options.planners, context.eventType)
        ? options.planners[context.eventType]
        : undefined;
      if (!planner) throw new PermanentEffectError("NO_EMAIL_PLAN");
      const plan = await planner(context);
      if (!plan || plan.recipients.length === 0) return { receipt: "no-recipients" };
      if (!plan.recipients.every((address) => recipient.safeParse(address).success))
        throw new PermanentEffectError("INVALID_RECIPIENT");
      let rendered;
      try {
        rendered = renderEmail(plan.template, plan.data);
      } catch (error) {
        if (error instanceof EmailTemplateError) throw new PermanentEffectError(error.code);
        throw error;
      }
      const result = await options.adapter.send(
        {
          deliveryKey: emailDeliveryKey(context.eventId, plan.template, plan.recipients),
          from: options.from,
          bcc: [...new Set(plan.recipients.map((address) => address.toLowerCase()))],
          ...rendered,
        },
        signal,
      );
      // Partial acceptance is not retried: a resend would duplicate the accepted copies.
      // The rejected count stays visible in the stored receipt (no addresses).
      if (result.accepted === 0 && result.rejected > 0)
        throw new PermanentEffectError("EMAIL_REJECTED");
      return {
        receipt:
          result.rejected > 0 ? `${result.receipt};rejected=${result.rejected}` : result.receipt,
      };
    },
  };
}

/** Operational check message (smoke tests / probes). Neutral copy; no customer data. */
export const systemTestMessageTemplate: EmailTemplate<z.ZodObject<{ probeId: z.ZodUUID }>> = {
  id: "system.test_message",
  version: 1,
  schema: z.strictObject({ probeId: z.uuid() }),
  render: (data, html) => ({
    subject: "Iqos Haven email check",
    text: `This is an automated delivery check.\nReference: ${data.probeId}\n`,
    html: html`<p>This is an automated delivery check.</p>
      <p>Reference: ${data.probeId}</p>`,
  }),
};
