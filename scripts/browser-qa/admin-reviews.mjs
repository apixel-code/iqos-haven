// Browser pass of the admin Reviews screen (step 95) through the real gateway, on the schema
// served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/admin-reviews.mjs <SCHEMA>
// Two pending reviews are created with the real database commands (delivered order, review
// link, submission); the Owner approves one and rejects the other in the browser.
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
const { createDatabase, createPool, issueReviewLink, submitReview, transitionOrder } =
  fromApi("@ih/db");
const { seedOrder } = fromApi("@ih/db/testing");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-reviews",
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

const owner = await db.staffUser.findUniqueOrThrow({ where: { email: "owner.qa@iqoshaven.test" } });
const command = () => ({ requestId: randomUUID(), actorId: owner.id });
await pool.query(
  `INSERT INTO settings (key, value, updated_by) VALUES ('store', $1, $2)
   ON CONFLICT (key) DO UPDATE SET value = settings.value || $1`,
  [JSON.stringify({ name: "Iqos Haven", domain: "shop.qa.test" }), owner.id],
);
async function review(rating, title) {
  const seeded = await seedOrder(pool, { status: "confirmed" });
  for (const to of ["processing", "out_for_delivery", "delivered"]) {
    const { version } = await db.order.findUniqueOrThrow({ where: { id: seeded.orderId } });
    await transitionOrder(db, command(), seeded.orderId, {
      to,
      expectedVersion: version,
      commandId: randomUUID(),
    });
  }
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: seeded.orderId } });
  const { link } = await issueReviewLink(db, command(), seeded.orderId);
  await submitReview(db, {
    token: link.slice(link.indexOf("#") + 1),
    productId: item.productId,
    rating,
    title,
    body: "QA review body.\nSecond line.",
    authorName: "QA Customer",
    requestId: randomUUID(),
  });
}
const tag = Date.now().toString(36);
await review(5, "Keeper " + tag);
await review(1, "Spam " + tag);

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
  await page.getByRole("link", { name: "Reviews" }).first().click();
  await page.waitForURL("**/workspace/reviews");
  await page.getByText("Keeper " + tag).waitFor();
  check(
    "pending reviews are listed, newest first",
    (await page.locator("article").first().innerText()).includes("Spam " + tag),
  );
  check("verified flag shown", await page.getByText("Verified order").first().isVisible());
  check(
    "tab shows the pending count",
    /Pending\s*2/.test(await page.getByRole("tab", { name: /Pending/ }).innerText()),
  );
  await page.screenshot({ path: out + "reviews-pending.png", fullPage: true });
  const keeper = page.locator("article", { hasText: "Keeper " + tag });
  await keeper.getByRole("button", { name: "Approve" }).click();
  await page.locator("article", { hasText: "Keeper " + tag }).waitFor({ state: "detached" });
  check("approved review leaves the Pending tab", true);
  // The card leaves as the list reloads; the average follows with the same read.
  check(
    "published average updates",
    await page
      .locator("header p.muted", { hasText: "5.0 average from 1 published" })
      .first()
      .waitFor({ timeout: 10000 })
      .then(
        () => true,
        () => false,
      ),
  );
  await page
    .locator("article", { hasText: "Spam " + tag })
    .getByRole("button", { name: "Reject" })
    .click();
  await page.getByText("No reviews waiting").waitFor();
  check("empty Pending tab says so", true);
  await page.getByRole("tab", { name: /Approved/ }).click();
  const approved = page.locator("article", { hasText: "Keeper " + tag });
  await approved.waitFor();
  check(
    "approved review offers Hide (reject)",
    await approved.getByRole("button", { name: "Hide (reject)" }).isVisible(),
  );
  await page.getByRole("tab", { name: /Rejected/ }).click();
  await page.locator("article", { hasText: "Spam " + tag }).waitFor();
  check("rejected review is under Rejected", true);
  await page.getByLabel("Rating").selectOption("5");
  await page.getByText("No reviews here").waitFor();
  check("a filter with no match says so", true);
  await page.screenshot({ path: out + "reviews-rejected.png", fullPage: true });
  const statuses = await pool.query(
    "SELECT title, status FROM reviews WHERE title LIKE $1 ORDER BY title",
    ["%" + tag],
  );
  check(
    "database matches the decisions",
    JSON.stringify(statuses.rows) ===
      JSON.stringify([
        { title: "Keeper " + tag, status: "approved" },
        { title: "Spam " + tag, status: "rejected" },
      ]),
    JSON.stringify(statuses.rows),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: /Approved/ }).click();
  await page.locator("article").first().waitFor();
  check(
    "no horizontal scroll at 390px",
    !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
  );
  await page.screenshot({ path: out + "reviews-390.png", fullPage: true });
  check("no page errors", errors.length === 0, errors.join("; "));

  const staff = await session("staff.qa@iqoshaven.test");
  check(
    "staff see no Reviews link",
    (await staff.page.getByRole("link", { name: "Reviews" }).count()) === 0,
  );
  await staff.page.goto(BASE + "/workspace/reviews");
  await staff.page.getByText("Access unavailable").waitFor();
  check("staff cannot open Reviews", true);
} finally {
  await browser.close();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
