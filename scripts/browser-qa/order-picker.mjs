// Browser pass of the order item picker and the returning-customer lookup (parity G-A1,
// ADR 0080) through the real gateway, on the schema served by qa-server.cjs (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/order-picker.mjs <SCHEMA>
// The catalogue, area and fee are seeded with the database client; both orders are created in
// the browser, so the second one finds the customer and the address the first one saved.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
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
const { createDatabase, createPool } = fromApi("@ih/db");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-order-picker",
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

// --- Seed: one published pod with two flavours in stock and one sold out, an area, the fee.
const tag = randomUUID().slice(0, 6);
const owner = await db.staffUser.findUniqueOrThrow({ where: { email: "owner.qa@iqoshaven.test" } });
const area = await db.deliveryArea.create({
  data: {
    code: "qa_marina_" + tag,
    name: "QA Marina " + tag,
    emirate: "dubai",
    active: true,
    updatedBy: owner.id,
  },
});
await db.setting.upsert({
  where: { key: "delivery" },
  create: {
    key: "delivery",
    value: { flatFeeFils: 1500, etaText: "Today", freeThresholdFils: null },
    updatedBy: owner.id,
  },
  update: {},
});
const brand = await db.brand.create({
  data: { name: "Picker Brand " + tag, slug: "picker-brand-" + tag, active: true },
});
const category = await db.category.create({
  data: { name: "Picker Pods " + tag, slug: "picker-pods-" + tag, active: true },
});
const product = await db.product.create({
  data: {
    name: "Picker Pod " + tag,
    slug: "picker-pod-" + tag,
    brandId: brand.id,
    categoryId: category.id,
    type: "kit",
    basePriceFils: 4900n,
    status: "published",
  },
});
await db.productOption.create({
  data: { productId: product.id, name: "flavour", allowedValues: ["mint", "ice", "mango"] },
});
const variant = (flavour, stock) =>
  db.variant
    .create({
      data: {
        productId: product.id,
        sku: `QA-${flavour}-${tag}`.toUpperCase(),
        attributes: { flavour },
        active: true,
      },
    })
    .then(async (row) => {
      if (stock)
        await pool.query(
          "INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ($1, $2, $2, 'INITIAL_STOCK', $3)",
          [row.id, stock, randomUUID()],
        );
      return row;
    });
const mint = await variant("mint", 10);
const ice = await variant("ice", 10);
await variant("mango", 0);
const phone = "50" + String(Math.floor(1_000_000 + Math.random() * 8_999_999));

const browser = await chromium.launch({ executablePath, headless: true });
async function session(email, viewport = { width: 1366, height: 900 }) {
  const context = await browser.newContext({ viewport });
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
const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const picks = (page) => page.getByRole("list", { name: "Matching products" });

async function openNewOrder(page) {
  await page.goto(BASE + "/workspace/orders");
  await page.getByRole("button", { name: "Create order", exact: true }).click();
  await page.getByRole("heading", { name: "New order" }).waitFor();
}
async function pick(page, query, label) {
  await page.getByLabel("Search products").first().fill(query);
  await picks(page).getByRole("button", { name: label }).waitFor();
  await picks(page).getByRole("button", { name: label }).click();
}
async function createOrder(page) {
  await page.getByRole("button", { name: "Get total" }).click();
  await page.getByRole("button", { name: /Create order · AED/ }).waitFor();
  await page.getByLabel("The customer confirmed they are 18 or older.").check();
  await page.getByRole("button", { name: /Create order · AED/ }).click();
  try {
    // The new order's detail opens (its progress card, V-A3b).
    await page.locator(".prog").waitFor({ timeout: 15000 });
  } catch (error) {
    await page.screenshot({ path: out + "order-picker-failed.png", fullPage: true });
    throw error;
  }
}
const latestOrder = () =>
  one(
    `SELECT o.id, o.customer_name AS name, o.address_building AS building, o.area_id AS area,
       (SELECT json_agg(json_build_object('v', i.variant_id, 'q', i.quantity) ORDER BY i.sku)
        FROM order_items i WHERE i.order_id=o.id) AS items
     FROM orders o WHERE o.customer_phone_e164=$1 ORDER BY o.created_at DESC LIMIT 1`,
    ["+971" + phone],
  );

try {
  const staff = await session("staff.qa@iqoshaven.test");
  const { page } = staff;

  // 1. A new customer: the lookup says so, items come from the picker.
  await openNewOrder(page);
  check(
    "no typed variant ID field remains",
    (await page.getByLabel("Variant ID").count()) === 0 &&
      (await page.getByPlaceholder("UUID").count()) === 0,
  );
  await page.getByLabel("UAE mobile").fill(phone);
  await page.getByRole("button", { name: "Find customer by phone" }).click();
  await page.getByText(/New customer: no orders under/).waitFor();
  check("an unknown number is a new customer", true);
  await page.getByLabel("Full name").fill("Picker Customer");
  await page.getByLabel("Area").selectOption(area.id);
  await page.getByLabel("Building or villa").fill("Marina Tower 9");
  await page.getByLabel("Unit (not for a villa)").fill("1203");
  await page.getByLabel("Search products").fill("Picker Pod " + tag);
  await picks(page).getByText(/mango/).waitFor();
  const list = await picks(page).innerText();
  check(
    "the picker lists the product's flavours with SKU and price",
    /mint · QA-MINT/.test(list) && /AED/.test(list),
    list,
  );
  check(
    "a sold-out flavour is marked and cannot be added",
    /Sold out/.test(list) &&
      (await picks(page).getByRole("button", { name: /mango/ }).isDisabled()),
  );
  await page.getByLabel("Search products").fill(`qa-mint-${tag}`);
  await picks(page).getByText(/mango/).waitFor({ state: "detached" });
  check("SKU search finds one variant", (await picks(page).locator("li").count()) === 1);
  await picks(page).getByRole("button", { name: /mint/ }).click();
  check(
    "an added variant cannot be added twice",
    await picks(page).getByRole("button", { name: /mint/ }).isDisabled(),
  );
  await page.getByLabel(/Quantity of Picker Pod/).fill("2");
  await page.screenshot({ path: out + "order-picker-new.png", fullPage: true });
  await createOrder(page);
  const first = await latestOrder();
  check(
    "the order holds the picked variant and quantity",
    first?.items?.length === 1 && first.items[0].v === mint.id && first.items[0].q === 2,
    JSON.stringify(first),
  );

  // 2. The same number again: a returning customer with the saved address.
  await openNewOrder(page);
  await page.getByLabel("UAE mobile").fill("0" + phone);
  await page.getByRole("button", { name: "Find customer by phone" }).click();
  await page.getByText("Returning customer: Picker Customer").waitFor();
  check("a typed 0-prefixed number finds the returning customer", true);
  check(
    "the customer's name is filled in",
    (await page.getByLabel("Full name").inputValue()) === "Picker Customer",
  );
  await page.getByRole("button", { name: "Use this address" }).first().click();
  check(
    "the saved address fills area and building",
    (await page.getByLabel("Area").inputValue()) === area.id &&
      (await page.getByLabel("Building or villa").inputValue()) === "Marina Tower 9" &&
      (await page.getByLabel("Unit (not for a villa)").inputValue()) === "1203",
  );
  await pick(page, "Picker Brand " + tag, /Add .*ice/);
  await page.screenshot({ path: out + "order-picker-returning.png", fullPage: true });
  await createOrder(page);
  const second = await latestOrder();
  check(
    "the second order is the returning customer's, at the saved address",
    second.id !== first.id &&
      second.name === "Picker Customer" &&
      second.building === "Marina Tower 9" &&
      second.area === area.id &&
      second.items[0].v === ice.id,
    JSON.stringify(second),
  );
  check(
    "both orders belong to one customer",
    (
      await one(
        "SELECT count(DISTINCT customer_id)::int AS n FROM orders WHERE customer_phone_e164=$1",
        ["+971" + phone],
      )
    ).n === 1,
  );

  // 3. Order edit: add a variant from the picker instead of typing its ID.
  // The prototype's Edit button opens the edit drawer (V-A3b).
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "Edit order" });
  await edit.waitFor();
  check(
    "the edit has no typed variant ID field",
    (await edit.getByPlaceholder("UUID").count()) === 0,
  );
  await edit.getByLabel("Search products").fill(`qa-mint-${tag}`);
  await edit.getByRole("button", { name: /Add .*mint/ }).click();
  check(
    "a variant already in the order is not offered again",
    await (async () => {
      await edit.getByLabel("Search products").fill(`qa-ice-${tag}`);
      await edit.getByRole("list", { name: "Matching products" }).getByText(/ice/).waitFor();
      return edit.getByRole("button", { name: /Add .*ice/ }).isDisabled();
    })(),
  );
  await edit.getByRole("button", { name: "Save order edit" }).click();
  let edited = await latestOrder();
  for (let i = 0; i < 30 && edited.items.length < 2; i++) {
    await page.waitForTimeout(500);
    edited = await latestOrder();
  }
  await page.screenshot({ path: out + "order-picker-edited.png", fullPage: true });
  check(
    "the edit added the picked variant",
    edited.id === second.id &&
      edited.items.length === 2 &&
      edited.items.some((i) => i.v === mint.id),
    JSON.stringify(edited),
  );

  // 4. Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await openNewOrder(page);
  await page.getByLabel("Search products").fill("Picker Pod " + tag);
  await picks(page).getByText(/mango/).waitFor();
  check("the manual order fits 390px without sideways scrolling", await noSideScroll(page));
  await page.screenshot({ path: out + "order-picker-390.png", fullPage: true });
  check("no page errors", staff.errors.length === 0, staff.errors.join("; "));
} finally {
  await browser.close();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
