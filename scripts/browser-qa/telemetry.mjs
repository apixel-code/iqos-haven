// Browser pass of storefront telemetry (step 104) against the real served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   (SERVING, SCHEMA)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/telemetry.mjs <SERVING> <SCHEMA>
// Browses, searches, saves and adds to the cart, then checks the events stored on the served
// schema. Then it blocks the events route entirely and shows the cart and checkout still work,
// and that the checkout page sends no event at all.
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const fromApi = createRequire(join(root, "apps/api/package.json"));
const config = fromApi("@ih/config");
const { createPool } = fromApi("@ih/db");
const [base, schema] = process.argv.slice(2);
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? "")) throw new Error("usage: <SERVING> <SCHEMA>");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-telemetry",
  searchPath: schema,
});
let failed = 0;
const check = (ok, name, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
};
const types = async () =>
  (await pool.query("SELECT type, count(*)::int AS n FROM events GROUP BY type ORDER BY type"))
    .rows;

const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).find((name) => /^chromium-\d+$/.test(name));
const sub = readdirSync(join(cache, dir)).find((name) => name.startsWith("chrome-"));
const browser = await chromium.launch({
  executablePath: join(
    cache,
    dir,
    sub,
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
  headless: true,
});
async function shopper() {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
  await context.request.post(base + "/api/age/accept", {
    headers: { origin: "https://shop.gate-check.test" },
    form: { return: "/" },
    maxRedirects: 0,
  });
  const page = await context.newPage();
  const posts = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/store/events"))
      posts.push({ path: new URL(page.url()).pathname, body: request.postData() });
  });
  return { context, page, posts };
}
try {
  // 1. Normal browsing reaches the database.
  const { context, page, posts } = await shopper();
  await page.goto(base + "/search?q=gatecheck");
  await page.goto(base + "/p/gatecheck-halo");
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  // Hiding the page sends what waits.
  await page.goto(base + "/shop");
  await page.waitForTimeout(6500);
  const stored = await types();
  const count = (type) => stored.find((row) => row.type === type)?.n ?? 0;
  check(count("search") >= 1, "search reached the database", JSON.stringify(stored));
  check(count("product_view") >= 1, "product view reached the database");
  check(count("wishlist_add") === 1, "save reached the database");
  check(count("cart_add") === 1, "add to cart reached the database");
  const term = (
    await pool.query("SELECT payload->>'term' AS t FROM events WHERE type='search' LIMIT 1")
  ).rows[0]?.t;
  check(term === "gatecheck", "search term stored normalized", term);
  const text = JSON.stringify(posts);
  check(!/cookie|phone|address|name"/i.test(text), "event bodies carry no personal fields");
  const deviceKeys = await page.evaluate(() => Object.keys(localStorage).sort());
  check(
    deviceKeys.every((key) => ["ih_anon_v1", "ih_cart_v1", "ih_lists_v1"].includes(key)),
    "the device keeps only the cart, the lists and the anonymous ID",
    deviceKeys.join(","),
  );

  // 2. The checkout page records and sends nothing.
  const before = posts.length;
  await page.goto(base + "/checkout");
  await page.getByRole("heading", { name: "Contact" }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(6000);
  check(
    posts.slice(before).length === 0,
    "the checkout page sends no telemetry",
    JSON.stringify(posts.slice(before)),
  );
  await context.close();

  // 3. With the events route failing, shopping is unaffected.
  const down = await shopper();
  let attempts = 0;
  await down.context.route("**/api/v1/store/events", (route) => {
    attempts += 1;
    return route.fulfill({ status: 503, body: "" });
  });
  const errors = [];
  down.page.on("pageerror", (error) => errors.push(error.message));
  await down.page.goto(base + "/p/gatecheck-halo");
  await down.page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  const started = Date.now();
  await down.page.getByRole("button", { name: "Add to cart" }).click();
  await down.page.waitForFunction(() =>
    (localStorage.getItem("ih_cart_v1") ?? "").includes("variantId"),
  );
  check(
    Date.now() - started < 2000,
    "add to cart is immediate while telemetry fails",
    `${Date.now() - started} ms`,
  );
  await down.page.goto(base + "/shop");
  await down.page.waitForTimeout(6500);
  await down.page.goto(base + "/checkout");
  await down.page.getByRole("heading", { name: "Contact" }).waitFor({ timeout: 15000 });
  check(true, "checkout opens while telemetry fails");
  check(attempts <= 2, "a failing events route is not hammered", String(attempts));
  check(errors.length === 0, "no page errors while telemetry fails", errors.join("; "));
  await down.context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
