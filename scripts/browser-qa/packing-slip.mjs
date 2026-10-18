// Browser pass of the packing slip (parity G-A6, ADR 0090) through the real gateway, on the
// schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/packing-slip.mjs <SCHEMA>
import { createRequire } from "node:module";
import { mkdirSync, statSync } from "node:fs";
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
const { formatOrderNumber } = fromApi("@ih/domain");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-packing-slip",
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

const order = await seedOrder(pool, { quantity: 2 });
const number = formatOrderNumber(BigInt(order.orderNumber));
// An order delivered outside Dubai: the slip must name the order's own emirate. The snapshot is
// immutable, so only this fixture steps around the guard trigger.
await pool.query("ALTER TABLE orders DISABLE TRIGGER USER");
try {
  await pool.query("UPDATE orders SET area_emirate='sharjah' WHERE id=$1", [order.orderId]);
} finally {
  await pool.query("ALTER TABLE orders ENABLE TRIGGER USER");
}
const facts = (
  await pool.query(
    "SELECT customer_name AS name, area_name AS area, total_fils AS total FROM orders WHERE id=$1",
    [order.orderId],
  )
).rows[0];

const browser = await chromium.launch({ executablePath, headless: true });
async function session(email) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
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
  const { context, page, errors } = await session("owner.qa@iqoshaven.test");
  await page.goto(`${BASE}/workspace/orders?order=${order.orderId}`);
  await page.getByRole("button", { name: "Packing slip" }).click();
  const dialog = page.getByRole("dialog", { name: "Order summary" });
  await dialog.waitFor();
  const slip = await dialog.locator(".packing-slip").innerText();
  check(slip.includes(number), "the slip shows the order number");
  check(slip.includes(facts.name), "it shows the customer to deliver to");
  check(
    slip.includes(facts.area) && slip.includes("Sharjah"),
    "it names the order's area and emirate",
    slip,
  );
  check(!slip.includes("Dubai"), "it never assumes Dubai");
  check(
    /Seed product[\s\S]*2/.test(slip) && /SEED-/.test(slip),
    "it lists the item, quantity and SKU",
  );
  // The same formatting as the admin (Intl puts a no-break space after "AED").
  const total = new Intl.NumberFormat("en-AE", { style: "currency", currency: "AED" }).format(
    Number(facts.total) / 100,
  );
  check(
    slip.replace(/\s+/g, " ").includes(`Collect in cash ${total.replace(/\s+/g, " ")}`),
    "it says how much cash to collect",
    slip,
  );
  await page.screenshot({ path: out + "packing-slip-preview.png" });

  // Printing shows the slip and nothing else.
  await page.emulateMedia({ media: "print" });
  const shown = await page.evaluate(() => ({
    slip: getComputedStyle(document.querySelector(".packing-slip")).display,
    nav: getComputedStyle(document.querySelector("nav") ?? document.body).display,
    buttons: getComputedStyle(document.querySelector(".slip-chrome")).display,
  }));
  check(
    shown.slip !== "none" && shown.nav === "none" && shown.buttons === "none",
    "in print only the slip is laid out",
    JSON.stringify(shown),
  );
  const pdfPath = out + "packing-slip.pdf";
  const pdf = await page.pdf({ path: pdfPath, preferCSSPageSize: true });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check(pages === 1, "the slip prints on one A5 page", String(pages));
  check(statSync(pdfPath).size > 1000, "the printed file is not empty");
  await page.emulateMedia({ media: "screen" });
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "hidden" });
  check(errors.length === 0, "no page errors", errors.join("; "));
  await context.close();

  // Staff without customers.read see no slip (it would expose the address).
  const role = (await pool.query("SELECT id FROM roles WHERE key='staff'")).rows[0].id;
  await pool.query(
    "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id=$1 AND p.key='customers.read'",
    [role],
  );
  try {
    const staff = await session("staff.qa@iqoshaven.test");
    await staff.page.goto(`${BASE}/workspace/orders?order=${order.orderId}`);
    await staff.page.getByRole("heading", { name: number }).waitFor();
    check(
      (await staff.page.getByRole("button", { name: "Packing slip" }).count()) === 0,
      "without customers.read there is no packing slip",
    );
    await staff.context.close();
  } finally {
    await pool.query(
      "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key='customers.read' ON CONFLICT DO NOTHING",
      [role],
    );
  }
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
