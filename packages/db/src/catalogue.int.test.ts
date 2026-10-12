import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import { applyMigrations } from "./test-schema";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-catalogue-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const key = () => "test-" + randomUUID();
async function product() {
  const brand = await db.brand.create({ data: { name: "Synthetic brand " + key(), slug: key() } });
  const category = await db.category.create({
    data: { name: "Synthetic category " + key(), slug: key() },
  });
  const row = await db.product.create({
    data: {
      name: "Synthetic product",
      slug: key(),
      brandId: brand.id,
      categoryId: category.id,
      type: "kit",
      basePriceFils: 29n,
    },
  });
  return { row, brand, category };
}
const rejected = (sql: string, params: unknown[] = [], code = "23514") =>
  expect(pool.query(sql, params)).rejects.toMatchObject({ code });
describe("catalogue constraints (real PostgreSQL, isolated schema)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("introduces seven empty tables without catalogue seeds", async () => {
    for (const table of [
      "brands",
      "categories",
      "products",
      "product_options",
      "variants",
      "product_images",
      "slug_redirects",
    ])
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
  });
  it("uses UUIDv7, DB timestamps, positive versions and safe inactive/draft defaults", async () => {
    const { row, brand, category } = await product();
    expect(row.id.split("-")[2]![0]).toBe("7");
    expect(row.status).toBe("draft");
    expect(row.basePriceFils).toBe(29n);
    expect(brand.active).toBe(false);
    expect(category.active).toBe(false);
    expect(row.version).toBe(1);
    expect(row.createdAt).toEqual(row.updatedAt);
    for (const table of ["brands", "categories", "products"])
      await rejected(`UPDATE ${table} SET version=0 WHERE id=$1`, [
        table === "brands" ? brand.id : table === "categories" ? category.id : row.id,
      ]);
  });
  it("rejects malformed and duplicate normalized slugs including trashed rows", async () => {
    const { brand } = await product();
    await expect(
      db.brand.create({ data: { name: "Duplicate", slug: brand.slug } }),
    ).rejects.toMatchObject({ code: "P2002" });
    for (const slug of ["UPPER", " bad", "two--hyphens", "a/b", ""])
      await rejected("UPDATE brands SET slug=$1 WHERE id=$2", [slug, brand.id]);
    await db.brand.update({ where: { id: brand.id }, data: { deletedAt: new Date() } });
    await expect(
      db.brand.create({ data: { name: "Duplicate", slug: brand.slug } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
  it("bounds bigint money, tax reference pairs, product state and JSON shapes", async () => {
    const { row } = await product();
    for (const field of ["base_price_fils", "compare_at_price_fils"])
      for (const amount of [-1, 1000000001])
        await rejected(`UPDATE products SET ${field}=$1 WHERE id=$2`, [amount, row.id]);
    await rejected("UPDATE products SET base_price_fils=$1 WHERE id=$2", ["1.5", row.id], "22P02");
    // A published product needs a price; a tax reference is not required (BI-02).
    await rejected("UPDATE products SET status='published',base_price_fils=0 WHERE id=$1", [
      row.id,
    ]);
    await rejected("UPDATE products SET tax_treatment_ref='unapproved' WHERE id=$1", [row.id]);
    await rejected("UPDATE products SET type='other' WHERE id=$1", [row.id]);
    await rejected("UPDATE products SET specs='[]' WHERE id=$1", [row.id]);
    await rejected("UPDATE products SET puff_count=0 WHERE id=$1", [row.id]);
    // Compare-at must be above the base price (a "was" price that is not higher is misleading).
    for (const compare of [0, 29])
      await rejected("UPDATE products SET compare_at_price_fils=$1 WHERE id=$2", [compare, row.id]);
    await pool.query(
      "UPDATE products SET base_price_fils=999999999,compare_at_price_fils=1000000000 WHERE id=$1",
      [row.id],
    );
    expect((await db.product.findUniqueOrThrow({ where: { id: row.id } })).basePriceFils).toBe(
      999999999n,
    );
  });
  it("enforces normalized option definitions and bounded unique allowed values", async () => {
    const { row } = await product();
    await db.productOption.create({
      data: { productId: row.id, name: "colour", allowedValues: ["red", "blue"] },
    });
    await expect(
      db.productOption.create({
        data: { productId: row.id, name: "colour", allowedValues: ["green"] },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    for (const values of [[], ["Red"], [" red"], ["red\t"], ["red", "red"], [3], null, {}])
      await rejected(
        "INSERT INTO product_options(product_id,name,allowed_values) VALUES($1,'invalid',$2::jsonb)",
        [row.id, JSON.stringify(values)],
      );
  });
  it("derives option signatures and enforces global SKU, one default and per-product combinations", async () => {
    const { row } = await product();
    const variant = await db.variant.create({
      data: {
        productId: row.id,
        sku: "SKU_" + randomUUID().replaceAll("-", "").toUpperCase(),
        attributes: { colour: "red", nicotine: "zero" },
        isDefault: true,
      },
    });
    expect(variant.optionSignature).toBe('{"colour": "red", "nicotine": "zero"}');
    expect(variant.stockOnHand).toBe(0);
    expect(variant.active).toBe(false);
    await expect(
      db.variant.create({
        data: {
          productId: row.id,
          sku: "OTHER_" + key().toUpperCase(),
          attributes: { nicotine: "zero", colour: "red" },
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    const other = await product();
    await expect(
      db.variant.create({ data: { productId: other.row.id, sku: variant.sku } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db.variant.create({
        data: { productId: row.id, sku: "DEFAULT_" + key().toUpperCase(), isDefault: true },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await rejected(
      "UPDATE variants SET option_signature='forged' WHERE id=$1",
      [variant.id],
      "428C9",
    );
    for (const attributes of [
      { Colour: "red" },
      { colour: "Red" },
      { colour: " red" },
      { colour: "red\t" },
      { colour: 3 },
      [],
      null,
    ])
      await rejected("UPDATE variants SET attributes=$1::jsonb WHERE id=$2", [
        JSON.stringify(attributes),
        variant.id,
      ]);
    for (const field of ["low_stock_threshold", "price_override_fils"])
      await rejected(`UPDATE variants SET ${field}=-1 WHERE id=$1`, [variant.id]);
    await rejected("UPDATE variants SET price_override_fils=1000000001 WHERE id=$1", [variant.id]);
    await rejected("UPDATE variants SET sku='lower' WHERE id=$1", [variant.id]);
    await rejected("UPDATE variants SET attributes=$1::jsonb WHERE id=$2", [
      JSON.stringify(
        Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["key" + i, "界".repeat(100)])),
      ),
      variant.id,
    ]);
  });
  it("concurrent equivalent variant inserts have exactly one winner", async () => {
    const { row } = await product();
    const results = await Promise.allSettled(
      ["A", "B"].map((suffix) =>
        db.variant.create({
          data: {
            productId: row.id,
            sku: key().toUpperCase() + suffix,
            attributes: { colour: "red" },
          },
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.variant.count({ where: { productId: row.id } })).toBe(1);
  });
  it("publishes only complete, live products", async () => {
    const { row } = await product();
    // No tax reference is needed: the entered price is final (BI-02).
    await pool.query("UPDATE products SET status='published' WHERE id=$1", [row.id]);
    await rejected("UPDATE products SET deleted_at=statement_timestamp() WHERE id=$1", [row.id]);
    await rejected("UPDATE products SET base_price_fils=0 WHERE id=$1", [row.id]);
    // A published disposable needs its puff count.
    await rejected("UPDATE products SET type='disposable' WHERE id=$1", [row.id]);
    await pool.query("UPDATE products SET type='disposable',puff_count=6000 WHERE id=$1", [row.id]);
    expect((await db.product.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "published",
    );
  });

  it("refuses to publish a product whose brand or category is trashed", async () => {
    const { row, brand, category } = await product();
    await pool.query(
      "UPDATE products SET tax_treatment_ref='synthetic-vat',tax_treatment_version=1 WHERE id=$1",
      [row.id],
    );
    await pool.query("UPDATE brands SET deleted_at=statement_timestamp() WHERE id=$1", [brand.id]);
    await rejected("UPDATE products SET status='published' WHERE id=$1", [row.id]);
    await pool.query("UPDATE brands SET deleted_at=NULL WHERE id=$1", [brand.id]);
    await pool.query("UPDATE categories SET deleted_at=statement_timestamp() WHERE id=$1", [
      category.id,
    ]);
    await rejected("UPDATE products SET status='published' WHERE id=$1", [row.id]);
    await pool.query("UPDATE categories SET deleted_at=NULL WHERE id=$1", [category.id]);
    await pool.query("UPDATE products SET status='published' WHERE id=$1", [row.id]);
  });

  it("changes stock only through the stock ledger, starting from zero", async () => {
    const { row } = await product();
    const sku = () => "SKU_" + randomUUID().replaceAll("-", "").toUpperCase();
    await expect(
      db.variant.create({ data: { productId: row.id, sku: sku(), stockOnHand: 5 } }),
    ).rejects.toThrow();
    const variant = await db.variant.create({ data: { productId: row.id, sku: sku() } });
    await rejected("UPDATE variants SET stock_on_hand=5 WHERE id=$1", [variant.id], "42501");
    // Other fields stay editable.
    await pool.query("UPDATE variants SET low_stock_threshold=3 WHERE id=$1", [variant.id]);
    const client = await pool.connect();
    try {
      // The step-41 session flag no longer opens a path: only the ledger trigger may write.
      await client.query("BEGIN");
      await client.query("SELECT set_config('ih.stock_ledger','1',true)");
      await expect(
        client.query("UPDATE variants SET stock_on_hand=6 WHERE id=$1", [variant.id]),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    // The writer states the resulting balance; the trigger applies the delta and verifies it.
    await rejected(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 5, 999, 'INITIAL_STOCK', 'c0')",
      [variant.id],
      "IH002",
    );
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 5, 5, 'INITIAL_STOCK', 'c1')",
      [variant.id],
    );
    // Below zero is refused by the variant CHECK before any balance comparison.
    await rejected(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, note, command_id) VALUES ($1, -6, 0, 'MANUAL', 'count', 'c2')",
      [variant.id],
    );
    expect((await db.variant.findUniqueOrThrow({ where: { id: variant.id } })).stockOnHand).toBe(5);
  });

  it("denies the runtime role catalogue deletes and truncation", async () => {
    const { rows } = await pool.query("SELECT 1 FROM pg_roles WHERE rolname='ih_app'");
    if (!rows.length) return; // Role provisioned only where the runtime database exists.
    const privilege = async (table: string, kind: string) =>
      (
        await pool.query("SELECT has_table_privilege('ih_app', $1, $2) AS ok", [
          `"${namespace}".${table}`,
          kind,
        ])
      ).rows[0].ok as boolean;
    for (const table of ["brands", "categories", "products", "variants"]) {
      expect(await privilege(table, "DELETE")).toBe(false);
      expect(await privilege(table, "TRUNCATE")).toBe(false);
    }
    for (const table of ["product_options", "product_images", "slug_redirects"])
      expect(await privilege(table, "TRUNCATE")).toBe(false);
  });

  /** A processed media asset (step 50: gallery images reference ready assets). */
  async function readyAsset(productId: string) {
    const role = await db.role.findUniqueOrThrow({ where: { key: "staff" } });
    const uploader = await db.staffUser.create({
      data: {
        email: `uploader-${randomUUID()}@iqoshaven.test`,
        name: "Uploader",
        roleId: role.id,
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
      },
    });
    const id = randomUUID();
    await pool.query(
      `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
         declared_bytes, state, observed_bytes, width, height, sha256, upload_expires_at)
       VALUES ($1::uuid, $2, $3, 'uploads/' || $1::text, 'image/jpeg', 10, 'ready', 10, 100, 200,
         repeat('a', 64), statement_timestamp())`,
      [id, productId, uploader.id],
    );
    return id;
  }

  it("constrains image keys/metadata and enforces one primary image", async () => {
    const { row } = await product();
    const image = await db.productImage.create({
      data: {
        mediaAssetId: await readyAsset(row.id),
        productId: row.id,
        assetKey: "media/synthetic.webp",
        width: 100,
        height: 200,
        mime: "image/webp",
        isPrimary: true,
      },
    });
    await expect(
      db.productImage.create({
        data: {
          mediaAssetId: await readyAsset(row.id),
          productId: row.id,
          assetKey: "media/other.webp",
          width: 100,
          height: 200,
          mime: "image/webp",
          isPrimary: true,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    for (const asset of [
      "../private.webp",
      "https://example.test/a.webp",
      "/root.webp",
      "media//double.webp",
      "media/.webp",
      "media/a..webp",
    ])
      await rejected("UPDATE product_images SET asset_key=$1 WHERE id=$2", [asset, image.id]);
    await rejected("UPDATE product_images SET width=0 WHERE id=$1", [image.id]);
    await rejected("UPDATE product_images SET mime='image/svg+xml' WHERE id=$1", [image.id]);
  });
  it("retains references on deletion and rejects missing parents", async () => {
    const { row, brand, category } = await product();
    await db.variant.create({ data: { productId: row.id, sku: key().toUpperCase() } });
    await rejected("DELETE FROM brands WHERE id=$1", [brand.id], "23001");
    await rejected("DELETE FROM categories WHERE id=$1", [category.id], "23001");
    await rejected("DELETE FROM products WHERE id=$1", [row.id], "23001");
    await rejected("UPDATE products SET brand_id=$1 WHERE id=$2", [randomUUID(), row.id], "23503");
    expect(await db.variant.count({ where: { productId: row.id } })).toBe(1);
  });
  it("reserves redirect aliases within a namespace and resolves direct current entities", async () => {
    const { row, brand } = await product();
    const alias = key();
    await db.slugRedirect.create({
      data: { entityType: "product", oldSlug: alias, productId: row.id },
    });
    await rejected("UPDATE products SET slug=$1 WHERE id=$2", [alias, row.id], "23505");
    await rejected(
      "INSERT INTO slug_redirects(entity_type,old_slug,product_id) VALUES('product',$1,$2)",
      [row.slug, row.id],
      "23505",
    );
    await rejected(
      "INSERT INTO slug_redirects(entity_type,old_slug,brand_id) VALUES('product',$1,$2)",
      [key(), brand.id],
    );
    await db.brand.update({ where: { id: brand.id }, data: { slug: alias } }); // separate namespace
    const newSlug = key();
    await db.product.update({ where: { id: row.id }, data: { slug: newSlug } });
    const redirect = await db.slugRedirect.findFirstOrThrow({
      where: { oldSlug: alias },
      include: { product: true },
    });
    expect(redirect.product?.slug).toBe(newSlug);
    await rejected("DELETE FROM products WHERE id=$1", [row.id], "23001");
  });
  it("serializes a concurrent live slug and redirect claim across tables", async () => {
    const { row } = await product();
    const alias = key();
    const winner = await pool.connect();
    const contender = await pool.connect();
    try {
      await winner.query("BEGIN");
      await winner.query("INSERT INTO brands(name,slug) VALUES('Concurrent',$1)", [alias]);
      const pid = (await contender.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = contender
        .query(
          "INSERT INTO slug_redirects(entity_type,old_slug,brand_id) SELECT 'brand',$1,id FROM brands WHERE id=$2",
          [alias, (await db.brand.findUniqueOrThrow({ where: { id: row.brandId } })).id],
        )
        .then(
          () => "unexpected",
          (error: { code: string }) => error.code,
        );
      // Observe the actual advisory-lock wait, rather than assuming a scheduling delay.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting =
          (
            await pool.query(
              "SELECT wait_event='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0]?.waiting === true;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await winner.query("COMMIT");
      expect(await pending).toBe("23505");
    } finally {
      await winner.query("ROLLBACK");
      winner.release();
      contender.release();
    }
  });
  it("serializes a live slug update behind an uncommitted redirect reservation", async () => {
    const { row } = await product();
    const alias = key();
    const winner = await pool.connect();
    const contender = await pool.connect();
    try {
      await winner.query("BEGIN");
      await winner.query(
        "INSERT INTO slug_redirects(entity_type,old_slug,product_id) VALUES('product',$1,$2)",
        [alias, row.id],
      );
      const pid = (await contender.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = contender
        .query("UPDATE products SET slug=$1 WHERE id=$2", [alias, row.id])
        .then(
          () => "unexpected",
          (error: { code: string }) => error.code,
        );
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        waiting =
          (
            await pool.query(
              "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
              [pid],
            )
          ).rows[0]?.waiting === true;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await winner.query("COMMIT");
      expect(await pending).toBe("23505");
      expect((await db.product.findUniqueOrThrow({ where: { id: row.id } })).slug).toBe(row.slug);
    } finally {
      await winner.query("ROLLBACK");
      winner.release();
      contender.release();
    }
  });
});
