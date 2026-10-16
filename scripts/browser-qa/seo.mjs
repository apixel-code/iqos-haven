// Browser pass of the admin SEO screen (step 113) through the real gateway, on the schema
// served by qa-server.cjs:
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/seo.mjs <SCHEMA>
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
const { createDatabase, createPool, readPublicSeoPolicy } = fromApi("@ih/db");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-seo",
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

// A brand without SEO fields gives the report something to show.
const tag = Date.now().toString(36);
await db.brand.create({ data: { name: "Qa Seo " + tag, slug: "qa-seo-" + tag, active: true } });
// Start closed whatever an earlier run left.
await pool.query("DELETE FROM settings WHERE key='seo'");

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
try {
  const { page, errors } = await session("owner.qa@iqoshaven.test");
  await page.goto(BASE + "/workspace/seo");
  await page.getByRole("heading", { name: "Search engines" }).waitFor();
  check(
    "Closed is chosen by default",
    await page.getByRole("radio", { name: /Closed/ }).isChecked(),
  );
  const features = await page.locator("section", { hasText: "What is active" }).innerText();
  check(
    "product indexing is shown as inactive, not as a switch",
    /Inactive\s+Product indexing/.test(features) &&
      (await page.getByRole("checkbox", { name: /product/i }).count()) === 0,
    features.slice(0, 300),
  );
  check(
    "the sitemap is inactive while closed",
    /Inactive\s+Sitemap of public pages/.test(features),
  );
  await page.getByRole("heading", { name: "SEO issues" }).waitFor();
  check(
    "the report names the brand without SEO fields",
    (await page.locator("tr", { hasText: "Qa Seo " + tag }).count()) >= 1,
  );

  // Dismissing the question changes nothing.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("radio", { name: /Public pages/ }).click();
  await page.waitForTimeout(500);
  check("dismissing keeps the store closed", (await readPublicSeoPolicy(db)).indexing === "closed");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("radio", { name: /Public pages/ }).click();
  await page.getByText("Saved. The storefront follows within a minute.").waitFor();
  check(
    "accepting offers the public pages",
    (await readPublicSeoPolicy(db)).indexing === "public_pages",
  );
  check(
    "the sitemap now shows as active",
    /Active\s+Sitemap of public pages/.test(
      await page.locator("section", { hasText: "What is active" }).innerText(),
    ),
  );
  check(
    "the change was audited",
    (await db.auditLog.count({ where: { action: "seo.policy_updated" } })) >= 1,
  );
  await page.screenshot({ path: out + "seo.png", fullPage: true });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("radio", { name: /Closed/ }).click();
  await page.getByText("Saved. The storefront follows within a minute.").waitFor();
  check("closing again works", (await readPublicSeoPolicy(db)).indexing === "closed");
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    "SEO fits 390px without sideways scrolling",
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await page.screenshot({ path: out + "seo-390.png", fullPage: true });
  check("no page errors for the Owner", errors.length === 0, errors.join("; "));

  const staff = await session("staff.qa@iqoshaven.test");
  check(
    "Staff see no SEO link",
    (await staff.page.getByRole("link", { name: "SEO" }).count()) === 0,
  );
  await staff.page.goto(BASE + "/workspace/seo");
  await staff.page.getByText("Access unavailable").waitFor();
  check("Staff cannot open SEO", true);
} finally {
  await browser.close();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
