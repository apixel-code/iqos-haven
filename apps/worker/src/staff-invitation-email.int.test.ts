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
import { createDatabase, createPool, issueStaffInvitation } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import { invitationToken, invitationTokenHash } from "@ih/platform";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { staffInvitationEmailPlanner } from "./staff-invitation-email";
import { SmtpEmailAdapter } from "./email";
import { EffectRunner } from "./effects";
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
const mail = loadEnv(emailIntegrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-invitation-email-test",
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
  STAFF_INVITATION_KEYS: `invite:new:${Buffer.alloc(32, 7).toString("base64url")},invite:old:${key.secret}`,
  STAFF_INVITATION_ORIGIN: "http://localhost:8081",
});
const planner = staffInvitationEmailPlanner(db, env);
const smtp = new SmtpEmailAdapter({
  host: mail.SMTP_HOST,
  port: mail.SMTP_PORT,
  secure: false,
  from: "no-reply@iqoshaven.local",
});
let n = 0;
let inviterId: string;
async function issue() {
  const id = randomUUID();
  const token = invitationToken(id, key);
  const email = `invite${n++}@iqoshaven.test`;
  await issueStaffInvitation(
    db,
    { requestId: randomUUID(), actorId: inviterId },
    {
      id,
      email,
      name: "Sam Person",
      role: "staff",
      keyId: key.keyId,
      tokenHash: invitationTokenHash(token),
    },
  );
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: id, eventType: "staff.invited" },
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
  return { email, id, token, event, effect, context };
}
describe("durable invitation email", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    const inviter = await db.staffUser.create({
      data: {
        email: "owner@iqoshaven.test",
        name: "Owner",
        roleId: role.id,
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
      },
    });
    inviterId = inviter.id;
  });
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
      planners: { "staff.invited": planner },
      adapter: {
        send: async (message, signal) => {
          messages.push(message);
          return smtp.send(message, signal);
        },
      },
    });
    const runner = new EffectRunner({
      db,
      owner: "invitation-email-test",
      log: createLogger({ service: "invitation-email-test", level: "silent" }),
      handlers: [consumer],
    });
    const job = { eventId: data.event.id, effectId: data.effect.id, consumer: "email" as const };
    expect(await runner.run(job)).toBe("completed");
    expect(await runner.run(job)).toBe("duplicate");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.bcc).toEqual([data.email]);
    expect(messages[0]!.text).toContain(`/invite/accept#token=${data.token}`);
    expect(messages[0]!.html).toContain(`/invite/accept#token=${data.token}`);
    const retryPlan = await planner(data.context);
    expect(retryPlan?.data).toEqual({
      inviteUrl: `http://localhost:8081/invite/accept#token=${data.token}`,
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
  it("suppresses accepted/revoked links and links whose inviting account is no longer authorized", async () => {
    const accepted = await issue();
    await db.staffInvitationToken.update({
      where: { id: accepted.id },
      data: { acceptedAt: new Date() },
    });
    expect(await planner(accepted.context)).toBeNull();
    const revoked = await issue();
    await db.staffInvitationToken.update({
      where: { id: revoked.id },
      data: { revokedAt: new Date() },
    });
    expect(await planner(revoked.context)).toBeNull();
    const inactive = await issue();
    await db.staffUser.update({ where: { id: inviterId }, data: { active: false } });
    try {
      expect(await planner(inactive.context)).toBeNull();
    } finally {
      await db.staffUser.update({ where: { id: inviterId }, data: { active: true } });
    }
    const existing = await issue();
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    await db.staffUser.create({
      data: {
        email: existing.email,
        name: "Existing",
        roleId: role.id,
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
      },
    });
    expect(await planner(existing.context)).toBeNull();
  });
  it("retries missing-key configuration without sending and refuses mismatched event ownership", async () => {
    const data = await issue();
    await expect(
      staffInvitationEmailPlanner(db, { ...env, STAFF_INVITATION_KEYS: [] })(data.context),
    ).rejects.toThrow("INVITATION_CONFIGURATION_MISSING");
    await expect(planner({ ...data.context, aggregateId: randomUUID() })).rejects.toMatchObject({
      code: "INVALID_INVITATION_EVENT",
    });
  });
});
