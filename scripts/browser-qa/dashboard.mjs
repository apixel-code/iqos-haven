// Browser pass of the admin home dashboard (step 108) and the Owner's analytics (step 109)
// through the real gateway, on the schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/dashboard.mjs <SCHEMA>
// Orders and browsing events are seeded with the real database helpers and today is rolled up,
// so every figure on screen comes from the API.
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
const { createDatabase, createPool, rollupDay } = fromApi("@ih/db");
const { seedOrder } = fromApi("@ih/db/testing");
const { dubaiDate } = fromApi("@ih/domain");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-dashboard",
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

await seedOrder(pool);
await seedOrder(pool, { status: "confirmed", quantity: 2 });
const event = (type, payload) =>
  pool.query("INSERT INTO events (id, type, payload) VALUES ($1, $2, $3)", [
    randomUUID(),
    type,
    JSON.stringify(payload),
  ]);
await event("search", { term: "mango ice", resultCount: 0 });
await event("search", { term: "grape", resultCount: 4 });
await rollupDay(db, dubaiDate(new Date()));
// What the screen must show: today's booked orders on this schema (the pass can run again).
const booked = (
  await db.salesDaily.findUniqueOrThrow({ where: { day: new Date(dubaiDate(new Date())) } })
).bookedOrders;

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
const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
try {
  const owner = await session("owner.qa@iqoshaven.test");
  const { page } = owner;
  await page.goto(BASE + "/");
  await page.getByText("Today’s orders").waitFor();
  const home = await page.locator("main").innerText();
  check("home shows open order counts", /Pending\s+\d+/.test(home), home.slice(0, 300));
  check("home names the pending orders to confirm", /pending to confirm/.test(home));
  check("Owner sees booked sales with freshness", /Booked sales[\s\S]*As of /.test(home));
  check("recent orders are listed", (await page.getByText(/IH-\d{6,}/).count()) >= 2);
  await page.screenshot({ path: out + "dashboard-owner.png", fullPage: true });

  await page.goto(BASE + "/workspace/analytics");
  await page.getByText("Booked sales per day").waitFor();
  const overview = await page.locator("main").innerText();
  check(
    "analytics overview shows booked orders",
    new RegExp(`Booked orders\\s+${booked}\\b`).test(overview),
    overview.slice(0, 400),
  );
  check("analytics names the tax basis", overview.includes("no separate VAT"));
  check(
    "the daily chart has one column per computed day",
    (await page.locator(".chart-bar").count()) >= 1,
  );
  await page.locator(".column-chart g[tabindex]").last().focus();
  check(
    "focusing a column reads out its value",
    /AED/.test(await page.locator(".column-chart figcaption").first().innerText()),
  );
  await page.screenshot({ path: out + "analytics-overview.png", fullPage: true });
  await page.getByRole("tab", { name: "Search" }).click();
  await page.getByText("Searches with no results").waitFor();
  check(
    "search tab lists the no-result term",
    (await page.locator("main").innerText()).includes("“mango ice”"),
  );
  await page.getByRole("tab", { name: "Products & brands" }).click();
  await page.getByText("Best-selling brands").waitFor();
  await page.getByRole("tab", { name: "Sales" }).click();
  await page.getByText("Per day").waitFor();
  await page.getByRole("button", { name: "Last 7 days" }).click();
  await page.getByText(/days are not computed yet/).waitFor();
  check("days not computed are named, not drawn as zero", true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "Overview" }).click();
  await page.getByText("Booked sales per day").waitFor();
  check("analytics fits 390px without sideways scrolling", await noSideScroll(page));
  await page.screenshot({ path: out + "analytics-390.png", fullPage: true });
  await page.goto(BASE + "/");
  await page.getByText("Today’s orders").waitFor();
  check("home fits 390px without sideways scrolling", await noSideScroll(page));
  await page.screenshot({ path: out + "dashboard-390.png", fullPage: true });
  // The Notifications nav item opens the inbox, not a placeholder (step 115).
  await page.goto(BASE + "/workspace/notifications");
  await page
    .getByText(/No notifications yet|Mark read|unread/)
    .first()
    .waitFor();
  const inbox = await page.locator("main").innerText();
  check("Notifications opens the inbox", !/being prepared/.test(inbox), inbox.slice(0, 200));
  check("the inbox fits 390px without sideways scrolling", await noSideScroll(page));
  check("no page errors for the Owner", owner.errors.length === 0, owner.errors.join("; "));

  const staff = await session("staff.qa@iqoshaven.test");
  await staff.page.goto(BASE + "/");
  await staff.page.getByText("Today’s orders").waitFor();
  const staffHome = await staff.page.locator("main").innerText();
  check("Staff see the operational counts", /Out for delivery/.test(staffHome));
  check("Staff see no sales figures", !staffHome.includes("Booked sales"));
  check(
    "Staff see no Analytics link",
    (await staff.page.getByRole("link", { name: "Analytics" }).count()) === 0,
  );
  await staff.page.screenshot({ path: out + "dashboard-staff.png", fullPage: true });
  await staff.page.goto(BASE + "/workspace/analytics");
  await staff.page.getByText("Access unavailable").waitFor();
  check("Staff cannot open Analytics", true);
  check("no page errors for Staff", staff.errors.length === 0, staff.errors.join("; "));
} finally {
  await browser.close();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
