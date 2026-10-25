// Browser pass of the admin Settings and Delivery screens (V-A14, ADR 0097) through the real
// gateway, on the schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/settings.mjs <SCHEMA>
// The Owner saves the store and WhatsApp settings, adds a delivery area in the drawer, switches
// it off and renames it; every save is checked in the database as well as on screen.
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
  applicationName: "ih-qa-settings",
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
const tag = Date.now().toString(36);
async function until(read, test) {
  for (let i = 0; i < 40; i++) {
    const value = await read();
    if (test(value)) return value;
    await new Promise((done) => setTimeout(done, 250));
  }
  return read();
}
const setting = async (key) =>
  (await pool.query("SELECT value FROM settings WHERE key=$1", [key])).rows[0]?.value ?? null;
const area = async (code) =>
  (await pool.query("SELECT name, active FROM delivery_areas WHERE code=$1", [code])).rows[0];

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
  await page.goto(BASE + "/workspace/settings");
  await page.getByRole("tab", { name: "General" }).waitFor();

  // General: the store group saves with its version.
  const store = page.locator("section", { has: page.getByRole("heading", { name: "Store" }) });
  await store.getByLabel("Store name").fill("Iqos Haven " + tag);
  await store.getByLabel("Store domain").fill("shop.qa.test");
  await store.getByRole("button", { name: "Save store" }).click();
  const saved = await until(
    () => setting("store"),
    (value) => value?.name === "Iqos Haven " + tag,
  );
  check("the store settings save", saved?.name === "Iqos Haven " + tag, JSON.stringify(saved));
  await store.getByText("Configured").waitFor();
  check("the card says it is configured", true);
  check(
    "sign-in and security is shown",
    await page.getByRole("heading", { name: "Sign-in & security" }).isVisible(),
  );
  await page.screenshot({ path: out + "settings-general.png", fullPage: true });

  // Contact & WhatsApp: the number saves and can be tested with a wa.me link.
  await page.getByRole("tab", { name: "Contact & WhatsApp" }).click();
  const wa = page.locator("section", { has: page.getByRole("heading", { name: "WhatsApp" }) });
  await wa.getByLabel("WhatsApp number").fill("+971501234567");
  await wa.getByRole("button", { name: "Save whatsapp" }).click();
  const number = await until(
    () => setting("whatsapp"),
    (value) => value?.number === "+971501234567",
  );
  check("the WhatsApp number saves", number?.number === "+971501234567", JSON.stringify(number));
  const test = page.getByRole("link", { name: "Test the WhatsApp number" });
  await test.waitFor();
  check(
    "the test link opens wa.me with the number",
    (await test.getAttribute("href")) === "https://wa.me/971501234567",
  );

  // Payments: Cash on Delivery is the active method.
  await page.getByRole("tab", { name: "Payments" }).click();
  check(
    "Cash on Delivery is shown as active",
    (await page.locator(".set-pay", { hasText: "Cash on Delivery" }).innerText()).includes(
      "Active",
    ),
  );

  // Delivery inside Settings: add an area in the drawer, switch it off, rename it.
  await page.getByRole("tab", { name: "Delivery" }).click();
  await page.getByRole("heading", { name: "Delivery charge" }).waitFor();
  const code = "qa_" + tag;
  await page.getByRole("button", { name: "Add area" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Add area" });
  await drawer.getByLabel("Stable area code").fill(code);
  await drawer.getByLabel("Area name").fill("QA Area " + tag);
  await drawer.getByLabel("Approved and active").check();
  await drawer.getByRole("button", { name: "Add area" }).click();
  let row = await until(
    () => area(code),
    (value) => value?.active === true,
  );
  check("an area is added from the drawer", row?.active === true, JSON.stringify(row));
  const listed = page.locator(".del-row", { hasText: "QA Area " + tag });
  await listed.waitFor();
  await listed.getByLabel(`QA Area ${tag} active`).click();
  row = await until(
    () => area(code),
    (value) => value?.active === false,
  );
  check("the switch takes it off checkout", row?.active === false, JSON.stringify(row));
  check(
    "the toast says it is off",
    await page
      .getByText(`QA Area ${tag} is off at checkout`)
      .waitFor({ timeout: 5000 })
      .then(
        () => true,
        () => false,
      ),
  );
  await page
    .locator(".del-row", { hasText: "QA Area " + tag })
    .getByRole("button", { name: `Edit QA Area ${tag}` })
    .click();
  const edit = page.getByRole("dialog", { name: `Edit QA Area ${tag}` });
  await edit.getByLabel("Area name").fill("QA Renamed " + tag);
  await edit.getByRole("button", { name: "Save area" }).click();
  row = await until(
    () => area(code),
    (value) => value?.name === "QA Renamed " + tag,
  );
  check(
    "a rename keeps it off",
    row?.name === "QA Renamed " + tag && row.active === false,
    JSON.stringify(row),
  );
  await page.screenshot({ path: out + "settings-delivery.png", fullPage: true });
  check("no page errors on a wide screen", errors.length === 0, errors.join("; "));
  await context.close();

  const phone = await session({ width: 390, height: 844 });
  for (const path of ["/workspace/settings", "/workspace/delivery"]) {
    await phone.page.goto(BASE + path);
    await phone.page.waitForTimeout(1200);
    check(
      `no sideways scrolling at 390px: ${path}`,
      await phone.page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    );
  }
  await phone.page.screenshot({ path: out + "delivery-390.png", fullPage: true });
  check("no page errors on a phone", phone.errors.length === 0, phone.errors.join("; "));
  await phone.context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
