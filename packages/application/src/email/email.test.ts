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
import { newOrderTemplate } from "./new-order";
import { orderConfirmationTemplate } from "./order-confirmation";
import { staffInvitationTemplate } from "./staff-invitation";

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

describe("branded email layout", () => {
  it("escapes every value, keeps the link written out, and stays email-safe", () => {
    const invite = renderEmail(staffInvitationTemplate, {
      inviteUrl: "https://admin.iqoshaven.com/accept?token=a&b=<x>",
    });
    expect(invite.html).toContain("IQOS HAVEN");
    expect(invite.html).toContain("Accept invitation");
    expect(invite.html).toContain("token=a&amp;b=&lt;x&gt;");
    expect(invite.html).not.toContain("<x>");
    expect(invite.html).not.toMatch(/<script|<img|@import|<link /i);
    const order = renderEmail(newOrderTemplate, {
      orderNumber: "IH-1001",
      total: "AED 99.00",
      units: 2,
      areaName: "Al <b>Barsha</b>",
      paymentMethod: "cash_on_delivery",
      customer: { name: "Sam <i>", phone: "+971501234567", email: null },
      items: [{ label: "TEREA UAE · silver × 2", total: "AED 64.00" }],
    });
    expect(order.html).toContain("Al &lt;b&gt;Barsha&lt;/b&gt;");
    expect(order.text).toContain("Area: Al <b>Barsha</b>");
    // Who ordered and what (ADR 0104), escaped; no email given reads as such.
    expect(order.html).toContain("Sam &lt;i&gt;");
    expect(order.html).not.toContain("Sam <i>");
    expect(order.text).toContain("Phone: +971501234567");
    expect(order.text).toContain("Email: Not given");
    expect(order.text).toContain("- TEREA UAE · silver × 2: AED 64.00");
    expect(order.text).toContain("Payment: Cash on delivery");
    // A bank transfer or online payment tells the shop what to send (ADR 0111).
    const transfer = renderEmail(newOrderTemplate, {
      orderNumber: "IH-1001",
      total: "AED 99.00",
      units: 2,
      areaName: "Al Barsha",
      paymentMethod: "bank_transfer",
      customer: { name: "Sam", phone: "+971501234567", email: null },
      items: [{ label: "TEREA UAE · silver × 2", total: "AED 64.00" }],
    });
    expect(transfer.text).toContain("Payment: Bank transfer");
    expect(transfer.text).toContain("send them the bank details on WhatsApp");
    // The body stays inside the white card: it comes after the heading and before the card's
    // closing tags and the footnote (a formatter once closed the card early, see layout.ts).
    const body = invite.html.indexOf("Accept the invitation to set");
    expect(body).toBeGreaterThan(invite.html.indexOf("<h1"));
    expect(body).toBeLessThan(invite.html.indexOf("</div>"));
    expect(invite.html.indexOf("Accept invitation")).toBeLessThan(invite.html.indexOf("</div>"));
    expect(invite.html.indexOf("</div>")).toBeLessThan(invite.html.indexOf("safely ignore"));
  });
  it("renders the shopper's order confirmation, escaped, without a WhatsApp button when unset (ADR 0102)", () => {
    const data = {
      firstName: "Sam <i>",
      orderNumber: "IH-001002",
      items: [{ label: "TEREA UAE · silver × 2", total: "AED 360.00" }],
      subtotal: "AED 360.00",
      discount: null,
      delivery: "AED 35.00",
      total: "AED 395.00",
      areaName: "Al Barsha",
      eta: "1–2 days",
      paymentMethod: "cash_on_delivery" as const,
      whatsappUrl: "https://wa.me/971500000000",
      customer: { name: "Sam <i> Lee", phone: "+971501234567", email: "sam@example.com" },
      trackUrl: "https://iqoshaven.com/track",
    };
    const mail = renderEmail(orderConfirmationTemplate, data);
    expect(mail.subject).toBe("Order IH-001002 received (AED 395.00)");
    expect(mail.html).toContain("Thank you, Sam &lt;i&gt;");
    expect(mail.html).toContain("TEREA UAE · silver × 2");
    expect(mail.html).toContain("Cash on delivery");
    expect(mail.text).toContain("Pay in cash when your order arrives.");
    expect(mail.html).not.toContain("Discount");
    expect(mail.html).toContain("Message us on WhatsApp");
    expect(mail.text).toContain("- TEREA UAE · silver × 2: AED 360.00");
    // The details given and the tracking page (ADR 0104); the link never carries the number.
    expect(mail.text).toContain("Order number: IH-001002");
    expect(mail.text).toContain("Phone: +971501234567");
    expect(mail.text).toContain("Email: sam@example.com");
    expect(mail.html).toContain("Sam &lt;i&gt; Lee");
    expect(mail.html).toContain('href="https://iqoshaven.com/track"');
    expect(mail.html).not.toMatch(/track\?|track\/IH/);
    const plain = renderEmail(orderConfirmationTemplate, {
      ...data,
      discount: "AED 36.00",
      whatsappUrl: null,
      trackUrl: null,
    });
    expect(plain.html).toContain("−AED 36.00");
    expect(plain.html).not.toContain("wa.me");
    expect(plain.text).not.toContain("Track your order");
    // The chosen method and its next step (ADR 0111).
    const online = renderEmail(orderConfirmationTemplate, {
      ...data,
      paymentMethod: "online_payment",
    });
    expect(online.text).toContain("Payment: Online payment");
    expect(online.text).toContain("We'll send you a secure payment link on WhatsApp.");
    expect(online.text).not.toContain("Pay in cash");
  });
});
