// Browser pass of the admin products list (parity G-A8, ADR 0092) through the real gateway, on the
// schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/products-list.mjs <SCHEMA>
// Seeds three products (in stock, low, out; one with a real thumbnail), then checks SKU search,
// the stock filter and tag, the sorts, the thumbnail and a phone width.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const playwrightDir = process.env.QA_PLAYWRIGHT_DIR;
if (!playwrightDir) throw new Error("Set QA_PLAYWRIGHT_DIR (see scripts/browser-qa/README.md)");
const { chromium } = createRequire(resolve(playwrightDir, "package.json"))("playwright-core");
const schema = process.argv[2];
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? "")) throw new Error("usage: <SCHEMA>");
const fromApi = createRequire(root + "/apps/api/package.json");
const config = fromApi("@ih/config");
const { attachGalleryImage, createDatabase, createPool } = fromApi("@ih/db");
const { ObjectStorage, storageConfigFromEnv } = fromApi("@ih/platform");
const sharp = createRequire(root + "/apps/worker/package.json")("sharp");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const storageEnv = config.loadEnv(config.storageIntegrationTestEnvSchema);
const storage = new ObjectStorage(
  storageConfigFromEnv({ ...storageEnv, S3_FORCE_PATH_STYLE: true }),
);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-products-list",
  searchPath: schema,
});
const db = createDatabase(pool, { schema });
const out = resolve(process.env.QA_SHOTS_DIR ?? resolve(playwrightDir, "shots")) + "/";
mkdirSync(out, { recursive: true });
const BASE = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const executablePath =
  process.env.QA_CHROMIUM ??
  process.env.HOME +
    "/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
let failed = 0;
const check = (ok, name, detail = "") => {
  if (typeof name !== "string") throw new Error("check(ok, name): name must be text");
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? " — " + detail : ""}`);
};

// Seed: three products of one tag, stock through the ledger, one gallery image.
const tag = "Listqa" + Math.random().toString(36).slice(2, 7);
const owner = (await pool.query("SELECT id FROM staff_users WHERE email='owner.qa@iqoshaven.test'"))
  .rows[0];
const brand = await db.brand.create({
  data: { name: `${tag} brand`, slug: `${tag}-brand`.toLowerCase() },
});
const category = await db.category.create({
  data: { name: `${tag} category`, slug: `${tag}-category`.toLowerCase() },
});
async function product(name, price, stock, threshold) {
  const row = await db.product.create({
    data: {
      name: `${tag} ${name}`,
      slug: `${tag}-${name}`.toLowerCase(),
      brandId: brand.id,
      categoryId: category.id,
      type: "disposable",
      puffCount: 6000,
      basePriceFils: BigInt(price),
    },
  });
  const variant = await db.variant.create({
    data: {
      productId: row.id,
      sku: `${tag}-${name}`.toUpperCase(),
      active: true,
      isDefault: true,
      lowStockThreshold: threshold,
    },
  });
  if (stock)
    await pool.query(
      "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
      [variant.id, stock, randomUUID()],
    );
  return { ...row, sku: variant.sku };
}
const plenty = await product("plenty", 3000, 20, 5);
const low = await product("low", 1000, 3, 5);
const gone = await product("gone", 2000, 0, 0);
const assetId = randomUUID();
const keys = Object.fromEntries(
  ["large", "medium", "thumb"].map((n) => [n, `products/${plenty.id}/${assetId}/${n}.webp`]),
);
const webp = await sharp({
  create: { width: 160, height: 160, channels: 3, background: { r: 200, g: 60, b: 40 } },
})
  .webp()
  .toBuffer();
for (const key of Object.values(keys)) await storage.put("media", key, webp, "image/webp");
await pool.query(
  `INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
     declared_bytes, state, observed_bytes, width, height, sha256, derivative_keys,
     upload_expires_at)
   VALUES ($1::uuid, $2, $3, 'uploads/' || $1::text, 'image/jpeg', 10, 'ready', 10, 1200, 1200,
     repeat('a', 64), $4::jsonb, statement_timestamp())`,
  [assetId, plenty.id, owner.id, JSON.stringify(keys)],
);
await attachGalleryImage(db, { actorId: owner.id, requestId: randomUUID() }, plenty.id, {
  mediaAssetId: assetId,
});

const browser = await chromium.launch({ executablePath, headless: true });
async function session(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', "owner.qa@iqoshaven.test");
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
  return { context, page, errors };
}
const names = (page) =>
  // Table rows on a wide screen, phone rows at 390px: only one of the two is shown.
  page
    .locator(".product-row:visible")
    .evaluateAll((els) => els.map((el) => el.querySelector("b")?.textContent));
async function search(page, text) {
  const box = page.getByLabel("Search name or SKU");
  // The list searches as you type, after a short pause.
  await box.fill(text);
}
async function settle(page, expected) {
  for (let i = 0; i < 40; i++) {
    const now = await names(page);
    if (JSON.stringify(now) === JSON.stringify(expected)) return now;
    await page.waitForTimeout(250);
  }
  return names(page);
}

try {
  const { context, page, errors } = await session({ width: 1366, height: 900 });
  await page.goto(BASE + "/workspace/products");
  await search(page, low.sku.toLowerCase());
  const bySku = await settle(page, [low.name]);
  check(
    bySku.length === 1 && bySku[0] === low.name,
    "an option SKU finds its product",
    bySku.join(),
  );
  const lowRow = await page.locator(".product-row:visible").first().innerText();
  check(
    /Low stock/.test(lowRow) && /3 on hand/.test(lowRow),
    "the row shows the stock state",
    lowRow,
  );

  await search(page, tag);
  await page.getByLabel("Stock", { exact: true }).selectOption("out");
  const outOnly = await settle(page, [gone.name]);
  check(outOnly.length === 1 && outOnly[0] === gone.name, "Out of stock filters", outOnly.join());
  await page.getByLabel("Stock", { exact: true }).selectOption("");

  await page.getByLabel("Sort", { exact: true }).selectOption("price_desc");
  const byPrice = await settle(page, [plenty.name, gone.name, low.name]);
  check(
    JSON.stringify(byPrice) === JSON.stringify([plenty.name, gone.name, low.name]),
    "Price high to low orders the list",
    byPrice.join(),
  );
  await page.getByLabel("Sort", { exact: true }).selectOption("name");
  const byName = await settle(page, [gone.name, low.name, plenty.name]);
  check(
    JSON.stringify(byName) === JSON.stringify([gone.name, low.name, plenty.name]),
    "Name A–Z orders the list",
    byName.join(),
  );
  const thumb = page
    .locator(".product-row:visible", { hasText: plenty.name })
    .locator("img.product-thumb");
  await thumb.waitFor({ timeout: 10000 });
  check(
    await thumb.evaluate((img) => img.complete && img.naturalWidth > 0),
    "the main image's thumbnail loads",
  );
  check(
    (await page.locator(".product-row:visible", { hasText: low.name }).locator("img").count()) ===
      0,
    "a product without images shows a placeholder",
  );
  await page.screenshot({ path: out + "products-list-1366.png", fullPage: true });
  check(errors.length === 0, "no page errors on a wide screen", errors.join("; "));
  await context.close();

  const phone = await session({ width: 390, height: 844 });
  await phone.page.goto(BASE + "/workspace/products");
  await search(phone.page, tag);
  await settle(phone.page, [gone.name, low.name, plenty.name]);
  check(
    await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "no sideways scrolling at 390px",
  );
  await phone.page.screenshot({ path: out + "products-list-390.png", fullPage: true });
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();
} finally {
  await browser.close();
  storage.destroy();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
