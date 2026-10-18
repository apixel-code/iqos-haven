import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { launchFacts, shippedMigrations } from "./launch-readiness";
import { applyMigrations } from "./test-schema";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-launch-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });

describe("launch readiness facts (real PostgreSQL, step 124)", () => {
  beforeAll(() => applyMigrations(pool, namespace));
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("lists the shipped migrations in order", () => {
    const shipped = shippedMigrations();
    expect(shipped.length).toBeGreaterThan(40);
    expect(shipped).toEqual([...shipped].sort());
    expect(shipped).toContain("20261017000100_catalogue_images");
  });

  it("reads an empty database as not ready, then counts what was entered", async () => {
    const empty = await launchFacts(db);
    expect(empty).toMatchObject({
      activeOwners: 0,
      testAccounts: 0,
      activeAreas: 0,
      publishedProducts: 0,
      ledgerMismatches: 0,
      settings: {
        store: null,
        contact: null,
        whatsappNumber: null,
        newOrderEmail: false,
        seoIndexing: null,
        delivery: null,
      },
    });

    const ownerRole = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    const owner = await db.staffUser.create({
      data: {
        email: "owner@iqoshaven.com",
        name: "Owner",
        roleId: ownerRole.id,
        passwordHash: "$argon2id$unused",
      },
    });
    await db.staffUser.create({
      data: {
        email: "qa@iqoshaven.test",
        name: "QA",
        roleId: ownerRole.id,
        active: false,
        passwordHash: "$argon2id$unused",
      },
    });
    const put = (key: string, value: unknown) =>
      pool.query("INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)", [
        key,
        JSON.stringify(value),
        owner.id,
      ]);
    await put("store", { name: "Iqos Haven", domain: "iqoshaven.com", legalName: null });
    await put("contact", {
      email: null,
      phone: "+971500000000",
      address: null,
      openingHours: null,
      footerNote: null,
      social: { instagram: null, tiktok: null, facebook: null },
    });
    await put("whatsapp", {
      number: "+971500000000",
      templates: { orderConfirmation: null, statusUpdate: null, support: null },
    });
    await put("notifications", {
      inApp: true,
      newOrderEmail: { enabled: true, recipients: ["orders@iqoshaven.com"] },
    });
    await put("seo", { indexing: "public_pages" });
    await put("delivery", {
      flatFeeFils: 2500,
      etaText: "Within 2 hours",
      freeThresholdFils: null,
    });
    await pool.query(
      "INSERT INTO delivery_areas (code, name, active, updated_by) VALUES ('dubai-marina', 'Dubai Marina', true, $1)",
      [owner.id],
    );

    const brand = await db.brand.create({ data: { name: "Brand", slug: "brand" } });
    const fixture = await db.category.create({ data: { name: "Gate", slug: "gatecheck-cat" } });
    const product = await db.product.create({
      data: {
        name: "Real product",
        slug: "real-product",
        brandId: brand.id,
        categoryId: fixture.id,
        type: "disposable",
        puffCount: 6000,
        basePriceFils: 4900n,
        status: "published",
      },
    });
    const variant = await db.variant.create({
      data: { productId: product.id, sku: "REAL-1", active: true, isDefault: true },
    });
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 5, 5, 'INITIAL_STOCK', $2)",
      [variant.id, randomUUID()],
    );
    await pool.query(
      "INSERT INTO coupons (code, percent_bps, active, updated_by) VALUES ('SAVE20', 2000, false, $1)",
      [owner.id],
    );

    const facts = await launchFacts(db);
    expect(facts).toMatchObject({
      activeOwners: 1,
      testAccounts: 1,
      activeAreas: 1,
      publishedProducts: 1,
      publishedWithoutActiveOption: 0,
      publishedWithoutImage: 1,
      publishedSoldOut: 0,
      ledgerMismatches: 0,
      demoCoupons: 1,
      fixtureCatalogue: 1,
      deadEffects: 0,
      settings: {
        store: { name: "Iqos Haven", domain: "iqoshaven.com" },
        contact: { email: null, phone: "+971500000000" },
        whatsappNumber: "+971500000000",
        newOrderEmail: true,
        seoIndexing: "public_pages",
        delivery: { flatFeeFils: 2500, etaText: "Within 2 hours" },
      },
    });
    // Personal data never appears in the facts.
    expect(JSON.stringify(facts)).not.toContain("owner@iqoshaven.com");
    expect(JSON.stringify(facts)).not.toContain("qa@iqoshaven.test");

    // A stock change made outside the ledger is found.
    await pool.query("ALTER TABLE variants DISABLE TRIGGER USER");
    try {
      await pool.query("UPDATE variants SET stock_on_hand = 9 WHERE id = $1", [variant.id]);
    } finally {
      await pool.query("ALTER TABLE variants ENABLE TRIGGER USER");
    }
    expect((await launchFacts(db)).ledgerMismatches).toBe(1);
  });
});
