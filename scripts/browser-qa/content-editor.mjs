// Browser pass of the storefront content editor (step 97) through the real gateway, on the
// schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/content-editor.mjs <SCHEMA>
// Products are seeded with the real test helper; the Owner edits, uploads, previews and
// publishes in the browser; the qa-server worker processes the image.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const playwrightDir = process.env.QA_PLAYWRIGHT_DIR;
if (!playwrightDir) throw new Error("Set QA_PLAYWRIGHT_DIR (see scripts/browser-qa/README.md)");
const { chromium } = createRequire(resolve(playwrightDir, "package.json"))("playwright-core");
const sharp = createRequire(root + "/apps/worker/package.json")("sharp");
const schema = process.argv[2];
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? "")) throw new Error("usage: <SCHEMA>");
const fromApi = createRequire(root + "/apps/api/package.json");
const config = fromApi("@ih/config");
const { createDatabase, createPool } = fromApi("@ih/db");
const { seedOrder } = fromApi("@ih/db/testing");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-content",
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
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

/** A seeded product, renamed, published and on active parents unless `draft`. */
async function product(name, draft = false) {
  const { variantId } = await seedOrder(pool);
  const row = await one("SELECT product_id AS id FROM variants WHERE id=$1", [variantId]);
  await pool.query(
    `UPDATE brands SET active=true WHERE id=(SELECT brand_id FROM products WHERE id=$1)`,
    [row.id],
  );
  await pool.query(
    `UPDATE categories SET active=true WHERE id=(SELECT category_id FROM products WHERE id=$1)`,
    [row.id],
  );
  await pool.query("UPDATE products SET name=$2, status=$3 WHERE id=$1", [
    row.id,
    name,
    draft ? "draft" : "published",
  ]);
  return row.id;
}
const tag = Date.now().toString(36);
await product("Halo QA " + tag);
const hiddenId = await product("Draft QA " + tag, true);
await pool.query("UPDATE products SET status='published' WHERE id=$1", [hiddenId]);

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
const status = (page) => page.locator(".order-status").first().innerText();
try {
  const { page, errors } = await session("owner.qa@iqoshaven.test");
  await page.getByRole("link", { name: "Storefront content", exact: true }).click();
  await page.waitForURL("**/workspace/content");
  await page.getByRole("heading", { name: "Promotional bar" }).waitFor();
  check("a new section says it is not set up", (await status(page)) === "Not set up");

  // Ticker: markup is refused before anything is sent.
  await page.getByLabel("Message 1").fill("<b>10% off</b>");
  await page.getByLabel("Message 2").fill("UAE-wide delivery");
  await page.getByRole("button", { name: "Save draft" }).click();
  check("markup is refused by the form", (await page.getByText("Check these fields").count()) > 0);
  await page.getByLabel("Message 1").fill("Cash on delivery");
  await page.getByLabel("Show the promotional bar on the store").check();
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByText("Draft, never published").waitFor();
  check("saving a draft does not publish", true);
  await page.getByText("Cash on delivery  ·  UAE-wide delivery").waitFor();
  check("the preview shows the saved draft", true);
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByText("Live", { exact: true }).waitFor();
  check("publishing makes it live", true);

  // Featured: one visible product, then one that is hidden after being picked.
  await page.getByRole("tab", { name: /Featured products/ }).click();
  await page.getByPlaceholder("Search published products").fill("QA " + tag);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  for (const name of ["Halo QA " + tag, "Draft QA " + tag]) {
    await page.locator("li", { hasText: name }).getByRole("button", { name: "Add" }).click();
  }
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByText("Draft, never published").waitFor();
  await pool.query("UPDATE products SET status='draft' WHERE id=$1", [hiddenId]);
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByText("Not published:").waitFor();
  check(
    "publishing a hidden product is refused and named",
    (await page.locator('.notice[role="alert"]').innerText()).includes(
      `“Draft QA ${tag}” is not visible`,
    ),
  );
  await page
    .locator("li", { hasText: "Draft QA " + tag })
    .getByRole("button", { name: "Remove" })
    .click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByText("Live", { exact: true }).waitFor();
  check("without it, the section publishes", true);
  await page.screenshot({ path: out + "content-featured.png", fullPage: true });

  // Hero: headline, a button to a page, and an uploaded image processed by the worker.
  await page.getByRole("tab", { name: /Hero banner/ }).click();
  await page.getByLabel("Headline").fill("Every brand, one place");
  await page.getByRole("button", { name: "Add a button" }).click();
  await page.getByLabel("Button label").fill("Shop now");
  const image = await sharp({
    create: { width: 1600, height: 900, channels: 3, background: { r: 230, g: 200, b: 140 } },
  })
    .png()
    .toBuffer();
  await page.setInputFiles('input[type="file"]', {
    name: "hero.png",
    mimeType: "image/png",
    buffer: image,
  });
  const use = page.getByRole("button", { name: "Use this image" }).first();
  await use.waitFor({ timeout: 60000 });
  check("the uploaded image is processed and offered", true);
  await use.click();
  await page.getByLabel("Image description (for screen readers)").fill("Three devices on a table");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.locator(".preview-hero img").waitFor({ timeout: 15000 });
  check("the preview shows the processed image", true);
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByText("Live", { exact: true }).waitFor();
  check("the hero publishes with its image", true);
  const hero = await one("SELECT published FROM content_sections WHERE key='hero'");
  const [first] = hero.published.slides;
  check(
    "stored hero is typed data",
    first.title === "Every brand, one place" &&
      first.style === "navy" &&
      first.cta.link.kind === "shop" &&
      typeof first.image.assetId === "string",
  );

  // A second slide in the lilac look (the carousel, ADR 0097).
  await page.getByRole("button", { name: "Add slide" }).click();
  const second = page.locator("fieldset", { has: page.locator("legend", { hasText: "Slide 2" }) });
  await second.getByLabel("Look").selectOption("lilac");
  await second.getByLabel("Headline").fill("Fresh flavours this week");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("button", { name: "Publish" }).waitFor();
  await page.getByRole("button", { name: "Publish" }).click();
  await page.getByText("Live", { exact: true }).waitFor();
  const carousel = await one("SELECT published FROM content_sections WHERE key='hero'");
  check(
    "a second slide publishes in its own look",
    carousel.published.slides.length === 2 &&
      carousel.published.slides[1].style === "lilac" &&
      carousel.published.slides[1].title === "Fresh flavours this week",
  );
  await page.screenshot({ path: out + "content-hero.png", fullPage: true });

  // Unsaved changes are shown and can be discarded.
  await page.getByLabel("Headline").first().fill("Changed");
  check("unsaved changes are marked", (await status(page)) === "Unsaved");
  await page.getByRole("button", { name: "Discard changes" }).click();
  check(
    "discard restores the saved draft",
    (await page.getByLabel("Headline").first().inputValue()) === "Every brand, one place",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  check(
    "no horizontal scroll at 390px",
    !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
  );
  await page.screenshot({ path: out + "content-390.png", fullPage: true });
  check("no page errors", errors.length === 0, errors.join("; "));
  const events = await one(
    "SELECT count(*)::int AS n FROM outbox_events WHERE event_type='content.published'",
  );
  // One more than before: the hero is published again with its second slide.
  check("one content.published event per publish", events.n === 4, String(events.n));

  const staff = await session("staff.qa@iqoshaven.test");
  check(
    "staff see no content link",
    (await staff.page.getByRole("link", { name: "Storefront content", exact: true }).count()) === 0,
  );
  await staff.page.goto(BASE + "/workspace/content");
  await staff.page.getByText("Access unavailable").waitFor();
  check("staff cannot open the editor", true);
} finally {
  await browser.close();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
