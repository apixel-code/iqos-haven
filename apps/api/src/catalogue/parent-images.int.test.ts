import "reflect-metadata";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  apiEnvSchema,
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
  storageIntegrationTestEnvSchema,
} from "@ih/config";
import {
  brandResponseSchema,
  catalogueImageResponseSchema,
  categoryResponseSchema,
  mediaUploadResponseSchema,
  storeBrandsResponseSchema,
  storeCategoriesResponseSchema,
} from "@ih/contracts";
import { createDatabase, createPool } from "@ih/db";
import { applyMigrations } from "@ih/db/testing";
import {
  AGE_COOKIE,
  Argon2PasswordHasher,
  ageTicketPublicKey,
  ageTicketSigner,
  signAgeTicket,
} from "@ih/platform";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../bootstrap";

/**
 * Brand logos, category images and the Owner's purge of brands and categories (parity G-A7,
 * ADR 0091), through the real API and PostgreSQL. Processed images are inserted as the worker
 * would leave them; the upload policy itself is the product images' (step 48).
 */
loadLocalEnvFile();
const { DATABASE_TEST_URL } = loadEnv(integrationTestEnvSchema);
assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = loadEnv(storageIntegrationTestEnvSchema);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-parent-images-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
const ADMIN = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const POLICY = "images-1";
const signer = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return ageTicketSigner(
    "k1",
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url"),
  );
})();
const env = apiEnvSchema.parse({
  NODE_ENV: "test",
  APP_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: DATABASE_TEST_URL,
  QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
  ARGON2_MEMORY_KIB: 19456,
  ARGON2_TIME_COST: 2,
  ...storageEnv,
  S3_FORCE_PATH_STYLE: "true",
  AGE_POLICY_VERSION: POLICY,
  AGE_TICKET_PUBLIC_KEYS: `k1:${ageTicketPublicKey(signer)}`,
});
const ageCookie = `${AGE_COOKIE}=${signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;

let app: INestApplication;
let base = "";
const cookies = { owner: "", staff: "" };
let ownerId = "";
let host = 10;
const call = (path: string, method = "GET", body?: unknown, cookie = cookies.owner) =>
  fetch(`${base}/v1/admin${path}`, {
    method,
    headers: {
      cookie,
      "x-ih-client-ip": `192.0.2.${(host = (host % 240) + 1)}`,
      ...(method === "GET" ? {} : { origin: ADMIN, "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const store = (path: string) =>
  fetch(`${base}/v1/store${path}`, {
    headers: { cookie: ageCookie, "x-ih-client-ip": `198.51.100.${(host = (host % 240) + 1)}` },
  });
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;
const key = () => randomUUID().slice(0, 8);
/** A catalogue image as the worker leaves it once processed. */
async function readyImage(purpose = "catalogue") {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO media_assets (id, purpose, uploaded_by, quarantine_key, declared_type,
       declared_bytes, upload_expires_at, state, observed_bytes, observed_type, width, height,
       sha256, derivative_keys)
     VALUES ($1, $2, $3, $5, 'image/png', 64, now() + interval '1 hour', 'ready',
       64, 'image/png', 200, 200, repeat('a', 64), $4::jsonb)`,
    [
      id,
      purpose,
      ownerId,
      JSON.stringify({
        thumb: `content/${id}/thumb.webp`,
        medium: `content/${id}/medium.webp`,
        large: `content/${id}/large.webp`,
      }),
      `uploads/${id}`,
    ],
  );
  return id;
}
const stateOf = async (assetId: string) =>
  (await pool.query("SELECT state FROM media_assets WHERE id=$1", [assetId])).rows[0]?.state;

describe("brand logos, category images and parent purge (real API and PostgreSQL)", () => {
  beforeAll(async () => {
    await applyMigrations(pool, namespace);
    const hasher = new Argon2PasswordHasher({ memoryKib: 19456, timeCost: 2, parallelism: 1 });
    for (const roleKey of ["owner", "staff"] as const) {
      const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
      const user = await db.staffUser.create({
        data: {
          email: `${roleKey}-images@iqoshaven.test`,
          name: roleKey,
          roleId: role.id,
          passwordHash: await hasher.hash(PASSWORD),
        },
      });
      if (roleKey === "owner") ownerId = user.id;
    }
    app = await createApp(env, { pool, database: db });
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    for (const roleKey of ["owner", "staff"] as const) {
      const response = await fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: {
          origin: ADMIN,
          "content-type": "application/json",
          "x-ih-client-ip": "192.0.2.250",
        },
        body: JSON.stringify({ email: `${roleKey}-images@iqoshaven.test`, password: PASSWORD }),
      });
      expect(response.status).toBe(200);
      cookies[roleKey] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
  });
  afterAll(async () => {
    await app?.close();
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });

  it("authorizes a catalogue image upload for staff who edit the catalogue, and reports it", async () => {
    const granted = await call(
      "/catalogue-images/uploads",
      "POST",
      { contentType: "image/png", bytes: 64 },
      cookies.staff,
    );
    expect(granted.status).toBe(201);
    const grant = mediaUploadResponseSchema.parse(await granted.json());
    expect(grant.asset).toMatchObject({ productId: null, state: "pending" });
    expect(
      (await pool.query("SELECT purpose FROM media_assets WHERE id=$1", [grant.asset.id])).rows[0]
        .purpose,
    ).toBe("catalogue");
    // Nothing was uploaded to the signed policy: completing it is refused.
    const completed = await call(`/catalogue-images/${grant.asset.id}/complete`, "POST", {});
    expect(completed.status).toBe(409);
    expect(await code(completed)).toBe("UPLOAD_MISSING");
    const status = catalogueImageResponseSchema.parse(
      await (await call(`/catalogue-images/${grant.asset.id}`)).json(),
    );
    expect(status).toMatchObject({ id: grant.asset.id, url: null });
    // A ready one has a preview; a product or content image is not a catalogue image.
    const ready = await readyImage();
    const preview = catalogueImageResponseSchema.parse(
      await (await call(`/catalogue-images/${ready}`)).json(),
    );
    expect(preview.state).toBe("ready");
    expect(preview.url).toMatch(/^https?:\/\//);
    expect((await call(`/catalogue-images/${await readyImage("content")}`)).status).toBe(404);
  });

  it("sets, replaces and clears a brand logo, shown in the store, releasing the old image", async () => {
    const first = await readyImage();
    const created = await call("/brands", "POST", {
      name: "Logo " + key(),
      slug: "logo-" + key(),
      active: true,
      logoAssetId: first,
    });
    expect(created.status).toBe(201);
    let brand = brandResponseSchema.parse(await created.json());
    expect(brand.logoAssetId).toBe(first);

    // The store shows it (brands with a visible product only appear in the store list, but the
    // route lists every active brand).
    const listed = storeBrandsResponseSchema.parse(await (await store("/brands")).json());
    const shown = listed.items.find((item) => item.slug === brand.slug);
    expect(shown?.logo?.alt).toBe(brand.name);
    expect(shown?.logo?.urls.medium).toMatch(/^https?:\/\//);

    // A logo still in use stays ready.
    await expect(
      pool.query("UPDATE media_assets SET state='removed' WHERE id=$1", [first]),
    ).rejects.toThrow();

    const second = await readyImage();
    const replaced = await call(`/brands/${brand.id}`, "PATCH", {
      version: brand.version,
      name: brand.name,
      slug: brand.slug,
      description: brand.description,
      active: true,
      sortOrder: brand.sortOrder,
      logoAssetId: second,
    });
    expect(replaced.status).toBe(200);
    brand = brandResponseSchema.parse(await replaced.json());
    expect(brand.logoAssetId).toBe(second);
    expect(await stateOf(first)).toBe("removed");

    // Leaving it out keeps it; null clears and releases it.
    const kept = brandResponseSchema.parse(
      await (
        await call(`/brands/${brand.id}`, "PATCH", {
          version: brand.version,
          name: brand.name + " Kept",
          slug: brand.slug,
          description: brand.description,
          active: true,
          sortOrder: brand.sortOrder,
        })
      ).json(),
    );
    expect(kept.logoAssetId).toBe(second);
    const cleared = brandResponseSchema.parse(
      await (
        await call(`/brands/${brand.id}`, "PATCH", {
          version: kept.version,
          name: kept.name,
          slug: kept.slug,
          description: kept.description,
          active: true,
          sortOrder: kept.sortOrder,
          logoAssetId: null,
        })
      ).json(),
    );
    expect(cleared.logoAssetId).toBeNull();
    expect(await stateOf(second)).toBe("removed");
  });

  it("refuses an image that is not a ready catalogue image", async () => {
    const pending = (
      await pool.query(
        `INSERT INTO media_assets (id, purpose, uploaded_by, quarantine_key, declared_type,
           declared_bytes, upload_expires_at)
         SELECT g, 'catalogue', $1, 'uploads/' || g, 'image/png', 64, now() + interval '1 hour'
         FROM (SELECT gen_random_uuid() AS g) x RETURNING id`,
        [ownerId],
      )
    ).rows[0].id as string;
    for (const logoAssetId of [pending, await readyImage("content"), randomUUID()]) {
      const response = await call("/brands", "POST", {
        name: "Bad " + key(),
        slug: "bad-" + key(),
        active: true,
        logoAssetId,
      });
      expect(response.status, logoAssetId).toBe(409);
      expect(await code(response)).toBe("MEDIA_NOT_READY");
    }
  });

  it("sets a category image, shown in the store", async () => {
    const image = await readyImage();
    const created = await call("/categories", "POST", {
      name: "Pictured " + key(),
      slug: "pictured-" + key(),
      active: true,
      imageAssetId: image,
    });
    expect(created.status).toBe(201);
    const category = categoryResponseSchema.parse(await created.json());
    expect(category.imageAssetId).toBe(image);
    const listed = storeCategoriesResponseSchema.parse(await (await store("/categories")).json());
    expect(listed.items.find((item) => item.slug === category.slug)?.image?.alt).toBe(
      category.name,
    );
  });

  it("purges a trashed, unused brand for the Owner only, with its redirects and image", async () => {
    const image = await readyImage();
    let brand = brandResponseSchema.parse(
      await (
        await call("/brands", "POST", {
          name: "Purge " + key(),
          slug: "purge-" + key(),
          active: true,
          logoAssetId: image,
        })
      ).json(),
    );
    // A renamed slug leaves a redirect behind.
    const oldSlug = brand.slug;
    brand = brandResponseSchema.parse(
      await (
        await call(`/brands/${brand.id}`, "PATCH", {
          version: brand.version,
          name: brand.name,
          slug: oldSlug + "-new",
          description: brand.description,
          active: true,
          sortOrder: brand.sortOrder,
        })
      ).json(),
    );
    const notTrashed = await call(`/brands/${brand.id}/purge`, "POST", { version: brand.version });
    expect(notTrashed.status).toBe(409);
    expect(await code(notTrashed)).toBe("NOT_TRASHED");
    brand = brandResponseSchema.parse(
      await (await call(`/brands/${brand.id}/trash`, "POST", { version: brand.version })).json(),
    );
    expect(
      (await call(`/brands/${brand.id}/purge`, "POST", { version: brand.version }, cookies.staff))
        .status,
    ).toBe(403);
    const purged = await call(`/brands/${brand.id}/purge`, "POST", { version: brand.version });
    expect(purged.status).toBe(200);
    expect(await purged.json()).toEqual({ purged: true });
    expect((await pool.query("SELECT 1 FROM brands WHERE id=$1", [brand.id])).rowCount).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM slug_redirects WHERE old_slug=$1", [oldSlug])).rowCount,
    ).toBe(0);
    expect(await stateOf(image)).toBe("removed");
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_log WHERE action='catalog.brand_purged' AND entity_id=$1",
          [brand.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await call(`/brands/${brand.id}/purge`, "POST", { version: brand.version })).status,
    ).toBe(404);
  });

  it("refuses to purge a category that a product (even a trashed one) uses", async () => {
    const brand = brandResponseSchema.parse(
      await (
        await call("/brands", "POST", {
          name: "Used " + key(),
          slug: "used-" + key(),
          active: true,
        })
      ).json(),
    );
    let category = categoryResponseSchema.parse(
      await (
        await call("/categories", "POST", {
          name: "Used " + key(),
          slug: "used-" + key(),
          active: true,
        })
      ).json(),
    );
    await db.product.create({
      data: {
        name: "Draft user",
        slug: "draft-user-" + key(),
        brandId: brand.id,
        categoryId: category.id,
        type: "kit",
        basePriceFils: 1000n,
        deletedAt: new Date(),
      },
    });
    category = categoryResponseSchema.parse(
      await (
        await call(`/categories/${category.id}/trash`, "POST", { version: category.version })
      ).json(),
    );
    const refused = await call(`/categories/${category.id}/purge`, "POST", {
      version: category.version,
    });
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe("IN_USE");
    expect((await pool.query("SELECT 1 FROM categories WHERE id=$1", [category.id])).rowCount).toBe(
      1,
    );
  });
});
