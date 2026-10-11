import { randomUUID } from "node:crypto";
import { createEmailConsumer, type EmailMessage, type EffectContext } from "@ih/application";
import {
  assertTestDatabase,
  emailIntegrationTestEnvSchema,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  workerEnvSchema,
} from "@ih/config";
import { createDatabase, createPool, issuePasswordReset, Prisma } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { resetToken, resetTokenHash, resetRecipientHash } from "@ih/platform";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { passwordResetEmailPlanner } from "./password-reset-email";
import { SmtpEmailAdapter } from "./email";
import { EffectRunner } from "./effects";
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
const mail = loadEnv(emailIntegrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-reset-email-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const key = { keyId: "old", secret: Buffer.alloc(32, 8).toString("base64url") };
const env = workerEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: "redis://localhost:6379",
  PASSWORD_RESET_KEYS: `reset:new:${Buffer.alloc(32, 7).toString("base64url")},reset:old:${key.secret}`,
  PASSWORD_RESET_ORIGIN: "http://localhost:8081",
});
const planner = passwordResetEmailPlanner(db, env);
const smtp = new SmtpEmailAdapter({
  host: mail.SMTP_HOST,
  port: mail.SMTP_PORT,
  secure: false,
  from: "no-reply@iqoshaven.local",
});
let n = 0;
async function issue() {
  const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
  const user = await db.staffUser.create({
    data: {
      roleId: role.id,
      email: `reset${n++}@iqoshaven.test`,
      name: "Test",
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
    },
  });
  const id = randomUUID();
  const token = resetToken(id, key);
  await issuePasswordReset(
    db,
    { requestId: randomUUID(), actorId: null },
    {
      email: user.email,
      id,
      keyId: key.keyId,
      tokenHash: resetTokenHash(token),
      recipientHash: resetRecipientHash(user.email, key),
    },
  );
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: user.id },
    include: { effects: true },
  });
  const effect = event.effects[0]!;
  const context: EffectContext = {
    eventId: event.id,
    effectId: effect.id,
    eventType: event.eventType,
    consumer: "email",
    schemaVersion: event.schemaVersion,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    attempt: 1,
  };
  return { user, id, token, event, effect, context };
}
describe("durable reset email", () => {
  beforeAll(() => applyMigrations(pool, namespace));
  afterAll(async () => {
    smtp.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("derives the immutable old-key link, delivers to Mailpit through EffectRunner, and deduplicates completed jobs", async () => {
    const data = await issue();
    const messages: EmailMessage[] = [];
    const consumer = createEmailConsumer({
      from: "no-reply@iqoshaven.local",
      planners: { "staff.password_reset_requested": planner },
      adapter: {
        send: async (message, signal) => {
          messages.push(message);
          return smtp.send(message, signal);
        },
      },
    });
    const runner = new EffectRunner({
      db,
      owner: "reset-email-test",
      log: createLogger({ service: "reset-email-test", level: "silent" }),
      handlers: [consumer],
    });
    const job = { eventId: data.event.id, effectId: data.effect.id, consumer: "email" as const };
    expect(await runner.run(job)).toBe("completed");
    expect(await runner.run(job)).toBe("duplicate");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.bcc).toEqual([data.user.email]);
    expect(messages[0]!.text).toContain(`/reset#token=${data.token}`);
    expect(messages[0]!.html).toContain(`/reset#token=${data.token}`);
    const retryPlan = await planner(data.context);
    expect(retryPlan?.data).toEqual({
      resetUrl: `http://localhost:8081/reset#token=${data.token}`,
    });
    const effect = await db.consumerEffect.findUniqueOrThrow({ where: { id: data.effect.id } });
    expect(effect.externalReceipt).toMatch(/^smtp:/);
    expect(effect.externalReceipt).not.toContain(data.token);
    const listing = await fetch(`${mail.MAILPIT_URL}/api/v1/messages?limit=500`);
    const body = (await listing.json()) as { messages: Array<{ MessageID: string }> };
    expect(body.messages.some((m) => m.MessageID.startsWith(messages[0]!.deliveryKey + "@"))).toBe(
      true,
    );
  });
  it("suppresses used/expired/inactive/changed-user links and changed recipients", async () => {
    for (const mode of ["used", "expired", "inactive", "version", "email"]) {
      const data = await issue();
      if (mode === "used")
        await db.passwordResetToken.update({
          where: { id: data.id },
          data: { usedAt: new Date() },
        });
      if (mode === "expired")
        await db.$executeRaw(
          Prisma.sql`UPDATE password_reset_tokens SET created_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute' WHERE id = ${data.id}::uuid`,
        );
      if (mode === "inactive")
        await db.staffUser.update({ where: { id: data.user.id }, data: { active: false } });
      if (mode === "version")
        await db.staffUser.update({
          where: { id: data.user.id },
          data: { version: { increment: 1 } },
        });
      if (mode === "email")
        await db.staffUser.update({
          where: { id: data.user.id },
          data: { email: "changed@iqoshaven.test" },
        });
      expect(await planner(data.context)).toBeNull();
    }
  });
  it("retries missing-key configuration without sending and refuses mismatched event ownership", async () => {
    const data = await issue();
    await expect(
      passwordResetEmailPlanner(db, { ...env, PASSWORD_RESET_KEYS: [] })(data.context),
    ).rejects.toThrow("RESET_CONFIGURATION_MISSING");
    await expect(planner({ ...data.context, aggregateId: randomUUID() })).rejects.toMatchObject({
      code: "INVALID_RESET_EVENT",
    });
  });
});
