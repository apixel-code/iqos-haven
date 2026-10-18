import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import {
  ContentConflictError,
  ContentForbiddenError,
  ContentNotFoundError,
  ContentReferenceError,
  listContentSections,
  publishContentSection,
  saveContentDraft,
} from "./content";
import { applyMigrations, seedOrder } from "./test-schema";

loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-content-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const HASH = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
let ownerId = "";
let staffId = "";
const as = (actorId: string) => ({ requestId: randomUUID(), actorId });
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await pool.query(sql, params)).rows[0] as T;
const refused = (sql: string, params: unknown[] = [], code = "23514") =>
  expect(pool.query(sql, params)).rejects.toMatchObject({ code });
const failure = async (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

/** A product a shopper can see (seeded order product, published, parents active). */
async function visibleProduct() {
  const { variantId } = await seedOrder(pool);
  const product = await one<{ id: string; brandId: string; categoryId: string }>(
    `SELECT p.id, p.brand_id AS "brandId", p.category_id AS "categoryId"
     FROM products p JOIN variants v ON v.product_id=p.id WHERE v.id=$1`,
    [variantId],
  );
  await pool.query("UPDATE brands SET active=true WHERE id=$1", [product.brandId]);
  await pool.query("UPDATE categories SET active=true WHERE id=$1", [product.categoryId]);
  await pool.query("UPDATE products SET status='published' WHERE id=$1", [product.id]);
  return product;
}
/** A processed content image. */
async function contentImage() {
  const { id } = await one<{ id: string }>(
    `INSERT INTO media_assets (id, purpose, uploaded_by, quarantine_key, declared_type,
       declared_bytes, upload_expires_at)
     SELECT g, 'content', $1, 'uploads/' || g, 'image/png', 1000, now() + interval '1 hour'
     FROM (SELECT gen_random_uuid() AS g) x RETURNING id`,
    [ownerId],
  );
  await pool.query(
    `UPDATE media_assets SET state='ready', observed_bytes=1000, width=1600, height=900,
       sha256=repeat('a', 64), version=version+1 WHERE id=$1`,
    [id],
  );
  return id;
}

describe("content sections (real PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const user = async (key: string) =>
      (
        await db.staffUser.create({
          data: {
            email: `content-${key}@iqoshaven.test`,
            name: "Content " + key,
            roleId: (await db.role.findUniqueOrThrow({ where: { key } })).id,
            passwordHash: HASH,
          },
        })
      ).id;
    ownerId = await user("owner");
    staffId = await user("staff");
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("is for content.manage only", async () => {
    const ticker = { enabled: true, messages: ["Cash on delivery", "UAE-wide delivery"] };
    expect(
      await failure(
        saveContentDraft(db, as(staffId), "ticker", { expectedVersion: 0, content: ticker }),
      ),
    ).toBeInstanceOf(ContentForbiddenError);
    expect(await failure(listContentSections(db, staffId))).toBeInstanceOf(ContentForbiddenError);
    expect(await failure(publishContentSection(db, as(staffId), "ticker", 1))).toBeInstanceOf(
      ContentForbiddenError,
    );
    expect(await one("SELECT count(*)::int AS n FROM content_sections")).toEqual({ n: 0 });
  });

  it("saves validated drafts by version and publishes the draft whole", async () => {
    const first = await saveContentDraft(db, as(ownerId), "ticker", {
      expectedVersion: 0,
      content: { enabled: true, messages: [" Cash on  delivery ", "UAE-wide delivery"] },
    });
    expect(first).toMatchObject({
      key: "ticker",
      schemaVersion: 1,
      version: 1,
      published: null,
      unpublishedChanges: true,
      draft: { enabled: true, messages: ["Cash on delivery", "UAE-wide delivery"] },
    });
    // Invalid content is refused before anything is written.
    await expect(
      saveContentDraft(db, as(ownerId), "ticker", {
        expectedVersion: 1,
        content: { enabled: true, messages: ["<script>x</script>", "Two"] },
      }),
    ).rejects.toThrow();
    // A stale editor, and a second "new" save, are conflicts.
    for (const expectedVersion of [0, 2]) {
      const error = await failure(
        saveContentDraft(db, as(ownerId), "ticker", {
          expectedVersion,
          content: { enabled: false, messages: ["One", "Two"] },
        }),
      );
      expect((error as ContentConflictError).reason).toBe("VERSION_CONFLICT");
    }
    const published = await publishContentSection(db, as(ownerId), "ticker", 1);
    expect(published).toMatchObject({ version: 2, unpublishedChanges: false });
    expect(published.published).toEqual(first.draft);
    expect(
      ((await failure(publishContentSection(db, as(ownerId), "ticker", 2))) as ContentConflictError)
        .reason,
    ).toBe("NOTHING_TO_PUBLISH");
    // A new draft leaves the published copy alone until published.
    const edited = await saveContentDraft(db, as(ownerId), "ticker", {
      expectedVersion: 2,
      content: { enabled: false, messages: ["One", "Two"] },
    });
    expect(edited).toMatchObject({ version: 3, unpublishedChanges: true });
    expect(edited.published).toEqual(first.draft);
    const row = await one<{ id: string }>("SELECT id FROM content_sections WHERE key='ticker'");
    const events = await db.outboxEvent.findMany({ where: { eventType: "content.published" } });
    expect(events.map((event) => event.payload)).toEqual([{ contentId: row.id }]);
    const audits = await pool.query(
      "SELECT action FROM audit_log WHERE entity_type='content_section' AND entity_id=$1 ORDER BY occurred_at",
      [row.id],
    );
    expect(audits.rows.map((audit: { action: string }) => audit.action)).toEqual([
      "content.draft_saved",
      "content.published",
      "content.draft_saved",
    ]);
    expect(await failure(publishContentSection(db, as(ownerId), "hero", 1))).toBeInstanceOf(
      ContentNotFoundError,
    );
    expect((await listContentSections(db, ownerId)).map((section) => section.key)).toEqual([
      "ticker",
    ]);
  });

  it("publishes only what a shopper can see", async () => {
    const product = await visibleProduct();
    const hidden = await visibleProduct();
    await pool.query("UPDATE products SET status='draft' WHERE id=$1", [hidden.id]);
    const image = await contentImage();
    const missing = randomUUID();
    await saveContentDraft(db, as(ownerId), "featured", {
      expectedVersion: 0,
      content: { productIds: [product.id, hidden.id, missing] },
    });
    const refused_ = await failure(publishContentSection(db, as(ownerId), "featured", 1));
    expect(refused_).toBeInstanceOf(ContentReferenceError);
    expect((refused_ as ContentReferenceError).problems).toEqual([
      { kind: "product", id: hidden.id, reason: "not_visible" },
      { kind: "product", id: missing, reason: "missing" },
    ]);
    await saveContentDraft(db, as(ownerId), "featured", {
      expectedVersion: 1,
      content: { productIds: [product.id] },
    });
    expect((await publishContentSection(db, as(ownerId), "featured", 2)).version).toBe(3);

    // Hero: a brand link and a content image; a product image or a trashed brand is refused.
    const productAsset = await one<{ id: string }>(
      `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
         declared_bytes, upload_expires_at)
       SELECT g, $1, $2, 'uploads/' || g, 'image/png', 1000, now() + interval '1 hour'
       FROM (SELECT gen_random_uuid() AS g) x RETURNING id`,
      [product.id, ownerId],
    );
    const hero = (assetId: string, brandId: string) => ({
      slides: [
        {
          style: "navy",
          eyebrow: null,
          title: "Every brand, one place",
          subtitle: "Delivered across the UAE",
          cta: { label: "Shop the brand", link: { kind: "brand", brandId } },
          secondaryCta: null,
          image: { assetId, alt: "Devices on a table" },
        },
      ],
    });
    await saveContentDraft(db, as(ownerId), "hero", {
      expectedVersion: 0,
      content: hero(productAsset.id, product.brandId),
    });
    expect(
      ((await failure(publishContentSection(db, as(ownerId), "hero", 1))) as ContentReferenceError)
        .problems,
    ).toEqual([{ kind: "image", id: productAsset.id, reason: "missing" }]);
    await saveContentDraft(db, as(ownerId), "hero", {
      expectedVersion: 1,
      content: hero(image, product.brandId),
    });
    const live = await publishContentSection(db, as(ownerId), "hero", 2);
    expect(live.published).toMatchObject({ slides: [{ image: { assetId: image } }] });
    // The published image must stay ready.
    await refused("UPDATE media_assets SET state='removed', version=version+1 WHERE id=$1", [
      image,
    ]);
  });

  it("is guarded by the database", async () => {
    const row = await one<{ id: string; version: number }>(
      "SELECT id, version FROM content_sections WHERE key='ticker'",
    );
    // The published copy can only be the current draft.
    await refused(
      `UPDATE content_sections SET published='{"enabled":true,"messages":["x","y"]}',
         published_at=now() + interval '1 second', version=version+1 WHERE id=$1`,
      [row.id],
    );
    // The version advances by one, the key never changes, nothing is deleted.
    await refused("UPDATE content_sections SET draft=draft WHERE id=$1", [row.id]);
    await refused("UPDATE content_sections SET key='hero', version=version+1 WHERE id=$1", [
      row.id,
    ]);
    await refused("DELETE FROM content_sections WHERE id=$1", [row.id], "42501");
    // A section starts as an unpublished draft, and only the seven keys exist.
    await refused(
      `INSERT INTO content_sections (key, schema_version, draft, draft_updated_by, published,
         published_schema_version, published_by, published_at)
       VALUES ('offers', 1, '{}', $1, '{}', 1, $1, now())`,
      [ownerId],
    );
    await refused(
      "INSERT INTO content_sections (key, schema_version, draft, draft_updated_by) VALUES ('footer', 1, '{}', $1)",
      [ownerId],
    );
    // A content image belongs to no product; a product image needs one.
    await refused(
      `INSERT INTO media_assets (id, purpose, product_id, uploaded_by, quarantine_key,
         declared_type, declared_bytes, upload_expires_at)
       SELECT g, 'content', (SELECT id FROM products LIMIT 1), $1, 'uploads/' || g, 'image/png',
         1, now() FROM (SELECT gen_random_uuid() AS g) x`,
      [ownerId],
    );
    await refused(
      `INSERT INTO media_assets (id, uploaded_by, quarantine_key, declared_type, declared_bytes,
         upload_expires_at)
       SELECT g, $1, 'uploads/' || g, 'image/png', 1, now() FROM (SELECT gen_random_uuid() AS g) x`,
      [ownerId],
    );
  });

  it("lets one of two simultaneous saves win", async () => {
    const results = await Promise.allSettled(
      ["A first", "A second"].map((message) =>
        saveContentDraft(db, as(ownerId), "offers", {
          expectedVersion: 0,
          content: { enabled: true, title: "This week", productIds: [] },
        }).then(() => message),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as ContentConflictError).reason).toBe("VERSION_CONFLICT");
    expect(await one("SELECT version FROM content_sections WHERE key='offers'")).toEqual({
      version: 1,
    });
  });
});
