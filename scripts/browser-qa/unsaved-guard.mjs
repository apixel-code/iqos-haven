// Browser pass of the unsaved-changes guard (parity G-A9, ADR 0093) through the real gateway, on
// the schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/unsaved-guard.mjs <SCHEMA>
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
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-unsaved-guard",
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
  if (typeof name !== "string") throw new Error("check(ok, name): name must be text");
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? " — " + detail : ""}`);
};
const tag = "Guard" + Math.random().toString(36).slice(2, 7);
await pool.query("INSERT INTO brands (name, slug) VALUES ($1, $2)", [tag, tag.toLowerCase()]);

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
const nav = (page, name) =>
  page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name });

try {
  const { context, page, errors } = await session({ width: 1366, height: 900 });
  const leave = page.getByRole("dialog", { name: "Leave without saving?" });

  // Untouched editor: leaving is not interrupted.
  await page.goto(BASE + "/workspace/products");
  await page.getByRole("button", { name: "Add product" }).click();
  await page.getByRole("button", { name: "Back to products" }).first().click();
  await page.getByRole("button", { name: "Add product" }).waitFor();
  check(
    (await leave.count()) === 0 || !(await leave.isVisible()),
    "an untouched editor just closes",
  );

  // Typed into a new product, then Back: asked, Keep editing keeps the text.
  await page.getByRole("button", { name: "Add product" }).click();
  await page
    .getByLabel(/name \*/i)
    .first()
    .fill("Half-typed product");
  await page.getByRole("button", { name: "Back to products" }).first().click();
  await leave.waitFor();
  check(
    (await leave.innerText()).includes("unsaved changes to this new product"),
    "Back with changes asks first, naming the editor",
    await leave.innerText(),
  );
  check(
    await page.evaluate(() => document.activeElement?.textContent === "Keep editing"),
    "Keep editing has the focus (the safe choice)",
  );
  const wide = await leave.boundingBox();
  check(
    wide &&
      Math.abs(wide.x + wide.width / 2 - 683) < 4 &&
      Math.abs(wide.y + wide.height / 2 - 450) < 4,
    "the dialog is centred",
    JSON.stringify(wide),
  );
  await page.screenshot({ path: out + "unsaved-guard-1366.png" });
  await leave.getByRole("button", { name: "Keep editing" }).click();
  check(
    (await page
      .getByLabel(/name \*/i)
      .first()
      .inputValue()) === "Half-typed product",
    "Keep editing leaves the typed text in place",
  );

  // A sidebar link is guarded too; Escape keeps editing; Discard leaves.
  await nav(page, "Orders").click();
  await leave.waitFor();
  await page.keyboard.press("Escape");
  await leave.waitFor({ state: "hidden" });
  check(page.url().includes("/workspace/products"), "Escape stays on the editor");
  await nav(page, "Orders").click();
  await leave.getByRole("button", { name: "Discard changes" }).click();
  await page.waitForURL(/\/workspace\/orders/);
  check(true, "Discard changes follows the link");

  // A saved edit is not unsaved any more.
  await page.goto(BASE + "/workspace/brands");
  const card = page.locator("form.record-card", { hasText: tag });
  await card.getByLabel(/name \*/i).fill(tag + " renamed");
  await card.getByRole("button", { name: "Save changes" }).click();
  await page.locator("form.record-card", { hasText: tag + " renamed" }).waitFor();
  for (let i = 0; i < 30; i++) {
    const row = (await pool.query("SELECT name FROM brands WHERE slug=$1", [tag.toLowerCase()]))
      .rows[0];
    if (row?.name === tag + " renamed") break;
    await page.waitForTimeout(200);
  }
  await nav(page, "Categories").click();
  await page.waitForURL(/\/workspace\/categories/);
  check(!(await leave.isVisible()), "after a successful save, leaving is not interrupted");

  // Content editor state (not a form) is guarded as well.
  await page.goto(BASE + "/workspace/content");
  await page.getByLabel("Show the promotional bar on the store").click();
  await nav(page, "Settings").click();
  await leave.waitFor();
  check(
    (await leave.innerText()).includes("the storefront content"),
    "unsaved storefront content is guarded",
  );
  await leave.getByRole("button", { name: "Keep editing" }).click();

  // Closing the tab with changes gets the browser's own prompt.
  let prompted = false;
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") prompted = true;
    void dialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await new Promise((done) => setTimeout(done, 500));
  check(prompted, "closing or reloading with changes asks the browser to confirm");
  check(errors.length === 0, "no page errors", errors.join("; "));
  await context.close();

  // Phone width: the dialog fits.
  const phone = await session({ width: 390, height: 844 });
  await phone.page.goto(BASE + "/workspace/products");
  await phone.page.getByRole("button", { name: "Add product" }).click();
  await phone.page
    .getByLabel(/name \*/i)
    .first()
    .fill("Phone draft");
  await phone.page.getByRole("button", { name: "Back to products" }).first().click();
  const phoneDialog = phone.page.getByRole("dialog", { name: "Leave without saving?" });
  await phoneDialog.waitFor();
  const box = await phoneDialog.boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= 390, "the dialog fits a 390px screen");
  await phone.page.screenshot({ path: out + "unsaved-guard-390.png" });
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
