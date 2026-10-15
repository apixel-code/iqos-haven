import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { createDatabase, createPool, issueReviewLink, submitReview, transitionOrder } from "@ih/db";
import { applyMigrations, seedOrder } from "@ih/db/testing";
import { createLogger } from "@ih/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EffectRunner } from "./effects";
import { createNotificationConsumer } from "./order-notifications";

loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-review-notifications-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const log = createLogger({ service: "review-notifications-test", level: "silent" });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const inbox = new EffectRunner({
  db,
  owner: "review-inbox-test",
  log,
  handlers: [createNotificationConsumer({ log })],
});

let ownerId = "";
let staffId = "";
const context = () => ({ requestId: randomUUID(), actorId: ownerId });

/** A submitted review and its `review.submitted` notification job. */
async function submitted() {
  const seeded = await seedOrder(pool, { status: "confirmed" });
  for (const to of ["processing", "out_for_delivery", "delivered"] as const) {
    const { version } = await db.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    await transitionOrder(db, context(), seeded.orderId, {
      to,
      expectedVersion: version,
      commandId: randomUUID(),
    });
  }
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: seeded.orderId } });
  const { link } = await issueReviewLink(db, context(), seeded.orderId);
  await submitReview(db, {
    token: link.slice(link.indexOf("#") + 1),
    productId: item.productId!,
    rating: 2,
    title: "Not for me",
    body: "Flavour faded after a day.",
    authorName: "Private Person",
    requestId: randomUUID(),
  });
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { eventType: "review.submitted" },
    orderBy: { id: "desc" },
    include: { effects: true },
  });
  const effect = event.effects.find((row) => row.consumer === "notification")!;
  return {
    eventId: event.id,
    job: { eventId: event.id, effectId: effect.id, consumer: "notification" as const },
  };
}

describe("review notification (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const user = async (name: string, key: string) =>
      (
        await db.staffUser.create({
          data: {
            email: `${name}@iqoshaven.test`,
            name,
            roleId: (await db.role.findUniqueOrThrow({ where: { key } })).id,
            passwordHash: HASH,
          },
        })
      ).id;
    ownerId = await user("review-owner", "owner");
    staffId = await user("review-staff", "staff");
    await db.setting.create({
      data: {
        key: "store",
        value: { name: "Iqos Haven", domain: "shop.iqoshaven.test", legalName: null },
        updatedBy: ownerId,
      },
    });
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("tells moderators once, without the author's name or words", async () => {
    const { eventId, job } = await submitted();
    expect(await inbox.run(job)).toBe("completed");
    expect(await inbox.run(job)).not.toBe("failed");
    const notes = await db.notification.findMany({
      where: { sourceEventId: eventId },
      include: { receipts: true },
    });
    expect(notes).toHaveLength(1);
    const [note] = notes;
    expect(note).toMatchObject({
      type: "review.submitted",
      title: "New review: Seed product",
      body: "2 of 5 stars · waiting for moderation",
    });
    for (const words of ["Private", "Flavour", "Not for me"])
      expect(note!.title + note!.body).not.toContain(words);
    const receivers = note!.receipts.map((receipt) => receipt.userId);
    expect(receivers).toContain(ownerId);
    // Staff cannot moderate reviews, so they are not told about them.
    expect(receivers).not.toContain(staffId);
  });

  it("completes without a notification while the inbox is switched off", async () => {
    await db.setting.create({
      data: {
        key: "notifications",
        updatedBy: ownerId,
        value: {
          inApp: false,
          newOrderEmail: { enabled: false, recipients: [] },
          lowStockEmail: false,
        },
      },
    });
    try {
      const { eventId, job } = await submitted();
      expect(await inbox.run(job)).toBe("completed");
      expect(await db.notification.count({ where: { sourceEventId: eventId } })).toBe(0);
    } finally {
      await pool.query("DELETE FROM settings WHERE key='notifications'");
    }
  });
});
