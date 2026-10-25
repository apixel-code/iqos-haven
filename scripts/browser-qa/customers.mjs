// Browser pass of the admin customers screens (V-A7, ADR 0097) through the real gateway, on the
// schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/customers.mjs <SCHEMA>
// A customer with an order is seeded; the list must find them as you type, the detail must
// show their orders and address, and "New order" must open the manual order with them found.
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
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-customers",
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
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? " — " + detail : ""}`);
};

// --- Seed: one customer with a distinct name and an order.
const first = await seedOrder(pool);
const tag = Math.random().toString(36).slice(2, 8);
const name = `Customer QA ${tag}`;
// A real order sets `first_order_at`; the fixture order does not, and the list needs it.
await pool.query("UPDATE customers SET display_name=$1, first_order_at=now() WHERE id=$2", [
  name,
  first.customerId,
]);
const { phone } = (
  await pool.query("SELECT phone_e164 AS phone FROM customers WHERE id=$1", [first.customerId])
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

try {
  const { context, page, errors } = await session({ width: 1366, height: 900 });
  await page.goto(BASE + "/workspace/customers");
  await page.getByLabel("Search customers").fill(tag);
  const row = page.locator("tr.click", { hasText: name });
  await row.waitFor({ timeout: 10000 });
  check("the list finds a customer by name as you type", true);
  check("the row shows the phone number", (await row.innerText()).includes(phone));
  await page.getByLabel("Search customers").fill(phone.slice(-7));
  await row.waitFor({ timeout: 10000 });
  check("the list finds a customer by phone digits", true);
  await page.screenshot({ path: out + "customers-1366.png", fullPage: true });

  await row.getByRole("button", { name }).click();
  await page.waitForURL(/customer=/);
  await page.getByRole("heading", { name }).waitFor();
  check("a row opens the customer", true);
  check(
    "the detail shows the order count",
    (await page.locator(".kpi").first().locator(".kpi-v").innerText()) === "1",
  );
  const history = page.locator(".cust-orders");
  await history.getByRole("link").first().waitFor();
  check("the order history lists their orders", (await history.getByRole("link").count()) >= 1);
  const whatsapp = page.getByRole("link", { name: "WhatsApp" });
  check(
    "WhatsApp opens wa.me with the number",
    (await whatsapp.getAttribute("href")) === `https://wa.me/${phone.replace(/\D/g, "")}`,
  );
  check(
    "Call dials the number",
    (await page.getByRole("link", { name: "Call" }).getAttribute("href")) === `tel:${phone}`,
  );
  await page.screenshot({ path: out + "customer-detail-1366.png", fullPage: true });

  await page.getByRole("link", { name: "New order" }).click();
  await page.waitForURL(/new=1/);
  const phoneField = page.getByLabel("UAE mobile");
  await phoneField.waitFor();
  check("New order fills in the phone", (await phoneField.inputValue()) === phone);
  await page.locator(".customer-found").waitFor({ timeout: 10000 });
  check(
    "New order finds the customer at once",
    (await page.locator(".customer-found").innerText()).includes(name),
  );
  check("no page errors on a wide screen", errors.length === 0, errors.join("; "));
  await context.close();

  const phoneSession = await session({ width: 390, height: 844 });
  await phoneSession.page.goto(BASE + "/workspace/customers");
  await phoneSession.page.getByLabel("Search customers").fill(tag);
  await phoneSession.page.locator(".mrow", { hasText: name }).click();
  await phoneSession.page.getByRole("heading", { name }).waitFor();
  check(
    "no sideways scrolling at 390px",
    await phoneSession.page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await phoneSession.page.screenshot({ path: out + "customer-detail-390.png", fullPage: true });
  check(
    "no page errors on a phone",
    phoneSession.errors.length === 0,
    phoneSession.errors.join("; "),
  );
  await phoneSession.context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
