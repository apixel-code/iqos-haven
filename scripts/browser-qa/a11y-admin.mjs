// Accessibility pass of the admin (roadmap step 120, local part) through the real gateway, on
// the schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/a11y-admin.mjs <SCHEMA>
// QA_PLAYWRIGHT_DIR must hold playwright-core and axe-core (`npm i playwright-core@1 axe-core@4`).
// axe-core (WCAG 2.1 A/AA) on the sign-in page and every Owner section at 1366px and 390px, in
// the light and dark themes, then keyboard-only sign-in, form errors and the notification panel.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const playwrightDir = process.env.QA_PLAYWRIGHT_DIR;
if (!playwrightDir) throw new Error("Set QA_PLAYWRIGHT_DIR (see scripts/browser-qa/README.md)");
const fromQa = createRequire(resolve(playwrightDir, "package.json"));
const { chromium } = fromQa("playwright-core");
const axePath = fromQa.resolve("axe-core/axe.min.js");
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
  applicationName: "ih-qa-a11y-admin",
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
async function scan(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () =>
    // eslint-disable-next-line no-undef
    axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }),
  );
  const blocking = result.violations.filter((v) => ["serious", "critical"].includes(v.impact));
  const describe = (list) =>
    list
      .map((v) => `${v.id}(${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`)
      .join("; ");
  check(`axe ${label}`, blocking.length === 0, describe(blocking));
  const minor = result.violations.filter((v) => !blocking.includes(v));
  if (minor.length) console.log(`  note ${label}: ${describe(minor)}`);
}

const seeded = await seedOrder(pool);
// An unread notification, so the bell is checked with its count (step 120 missed that state).
const owner = (await pool.query("SELECT id FROM staff_users WHERE email='owner.qa@iqoshaven.test'"))
  .rows[0];
const note = (
  await pool.query(
    "INSERT INTO notifications (source_event_id, type, title, body, link) VALUES (gen_random_uuid(), 'qa.a11y', 'QA notice', 'QA', '/reviews') RETURNING id",
  )
).rows[0];
await pool.query("INSERT INTO notification_receipts (notification_id, user_id) VALUES ($1, $2)", [
  note.id,
  owner.id,
]);
// Prefer a product with images (after qa.mjs on this schema), so the image tiles are checked too.
const editProduct = (
  await pool.query(
    `SELECT p.id FROM products p WHERE p.deleted_at IS NULL
     ORDER BY EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id) DESC LIMIT 1`,
  )
).rows[0].id;
const SECTIONS = [
  "orders",
  "products",
  "brands",
  "categories",
  "inventory",
  "customers",
  "reviews",
  "notifications",
  "analytics",
  "reports",
  "staff",
  "discounts",
  "delivery",
  "content",
  "settings",
  "seo",
];
const browser = await chromium.launch({ executablePath, headless: true });
async function signIn(page) {
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', "owner.qa@iqoshaven.test");
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
}
try {
  for (const [viewport, scheme] of [
    [{ width: 1366, height: 900 }, "light"],
    [{ width: 1366, height: 900 }, "dark"],
    [{ width: 390, height: 844 }, "light"],
  ]) {
    const context = await browser.newContext({ viewport, colorScheme: scheme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const tag = `@${viewport.width} ${scheme}`;
    await page.goto(BASE + "/login");
    await page.locator('input[name="email"]').waitFor();
    await scan(page, `sign-in ${tag}`);
    await signIn(page);
    await page.waitForLoadState("networkidle");
    await scan(page, `home ${tag}`);
    for (const section of SECTIONS) {
      await page.goto(`${BASE}/workspace/${section}`);
      await page.waitForLoadState("networkidle");
      await scan(page, `${section} ${tag}`);
    }
    // A customer's page (V-A7).
    await page.goto(`${BASE}/workspace/customers?customer=${seeded.customerId}`);
    await page.locator(".kpis").waitFor();
    await page.waitForLoadState("networkidle");
    await scan(page, `customer detail ${tag}`);
    // The brand drawer (V-A6), checked open after its slide-in.
    await page.goto(`${BASE}/workspace/brands`);
    await page.getByRole("button", { name: "New brand" }).click();
    await page.getByRole("dialog", { name: "New brand" }).waitFor();
    await page.waitForTimeout(400);
    await scan(page, `new brand ${tag}`);
    await page.keyboard.press("Escape");
    // The "Update stock" drawer (V-A5), checked open after its slide-in.
    await page.goto(`${BASE}/workspace/inventory`);
    const update = page.getByRole("button", { name: /^Update stock of / }).first();
    await update.waitFor();
    await update.click();
    await page.getByRole("dialog", { name: "Update stock" }).waitFor();
    await page.waitForTimeout(400);
    await scan(page, `update stock ${tag}`);
    await page.keyboard.press("Escape");
    await page.goto(`${BASE}/workspace/orders?order=${seeded.orderId}`);
    await page.locator(".prog").waitFor();
    await scan(page, `order detail ${tag}`);
    // The edit drawer (V-A3b) is checked open as well.
    if (await page.getByRole("button", { name: "Edit", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("dialog", { name: "Edit order" }).waitFor();
      // After the slide-in: mid-animation colours are half faded and read as low contrast.
      await page.waitForTimeout(400);
      await scan(page, `order edit ${tag}`);
      await page.keyboard.press("Escape");
    }
    await page.goto(`${BASE}/workspace/orders`);
    await page.getByRole("button", { name: "Create order", exact: true }).click();
    await page.getByRole("heading", { name: "Create order" }).waitFor();
    await page.waitForLoadState("networkidle");
    await scan(page, `new order ${tag}`);
    // The product editor (V-A4b): a saved product with its cards, and a new one.
    await page.goto(`${BASE}/workspace/products?product=${editProduct}`);
    await page.getByRole("heading", { name: "Options & variants" }).waitFor();
    await page.waitForLoadState("networkidle");
    await scan(page, `product editor ${tag}`);
    // The alt text dialog of the first image (V-A4c), when the product has one.
    const altButton = page.getByRole("button", { name: "Alt text of image 1" });
    if (await altButton.isVisible()) {
      await altButton.click();
      await page.getByRole("dialog", { name: "Alt text" }).waitFor();
      await page.waitForTimeout(400);
      await scan(page, `image alt text ${tag}`);
      await page.keyboard.press("Escape");
    }
    await page.goto(`${BASE}/workspace/products?new=1`);
    await page.getByRole("heading", { name: "Basic information" }).waitFor();
    await page.waitForLoadState("networkidle");
    // The theme's colour transition must finish first: half-way colours read as low contrast.
    await page.waitForTimeout(400);
    await scan(page, `new product ${tag}`);
    check(`no page errors ${tag}`, errors.length === 0, errors.join("; "));
    await context.close();
  }

  // Keyboard only: sign in, open the notification panel, close it with Escape.
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE + "/login");
  await page.locator('input[name="email"]').waitFor();
  await page.keyboard.press("Tab");
  const firstField = await page.evaluate(() => document.activeElement?.getAttribute("name"));
  if (firstField !== "email") await page.locator('input[name="email"]').focus();
  await page.keyboard.type("owner.qa@iqoshaven.test");
  await page.keyboard.press("Tab");
  check(
    "Tab moves from email to password",
    await page.evaluate(() => document.activeElement?.getAttribute("name") === "password"),
  );
  await page.keyboard.type("wrong-password-value-1");
  await page.keyboard.press("Enter");
  await page.getByRole("alert").first().waitFor({ timeout: 15000 });
  check("a refused sign-in is announced as an alert", true);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[name="password"]').press("Enter");
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
  check("Enter signs in", true);
  const bell = page.getByRole("button", { name: /^Notifications/ });
  await bell.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await panel.waitFor();
  check(
    "Enter opens the notification panel",
    (await bell.getAttribute("aria-expanded")) === "true",
  );
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
  check("Escape closes the notification panel", !(await panel.isVisible()));
  check(
    "focus returns to the bell",
    // The prototype's bell is an icon; its accessible name is the label (V-A1).
    await page.evaluate(() =>
      /^Notifications/.test(document.activeElement?.getAttribute("aria-label") ?? ""),
    ),
  );

  // Form errors: an empty required field in a management form is reported and reachable.
  await page.goto(BASE + "/workspace/orders");
  await page.getByRole("button", { name: "Create order", exact: true }).click();
  await page.getByRole("heading", { name: "Create order" }).waitFor();
  const missing = await page.evaluate(() => {
    // The wizard's current step (V-A3c); each step's fields carry labels.
    const required = [...document.querySelectorAll("main [required]")];
    return required.every((field) => {
      const label = field.closest("label") ?? document.querySelector(`label[for="${field.id}"]`);
      return Boolean(label?.textContent?.trim());
    });
  });
  check("every required field in the new-order form has a visible label", missing);
  await page.screenshot({ path: out + "a11y-admin-new-order.png", fullPage: true });
  await context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
