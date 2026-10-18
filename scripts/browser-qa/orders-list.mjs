// Browser pass of the admin orders list (parity G-A5, ADR 0089) through the real gateway, on the
// schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/orders-list.mjs <SCHEMA>
// Seeds pending and confirmed orders of different sizes, then checks the tab counts, the sorts,
// select-all and the phone cards.
import { createRequire } from "node:module";
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
const { createPool } = fromApi("@ih/db");
const { seedOrder } = fromApi("@ih/db/testing");
const { formatOrderNumber } = fromApi("@ih/domain");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-orders-list",
  searchPath: schema,
});
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
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? " — " + detail : ""}`);
};

// Three pending orders (one large) and one confirmed.
await seedOrder(pool, { quantity: 1 });
await seedOrder(pool, { quantity: 2 });
const large = await seedOrder(pool, { quantity: 6 });
await seedOrder(pool, { status: "confirmed", quantity: 1 });
const counts = (
  await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE status='pending')::int AS pending FROM orders",
  )
).rows[0];

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
const tabText = (page, name) => page.getByRole("tab", { name: new RegExp(`^${name}`) }).innerText();

try {
  const { context, page, errors } = await session({ width: 1366, height: 900 });
  await page.goto(BASE + "/workspace/orders");
  await page.locator(".tab-count").first().waitFor();
  check(
    (await tabText(page, "All")).includes(String(counts.total)),
    "the All tab shows the number of orders",
    await tabText(page, "All"),
  );
  check(
    (await tabText(page, "Pending")).includes(String(counts.pending)),
    "the Pending tab shows the pending count",
    await tabText(page, "Pending"),
  );
  check(
    (await page.locator("main").innerText()).includes(`${counts.pending} waiting for confirmation`),
    "the header says how many wait for confirmation",
  );

  await page.getByLabel("Sort").selectOption("total_desc");
  await page.waitForURL(/sort=total_desc/);
  await page.locator(".order-table tbody tr").first().waitFor();
  const firstRow = await page.locator(".order-table tbody tr").first().innerText();
  check(
    firstRow.includes(formatOrderNumber(BigInt(large.orderNumber))),
    "Highest amount puts the largest order first",
    firstRow.slice(0, 120),
  );
  await page.getByLabel("Sort").selectOption("newest");
  await page.waitForURL((url) => !url.search.includes("sort="));

  await page.getByRole("tab", { name: /^Pending/ }).click();
  await page.waitForURL(/status=pending/);
  await page.locator(".order-table tbody tr").first().waitFor();
  const selectAll = page.getByLabel("Select all pending orders on this page");
  await selectAll.check();
  await page
    .getByRole("button", { name: new RegExp(`Confirm selected \\(${counts.pending}\\)`) })
    .waitFor();
  check(true, "select-all chooses every pending order on the page");
  await selectAll.uncheck();
  check(
    (await page.getByRole("button", { name: /Confirm selected/ }).count()) === 0,
    "unchecking clears the selection",
  );
  await page.screenshot({ path: out + "orders-list-1366.png", fullPage: true });
  check(errors.length === 0, "no page errors on a wide screen", errors.join("; "));
  await context.close();

  const phone = await session({ width: 390, height: 844 });
  await phone.page.goto(BASE + "/workspace/orders");
  await phone.page.locator(".order-card").first().waitFor();
  check(
    !(await phone.page.locator(".order-table").isVisible()),
    "on a phone the table gives way to cards",
  );
  const card = await phone.page.locator(".order-card").first().innerText();
  check(
    /IH-\d{6,}/.test(card) && /AED/.test(card) && /item/.test(card),
    "a card shows number, amount and items",
    card,
  );
  check(
    await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "no sideways scrolling at 390px",
  );
  await phone.page.screenshot({ path: out + "orders-list-390.png", fullPage: true });
  await phone.page.locator(".order-card").first().click();
  await phone.page.waitForURL(/order=/);
  await phone.page.getByRole("heading", { name: /IH-\d{6,}/ }).waitFor();
  check(true, "tapping a card opens the order");
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
