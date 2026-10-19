// Browser pass of brand logos, category images and the Owner's purge (parity G-A7, ADR 0091)
// through the real gateway, on the schema served by qa-server.cjs (whose worker processes the
// uploads; see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/parent-images.mjs <SCHEMA>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { autoConfirm } from "./confirm.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const playwrightDir = process.env.QA_PLAYWRIGHT_DIR;
if (!playwrightDir) throw new Error("Set QA_PLAYWRIGHT_DIR (see scripts/browser-qa/README.md)");
const { chromium } = createRequire(resolve(playwrightDir, "package.json"))("playwright-core");
const schema = process.argv[2];
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? "")) throw new Error("usage: <SCHEMA>");
const fromApi = createRequire(root + "/apps/api/package.json");
const config = fromApi("@ih/config");
const { createPool } = fromApi("@ih/db");
const sharp = createRequire(root + "/apps/worker/package.json")("sharp");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-parent-images",
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
const png = await sharp({
  create: { width: 320, height: 320, channels: 3, background: { r: 30, g: 90, b: 160 } },
})
  .png()
  .toBuffer();
const tag = Math.random().toString(36).slice(2, 8);

const browser = await chromium.launch({ executablePath, headless: true });
async function session(email) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await autoConfirm(page);
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
  return { context, page, errors };
}
const brandRow = async (name) =>
  (await pool.query("SELECT id, logo_asset_id AS logo FROM brands WHERE name=$1", [name])).rows[0];

try {
  const { context, page, errors } = await session("staff.qa@iqoshaven.test");
  await page.goto(BASE + "/workspace/brands");
  await page.getByText("New brand").click();
  const name = `Logo QA ${tag}`;
  const form = page.locator("details form").first();
  await form.getByLabel(/name \*/i).fill(name);
  await form.locator('input[type="file"]').setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: png,
  });
  await form.locator(".parent-image-preview").waitFor({ timeout: 30000 });
  check(true, "an uploaded logo is processed and previewed");
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "the form causes no sideways scrolling",
  );
  await page.screenshot({ path: out + "parent-image-create.png", fullPage: true });
  await form.getByRole("button", { name: "Create brand" }).click();
  for (let i = 0; i < 30 && !(await brandRow(name)); i++) await page.waitForTimeout(300);
  const created = await brandRow(name);
  check(Boolean(created?.logo), "the brand is saved with its logo", JSON.stringify(created));

  // Remove it from the brand's own form.
  const card = page.locator("form.record-card", { hasText: name });
  await card.locator(".parent-image-preview").waitFor({ timeout: 15000 });
  check(true, "the saved logo shows in the brand's form");
  await card.getByRole("button", { name: "Remove image" }).click();
  await card.getByRole("button", { name: "Save changes" }).click();
  for (let i = 0; i < 30 && (await brandRow(name))?.logo; i++) await page.waitForTimeout(300);
  check(!(await brandRow(name)).logo, "Remove image and save clears the logo");
  const released = (await pool.query("SELECT state FROM media_assets WHERE id=$1", [created.logo]))
    .rows[0].state;
  check(released === "removed", "the cleared logo is released", released);
  check(
    (await page.getByRole("button", { name: "Delete permanently" }).count()) === 0,
    "staff are not offered permanent deletion",
  );
  check(errors.length === 0, "no page errors for staff", errors.join("; "));
  await context.close();

  // The Owner trashes and deletes it for good.
  const owner = await session("owner.qa@iqoshaven.test");
  await owner.page.goto(BASE + "/workspace/brands");
  const ownerCard = owner.page.locator("form.record-card", { hasText: name });
  await ownerCard.getByRole("button", { name: "Move to trash" }).click();
  await ownerCard.waitFor({ state: "detached" });
  await owner.page.getByRole("tab", { name: "Trash" }).click();
  const trashed = owner.page.locator("article.record-card", { hasText: name });
  await trashed.getByRole("button", { name: "Delete permanently" }).click();
  await trashed.waitFor({ state: "detached", timeout: 15000 });
  check(!(await brandRow(name)), "the Owner deletes a trashed, unused brand permanently");
  check(owner.errors.length === 0, "no page errors for the Owner", owner.errors.join("; "));
  await owner.context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
