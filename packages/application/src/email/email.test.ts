import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PermanentEffectError, type EffectContext } from "../effects";
import {
  createEmailConsumer,
  systemTestMessageTemplate,
  type EmailAdapter,
  type EmailMessage,
} from "./consumer";
import { emailDeliveryKey, escapeHtml, renderEmail, type EmailTemplate } from "./template";

const probeId = "0199c4a2-7b1e-7c3a-9f00-1234567890ab";
const context: EffectContext = {
  eventId: "0199c4a2-7b1e-7c3a-9f00-1234567890ac",
  effectId: "0199c4a2-7b1e-7c3a-9f00-1234567890ad",
  consumer: "email",
  eventType: "system.probe",
  schemaVersion: 1,
  aggregateType: "system",
  aggregateId: "probe",
  payload: { probeId },
  attempt: 1,
};
const signal = new AbortController().signal;

describe("email templates", () => {
  const greeting: EmailTemplate<z.ZodObject<{ name: z.ZodString }>> = {
    id: "test.greeting",
    version: 1,
    schema: z.strictObject({ name: z.string() }),
    render: (data, html) => ({
      subject: `Hello ${data.name}`,
      text: `Hello ${data.name}`,
      html: html`<p>Hello ${data.name}</p>`,
    }),
  };

  it("escapes every interpolated value in HTML", () => {
    expect(renderEmail(greeting, { name: `<script>"x"&'y'</script>` }).html).toBe(
      "<p>Hello &lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;</p>",
    );
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("rejects invalid data and header-injecting subjects", () => {
    expect(() => renderEmail(greeting, { name: 1 })).toThrow("INVALID_TEMPLATE_DATA");
    expect(() => renderEmail(greeting, { name: "x\r\nBcc: victim@example.com" })).toThrow(
      "INVALID_SUBJECT",
    );
  });

  it("derives a stable, order- and case-insensitive delivery key", () => {
    const a = emailDeliveryKey(context.eventId, greeting, ["B@x.ae", "a@x.ae"]);
    expect(a).toBe(emailDeliveryKey(context.eventId, greeting, ["a@x.ae", "b@x.ae", "A@x.ae"]));
    expect(a).not.toBe(
      emailDeliveryKey(context.eventId, { ...greeting, version: 2 }, ["a@x.ae", "b@x.ae"]),
    );
    expect(a).toMatch(/^email-[0-9a-f]{40}$/);
  });
});

describe("email consumer", () => {
  const sent: EmailMessage[] = [];
  const adapter: EmailAdapter = {
    async send(message) {
      sent.push(message);
      return { receipt: "smtp:<id>", accepted: message.bcc.length, rejected: 0 };
    },
  };
  const consumer = (
    planner: (ctx: EffectContext) => Promise<unknown>,
    overrides: Partial<EmailAdapter> = {},
  ) =>
    createEmailConsumer({
      adapter: { ...adapter, ...overrides },
      from: "no-reply@iqoshaven.local",
      planners: { "system.probe": planner as never },
    });

  it("sends one Bcc message with a delivery key and returns the provider receipt", async () => {
    const result = await consumer(async () => ({
      template: systemTestMessageTemplate,
      data: { probeId },
      recipients: ["Ops@Apixel.net", "ops@apixel.net", "qa@apixel.net"],
    })).perform(context, signal);
    expect(result).toEqual({ receipt: "smtp:<id>" });
    const message = sent.at(-1)!;
    expect(message.bcc).toEqual(["ops@apixel.net", "qa@apixel.net"]);
    expect(message.deliveryKey).toMatch(/^email-/);
    expect(message.subject).toBe("Iqos Haven email check");
  });

  it.each([
    [
      "unknown event",
      { ...context, eventType: "order.created" },
      async () => null,
      "NO_EMAIL_PLAN",
    ],
    [
      "bad recipient",
      context,
      async () => ({
        template: systemTestMessageTemplate,
        data: { probeId },
        recipients: ["nope"],
      }),
      "INVALID_RECIPIENT",
    ],
    [
      "bad data",
      context,
      async () => ({
        template: systemTestMessageTemplate,
        data: { probeId: "x" },
        recipients: ["a@x.ae"],
      }),
      "INVALID_TEMPLATE_DATA",
    ],
  ])("fails permanently on %s", async (_name, ctx, planner, code) => {
    await expect(consumer(planner).perform(ctx as EffectContext, signal)).rejects.toMatchObject({
      code,
    });
  });

  it("completes without sending when there is nobody to email", async () => {
    const before = sent.length;
    expect(await consumer(async () => null).perform(context, signal)).toEqual({
      receipt: "no-recipients",
    });
    expect(sent.length).toBe(before);
  });

  it("treats a full rejection as permanent but never retries a partial acceptance", async () => {
    const plan = async () => ({
      template: systemTestMessageTemplate,
      data: { probeId },
      recipients: ["a@x.ae", "b@x.ae"],
    });
    await expect(
      consumer(plan, { send: async () => ({ receipt: "r", accepted: 0, rejected: 2 }) }).perform(
        context,
        signal,
      ),
    ).rejects.toBeInstanceOf(PermanentEffectError);
    await expect(
      consumer(plan, { send: async () => ({ receipt: "r", accepted: 1, rejected: 1 }) }).perform(
        context,
        signal,
      ),
    ).resolves.toEqual({ receipt: "r;rejected=1" });
  });
});
