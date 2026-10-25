// Browser pass of the admin discounts screen (V-A9, ADR 0097) through the real gateway, on the
// schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/discounts.mjs <SCHEMA>
// A coupon is created in the drawer, switched off from the list, edited, moved to Trash and
// restored; every step is checked in the database as well as on screen.
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
  applicationName: "ih-qa-discounts",
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
const code = "DQA" + Date.now().toString(36).toUpperCase();
const row = async () =>
  (
    await pool.query(
      "SELECT percent_bps, min_subtotal_fils::int AS min_subtotal_fils, active, deleted_at AS trashed_at FROM coupons WHERE code=$1",
      [code],
    )
  ).rows[0];
async function until(test) {
  for (let i = 0; i < 40; i++) {
    const value = await row();
    if (value && test(value)) return value;
    await new Promise((done) => setTimeout(done, 250));
  }
  return row();
}

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
  await page.goto(BASE + "/workspace/discounts");
  await page.getByRole("button", { name: "New coupon" }).first().click();
  const drawer = page.getByRole("dialog", { name: "New coupon" });
  await drawer.getByRole("button", { name: "Generate" }).click();
  check(
    "Generate fills in an 8-character code",
    /^[A-Z2-9]{8}$/.test(await drawer.getByLabel("Coupon code").inputValue()),
  );
  await drawer.getByLabel("Coupon code").fill(code.toLowerCase());
  await drawer.getByLabel("Percentage off").fill("12.5");
  await drawer.getByLabel("Minimum order").fill("100");
  const preview = await drawer.locator(".note.info").innerText();
  check(
    "the drawer previews the coupon as it is typed",
    preview.includes(`${code} gives 12.5% off orders of AED 100.00 or more`) &&
      preview.includes("saves AED 12.50"),
    preview,
  );
  await page.screenshot({ path: out + "discounts-drawer.png" });
  await drawer.getByRole("button", { name: "Create & activate" }).click();
  const listed = page.locator(".coupon-row:visible", { hasText: code });
  await listed.waitFor({ timeout: 10000 });
  let saved = await until((value) => value.active);
  check(
    "Create & activate saves an active coupon with exact terms",
    saved?.active === true && saved.percent_bps === 1250 && saved.min_subtotal_fils === 10000,
    JSON.stringify(saved),
  );
  check("the list shows its percentage", (await listed.innerText()).includes("12.5%"));
  await page.screenshot({ path: out + "discounts-1366.png", fullPage: true });

  await listed.getByLabel(`${code} active`).click(); // the switch follows the saved state
  saved = await until((value) => !value.active);
  check(
    "the switch turns it off and keeps its terms",
    saved?.active === false && saved.percent_bps === 1250 && saved.min_subtotal_fils === 10000,
    JSON.stringify(saved),
  );
  await page.getByRole("tab", { name: /Inactive/ }).click();
  await page.locator(".coupon-row:visible", { hasText: code }).waitFor();
  check("an inactive coupon is under Inactive", true);

  await page
    .locator(".coupon-row:visible", { hasText: code })
    .getByRole("button", { name: `Edit ${code}` })
    .click();
  const edit = page.getByRole("dialog", { name: `Edit ${code}` });
  await edit.getByLabel("Percentage off").fill("15");
  await edit.getByRole("button", { name: "Save changes" }).click();
  saved = await until((value) => value.percent_bps === 1500);
  check(
    "an edit saves the new percentage and keeps it inactive",
    saved?.percent_bps === 1500 && saved.active === false,
    JSON.stringify(saved),
  );

  await page.getByRole("tab", { name: /All/ }).click();
  await page
    .locator(".coupon-row:visible", { hasText: code })
    .getByRole("button", { name: `Move ${code} to Trash` })
    .click();
  await page.locator("[data-confirm-ok]").click();
  saved = await until((value) => value.trashed_at !== null);
  check("Move to Trash trashes it", saved?.trashed_at !== null, JSON.stringify(saved));
  await page.getByRole("tab", { name: /Trash/ }).click();
  const trashed = page.locator(".coupon-row:visible", { hasText: code });
  await trashed.getByRole("button", { name: "Restore as inactive" }).click();
  saved = await until((value) => value.trashed_at === null);
  check(
    "Restore as inactive brings it back switched off",
    saved?.trashed_at === null && saved.active === false,
    JSON.stringify(saved),
  );
  check("no page errors on a wide screen", errors.length === 0, errors.join("; "));
  await context.close();

  const phone = await session({ width: 390, height: 844 });
  await phone.page.goto(BASE + "/workspace/discounts");
  await phone.page.locator(".coupon-row:visible", { hasText: code }).waitFor();
  check(
    "no sideways scrolling at 390px",
    await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await phone.page.screenshot({ path: out + "discounts-390.png", fullPage: true });
  check("no page errors on a phone", phone.errors.length === 0, phone.errors.join("; "));
  await phone.context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
