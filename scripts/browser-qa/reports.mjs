// Browser pass of the admin Reports screen (steps 110–112) through the real gateway, on the
// schema served by qa-server.cjs (its worker loop builds file reports):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/reports.mjs <SCHEMA>
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { answerConfirm } from "./confirm.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const playwrightDir = process.env.QA_PLAYWRIGHT_DIR;
if (!playwrightDir) throw new Error("Set QA_PLAYWRIGHT_DIR (see scripts/browser-qa/README.md)");
const { chromium } = createRequire(resolve(playwrightDir, "package.json"))("playwright-core");
const schema = process.argv[2];
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? "")) throw new Error("usage: <SCHEMA>");
const fromApi = createRequire(root + "/apps/api/package.json");
const config = fromApi("@ih/config");
const { createDatabase, createPool, requestReport } = fromApi("@ih/db");
const { seedOrder } = fromApi("@ih/db/testing");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-reports",
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
const owner = await db.staffUser.findUniqueOrThrow({ where: { email: "owner.qa@iqoshaven.test" } });

const browser = await chromium.launch({ executablePath, headless: true });
async function session(email, viewport = { width: 1366, height: 900 }) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
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
async function downloadText(page, link) {
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), bytes: readFileSync(path) };
}
try {
  const { page, errors } = await session("owner.qa@iqoshaven.test");
  await page.goto(BASE + "/workspace/reports");
  // The prototype's report menu and the chosen report's card (V-A11).
  await page.getByRole("navigation", { name: "Reports" }).waitFor();
  await page.getByRole("heading", { name: "Sales" }).waitFor();
  check("Reports opens with the request form", true);
  await page.getByRole("button", { name: "Export CSV" }).click();
  await page.getByText("Ready: download it below within 15 minutes.").waitFor();
  check("a small sales report is ready at once", true);
  const first = page.getByRole("link", { name: "Download CSV" }).first();
  await first.waitFor();
  const sales = await downloadText(page, first);
  check(
    "the sales CSV downloads with a named file and a UTF-8 marker",
    /^iqos-haven-sales-booked-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/.test(sales.name) &&
      sales.bytes[0] === 0xef &&
      sales.bytes.toString("utf8").includes("Date (Dubai, order placed)"),
    sales.name,
  );

  // Personal data asks first; dismissing sends nothing.
  await page
    .getByRole("navigation", { name: "Reports" })
    .getByRole("button", { name: "Customers" })
    .click();
  const before = await db.reportJob.count();
  await page.getByRole("button", { name: "Export CSV" }).click();
  const asked = await page
    .getByRole("dialog", { name: "Export customer details?" })
    .waitFor({ timeout: 3000 })
    .then(
      () => 1,
      () => 0,
    );
  await answerConfirm(page, false);
  await page.waitForTimeout(500);
  check("customer data asks before requesting", asked === 1);
  check("dismissing it requests nothing", (await db.reportJob.count()) === before);
  await page.getByRole("button", { name: "Export CSV" }).click();
  await answerConfirm(page, true);
  await page.getByText("Ready: download it below within 15 minutes.").waitFor();
  // The list reloads after the answer: wait for the new row, not the first link.
  const customerRow = page.locator("tr", { hasText: "Customers" }).first();
  await customerRow.getByRole("link", { name: "Download CSV" }).waitFor();
  const customers = await downloadText(
    page,
    customerRow.getByRole("link", { name: "Download CSV" }),
  );
  check("the customers CSV downloads", customers.bytes.toString("utf8").includes("Phone"));

  // A large report is built by the worker: queued here as a file job for the Owner.
  const { job } = await requestReport(
    db,
    { requestId: randomUUID(), actorId: owner.id },
    { commandId: randomUUID(), report: { type: "inventory" } },
    { streamMaxRows: -1 },
  );
  await page.reload();
  await page.getByRole("heading", { name: "Your reports" }).waitFor();
  let built = false;
  for (let i = 0; i < 30 && !built; i++) {
    built =
      (await db.reportJob.findUniqueOrThrow({ where: { id: job.id } })).status === "completed";
    if (!built) await page.waitForTimeout(1000);
  }
  check("the worker builds the file job", built);
  // The screen looks again by itself while something is being built.
  await page
    .getByText(/Ready until/)
    .first()
    .waitFor({ timeout: 15000 });
  const row = page.locator("tr", { hasText: "Inventory" }).first();
  const file = await downloadText(page, row.getByRole("link", { name: "Download CSV" }));
  check(
    "the built file downloads through its signed link",
    file.name.startsWith("iqos-haven-inventory-as-of-") &&
      file.bytes.toString("utf8").includes("SKU"),
    file.name,
  );
  check(
    "each download was audited",
    (await db.auditLog.count({ where: { action: "report.downloaded" } })) >= 3,
  );
  await page.screenshot({ path: out + "reports.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  check(
    "Reports fits 390px without sideways scrolling",
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await page.screenshot({ path: out + "reports-390.png", fullPage: true });
  check("no page errors for the Owner", errors.length === 0, errors.join("; "));

  const staff = await session("staff.qa@iqoshaven.test");
  check(
    "Staff see no Reports link",
    (await staff.page.getByRole("link", { name: "Reports" }).count()) === 0,
  );
  await staff.page.goto(BASE + "/workspace/reports");
  await staff.page.getByText("Access unavailable").waitFor();
  check("Staff cannot open Reports", true);
  const guessed = await staff.page.request.get(`${BASE}/api/v1/admin/reports/${job.id}/download`, {
    maxRedirects: 0,
  });
  check(
    "Staff cannot download the Owner's file by its ID",
    guessed.status() === 403,
    String(guessed.status()),
  );
} finally {
  await browser.close();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
