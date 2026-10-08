import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createEmailConsumer, systemTestMessageTemplate, type EmailAdapter } from "@ih/application";
import {
  assertTestDatabase,
  emailIntegrationTestEnvSchema,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { defineEvent } from "@ih/contracts";
import { createDatabase, createPool, PrismaOutboxWriter, withTransaction } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AllowlistEmailAdapter, DisabledEmailAdapter, SmtpEmailAdapter } from "./email";
import { EffectRunner } from "./effects";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
const mail = loadEnv(emailIntegrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-email-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "email-int-test", level: "silent" });
const FROM = "no-reply@iqoshaven.local";
// Mailpit is a local sink; these addresses never leave the test environment.
const RECIPIENTS = ["ops@apixel.test", "qa@apixel.test"];
const smtp = new SmtpEmailAdapter({
  host: mail.SMTP_HOST,
  port: mail.SMTP_PORT,
  secure: false,
  from: FROM,
});

interface MailpitMessage {
  ID: string;
  MessageID: string;
  Bcc: Array<{ Address: string }>;
  To: Array<{ Address: string }> | null;
}

async function mailpitMessages(deliveryKey: string): Promise<MailpitMessage[]> {
  const response = await fetch(`${mail.MAILPIT_URL}/api/v1/messages?limit=500`);
  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages.filter((message) => message.MessageID.startsWith(deliveryKey + "@"));
}

async function waitForMessages(deliveryKey: string, count: number): Promise<MailpitMessage[]> {
  let found: MailpitMessage[] = [];
  for (let i = 0; i < 40; i++) {
    found = await mailpitMessages(deliveryKey);
    if (found.length >= count) break;
    await delay(100);
  }
  return found;
}

/** A probe event with an `email` effect (email is not a catalogue consumer yet; inserted directly). */
async function emailEffect(): Promise<{ eventId: string; effectId: string; probeId: string }> {
  const probeId = randomUUID();
  const eventId = await withTransaction(db, (tx) =>
    new PrismaOutboxWriter().publish(tx, defineEvent("system.probe", probeId, { probeId })),
  );
  const effect = await db.consumerEffect.create({ data: { eventId, consumer: "email" } });
  return { eventId, effectId: effect.id, probeId };
}

function runner(adapter: EmailAdapter, recipients = RECIPIENTS) {
  return new EffectRunner({
    db,
    owner: "email-" + randomUUID().slice(0, 6),
    log,
    handlers: [
      createEmailConsumer({
        adapter,
        from: FROM,
        planners: {
          "system.probe": async (context) => ({
            template: systemTestMessageTemplate,
            data: { probeId: (context.payload as { probeId: string }).probeId },
            recipients,
          }),
        },
      }),
    ],
  });
}

describe("email pipeline (real PostgreSQL + Mailpit)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const info = await fetch(`${mail.MAILPIT_URL}/api/v1/info`);
    expect(info.ok).toBe(true);
  });
  afterAll(async () => {
    smtp.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("delivers one Bcc message keyed by the delivery key and stores the provider receipt", async () => {
    const { eventId, effectId } = await emailEffect();
    expect(await runner(smtp).run({ eventId, effectId, consumer: "email" })).toBe("completed");
    const effect = await db.consumerEffect.findUniqueOrThrow({ where: { id: effectId } });
    expect(effect.status).toBe("completed");
    expect(effect.externalReceipt).toMatch(/^smtp:<email-[0-9a-f]{40}@iqoshaven\.local>$/);
    const deliveryKey = effect.externalReceipt!.slice("smtp:<".length).split("@")[0]!;
    const [message] = await waitForMessages(deliveryKey, 1);
    expect(message).toBeDefined();
    expect(message!.To ?? []).toEqual([]);
    expect(message!.Bcc.map((entry) => entry.Address).sort()).toEqual(RECIPIENTS);
    const headers = (await (
      await fetch(`${mail.MAILPIT_URL}/api/v1/message/${message!.ID}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers["X-Ih-Delivery-Key"] ?? headers["X-IH-Delivery-Key"]).toEqual([deliveryKey]);
  });

  it("does not send again for a duplicate delivery of a completed effect", async () => {
    const { eventId, effectId } = await emailEffect();
    const instance = runner(smtp);
    expect(await instance.run({ eventId, effectId, consumer: "email" })).toBe("completed");
    expect(await instance.run({ eventId, effectId, consumer: "email" })).toBe("duplicate");
    const receipt = (await db.consumerEffect.findUniqueOrThrow({ where: { id: effectId } }))
      .externalReceipt!;
    const deliveryKey = receipt.slice("smtp:<".length).split("@")[0]!;
    await delay(300);
    expect(await waitForMessages(deliveryKey, 1)).toHaveLength(1);
  });

  it("sends nothing while sending is disabled, yet completes the effect", async () => {
    const before = (await (await fetch(`${mail.MAILPIT_URL}/api/v1/info`)).json()) as {
      Messages: number;
    };
    const { eventId, effectId } = await emailEffect();
    expect(
      await runner(new DisabledEmailAdapter()).run({ eventId, effectId, consumer: "email" }),
    ).toBe("completed");
    const effect = await db.consumerEffect.findUniqueOrThrow({ where: { id: effectId } });
    expect(effect.externalReceipt).toMatch(/^disabled:email-/);
    await delay(200);
    const after = (await (await fetch(`${mail.MAILPIT_URL}/api/v1/info`)).json()) as {
      Messages: number;
    };
    expect(after.Messages).toBe(before.Messages);
  });

  it("filters recipients through the staging allowlist", async () => {
    const guarded = new AllowlistEmailAdapter(smtp, ["qa@apixel.test"]);
    const allowed = await emailEffect();
    expect(
      await runner(guarded, ["customer@example.com", "qa@apixel.test"]).run({
        ...allowed,
        consumer: "email",
      }),
    ).toBe("completed");
    const receipt = (await db.consumerEffect.findUniqueOrThrow({ where: { id: allowed.effectId } }))
      .externalReceipt!;
    const [message] = await waitForMessages(receipt.slice("smtp:<".length).split("@")[0]!, 1);
    expect(message!.Bcc.map((entry) => entry.Address)).toEqual(["qa@apixel.test"]);

    const suppressed = await emailEffect();
    expect(
      await runner(guarded, ["customer@example.com"]).run({ ...suppressed, consumer: "email" }),
    ).toBe("completed");
    expect(
      (await db.consumerEffect.findUniqueOrThrow({ where: { id: suppressed.effectId } }))
        .externalReceipt,
    ).toBe("suppressed:allowlist");
  });

  it("retries transient SMTP failures instead of losing the email", async () => {
    const unreachable = new SmtpEmailAdapter({
      host: "127.0.0.1",
      port: 1,
      secure: false,
      from: FROM,
    });
    const { eventId, effectId } = await emailEffect();
    expect(await runner(unreachable).run({ eventId, effectId, consumer: "email" })).toBe("retry");
    const effect = await db.consumerEffect.findUniqueOrThrow({ where: { id: effectId } });
    expect(effect.status).toBe("retry");
    expect(effect.lastError).toMatch(/^TRANSIENT/);
    unreachable.close();
  });
});
