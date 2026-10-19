// Browser pass of the admin deep links (parity G-A2, ADR 0081) through the real gateway, on
// the schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/deep-links.mjs <SCHEMA>
// Orders, a low-stock line and two notifications are seeded with the database client; every
// link is then followed in the browser and must open that one record or filtered list.
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
const { createDatabase, createPool } = fromApi("@ih/db");
const { seedOrder } = fromApi("@ih/db/testing");
const { formatOrderNumber } = fromApi("@ih/domain");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-deep-links",
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
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? " — " + detail : ""}`);
};

// --- Seed: a delayed pending order, a fresh pending one, a confirmed one, a low stock line.
const late = await seedOrder(pool);
const fresh = await seedOrder(pool);
const confirmed = await seedOrder(pool, { status: "confirmed" });
// Placement time is immutable; only this fixture steps around the guard trigger.
await pool.query("ALTER TABLE orders DISABLE TRIGGER USER");
try {
  await pool.query("UPDATE orders SET created_at=now() - interval '150 minutes' WHERE id=$1", [
    late.orderId,
  ]);
} finally {
  await pool.query("ALTER TABLE orders ENABLE TRIGGER USER");
}
const number = (seeded) => formatOrderNumber(BigInt(seeded.orderNumber));
const low = await db.variant.update({
  where: { id: fresh.variantId },
  data: { lowStockThreshold: 5 },
});
await pool.query(
  "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, 2, 2, 'INITIAL_STOCK', $2)",
  [low.id, randomUUID()],
);
const product = await db.variant.findUniqueOrThrow({
  where: { id: low.id },
  include: { product: true },
});
// The dashboard lists low stock of products on sale only: put this one on sale.
await db.brand.update({ where: { id: product.product.brandId }, data: { active: true } });
await db.category.update({ where: { id: product.product.categoryId }, data: { active: true } });
await db.product.update({ where: { id: product.productId }, data: { status: "published" } });
const owner = await db.staffUser.findUniqueOrThrow({ where: { email: "owner.qa@iqoshaven.test" } });
async function notify(title, link) {
  const eventId = randomUUID();
  const row = await db.notification.create({
    data: { sourceEventId: eventId, type: "qa.deep_link", title, body: "QA", link },
  });
  await db.notificationReceipt.create({ data: { notificationId: row.id, userId: owner.id } });
}
await notify("Order link QA", `/orders/${late.orderId}`);
await notify("Stock link QA", `/inventory/${low.id}`);

const browser = await chromium.launch({ executablePath, headless: true });
async function session(email, viewport = { width: 1366, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
  return { context, page, errors };
}
const detailOf = (page, orderNumber) =>
  page.getByRole("heading", { name: orderNumber }).waitFor({ timeout: 15000 });
const listIds = async (page) => (await page.locator("main").innerText()).match(/IH-\d{6,}/g) ?? [];

try {
  const { page, errors } = await session("owner.qa@iqoshaven.test");

  // 1. One order by URL, reload, Back.
  await page.goto(`${BASE}/workspace/orders?order=${late.orderId}`);
  await detailOf(page, number(late));
  check("an order URL opens that order", true);
  await page.reload();
  await detailOf(page, number(late));
  check("reloading keeps the order open", true);
  await page.locator("button.backlink").click();
  await page.getByRole("tablist", { name: "Order status" }).waitFor();
  check("Back to orders drops the order from the URL", !page.url().includes("order="));
  await page.goBack();
  await detailOf(page, number(late));
  check("the browser's Back returns to the order", true);

  // 2. Dashboard links keep their filters.
  await page.goto(BASE + "/");
  await page.getByRole("link", { name: /pending orders? to confirm/ }).click();
  await page.waitForURL(/status=pending/);
  await page.getByText(number(fresh)).first().waitFor();
  let ids = await listIds(page);
  check(
    "the pending link lists pending orders only",
    ids.includes(number(late)) && ids.includes(number(fresh)) && !ids.includes(number(confirmed)),
    ids.join(","),
  );
  check(
    "the Pending tab is selected",
    (await page.getByRole("tab", { name: "Pending" }).getAttribute("aria-selected")) === "true",
  );
  await page.goto(BASE + "/");
  await page.getByRole("link", { name: /\d+ delayed/ }).click();
  await page.waitForURL(/delayed=1/);
  await page.getByText(number(late)).first().waitFor();
  ids = await listIds(page);
  check(
    "the delayed link lists only delayed orders",
    ids.includes(number(late)) && !ids.includes(number(fresh)),
    ids.join(","),
  );
  check(
    "Delayed only is shown as on",
    (await page.getByRole("button", { name: "Delayed only" }).getAttribute("aria-pressed")) ===
      "true",
  );
  await page.screenshot({ path: out + "deep-links-delayed.png", fullPage: true });
  await page.goto(BASE + "/");
  await page
    .getByRole("region", { name: "Recent orders" })
    .getByRole("link", { name: number(confirmed) })
    .click();
  await detailOf(page, number(confirmed));
  check("a recent order on the dashboard opens that order", true);
  await page.goto(BASE + "/");
  await page.locator(`a[href="/workspace/inventory?variant=${low.id}"]`).click();
  await page.waitForURL(/variant=/);
  await page.getByText("Showing one stock line.").waitFor();
  check("a low-stock line opens that one stock line", (await page.getByText(low.sku).count()) >= 1);

  // 3. Bell and inbox.
  await page.goto(BASE + "/");
  await page.getByRole("button", { name: /Notifications/ }).click();
  // The prototype's panel (V-A1): a notification is one button that opens what it is about.
  await page
    .getByRole("dialog", { name: "Notifications" })
    .locator('button.ni:has(use[href="#i-orders"])')
    .first()
    .click();
  await detailOf(page, number(late));
  check("the bell opens the notified order", true);
  await page.goto(BASE + "/workspace/notifications");
  await page.getByRole("link", { name: "Open stock" }).first().click();
  await page.getByText("Showing one stock line.").waitFor();
  check("the inbox opens the notified stock line", page.url().includes(`variant=${low.id}`));
  await page.getByRole("button", { name: "Show all stock" }).click();
  await page.waitForURL((url) => !url.search.includes("variant="));
  check("Show all stock clears the single line", true);

  // 4. Customer history and products.
  await page.goto(`${BASE}/workspace/customers?customer=${late.customerId}`);
  await page.getByRole("heading", { name: "Seed Customer" }).waitFor();
  check("a customer URL opens that customer", true);
  const history = page.locator("table").last();
  await history.getByRole("link").first().waitFor();
  const linked = await history.getByRole("link").first().innerText();
  await history.getByRole("link").first().click();
  await detailOf(page, linked);
  check("an order in a customer's history opens that order", true);
  await page.goto(`${BASE}/workspace/products?product=${product.productId}`);
  const productName = page.locator('main input[name="name"]');
  await productName.waitFor();
  await page.waitForFunction(
    () => document.querySelector('main input[name="name"]')?.value?.length > 0,
  );
  check(
    "a product URL opens that product's editor",
    (await productName.inputValue()) === product.product.name,
  );
  await page.goto(`${BASE}/workspace/orders?order=not-an-id`);
  await page.getByRole("tab", { name: "All" }).waitFor();
  check("a malformed order ID falls back to the list", true);
  check("no page errors", errors.length === 0, errors.join("; "));
} catch (error) {
  failed++;
  console.log("FAIL stopped: " + String(error).split("\n")[0]);
  for (const context of browser.contexts())
    for (const open of context.pages())
      await open.screenshot({ path: out + "deep-links-failed.png", fullPage: true });
} finally {
  await browser.close();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
