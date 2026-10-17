// Browser pass of the whole shopper journey (steps 80-82, M7 gate) against the real stack:
// age check -> product -> variant -> cart -> quote -> order -> private confirmation, with a lost
// answer, a reload, an already-placed attempt, a changed total and a sold-out line on the way.
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open   (prints SERVING, VARIANT, SCHEMA)
//   QA_PLAYWRIGHT_DIR=<dir with playwright-core> node scripts/browser-qa/checkout.mjs <SERVING> <shots dir> <VARIANT> <SCHEMA>
// The database is changed mid-journey through `docker exec` psql (QA_PSQL overrides the command).
// Afterwards stop the served stack and drop its schema.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");

const [base, shots, variant, schema] = process.argv.slice(2);
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? ""))
  throw new Error("usage: <SERVING> <shots> <VARIANT> <SCHEMA>");
const PSQL = (
  process.env.QA_PSQL ?? "docker exec -i iqos-haven-postgres-1 psql -U ih_owner -d iqos_haven_test"
).split(" ");
/** One statement in the served stack's schema; returns the first value. */
const sql = (statement) =>
  execFileSync(
    PSQL[0],
    [
      ...PSQL.slice(1),
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `SET search_path TO "${schema}"; ${statement}`,
    ],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n")
    .pop();
const orders = () => Number(sql("SELECT count(*) FROM orders"));
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).find((name) => /^chromium-\d+$/.test(name));
const sub = readdirSync(join(cache, dir)).find((name) => name.startsWith("chrome-"));
const executablePath = join(
  cache,
  dir,
  sub,
  "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
let passed = 0;
let failed = 0;
const check = (ok, name, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
};
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
const page = await context.newPage();
const storage = () =>
  page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
const PII = ["Synthetic", "501234567", "501234568", "Probe Tower", "2408", "Gate code"];
const noPii = async (label) => {
  const text = JSON.stringify(await storage());
  check(
    !PII.some((item) => text.includes(item)),
    `${label}: nothing typed is in device storage`,
    text.slice(0, 300),
  );
};
const orderPosts = [];
page.on("request", (request) => {
  if (request.method() === "POST" && request.url().endsWith("/api/v1/store/orders"))
    orderPosts.push(request.headers()["idempotency-key"]);
});

// Age check: without a ticket the product address shows the question and nothing of the product.
// The gate redirects to the storefront's configured https origin, which this local pass
// cannot open, so the redirect is read and the same path is opened on the served address.
const gate = await context.request.get(base + "/p/gatecheck-halo", { maxRedirects: 0 });
const asked = new URL(gate.headers().location ?? "", base);
check(
  gate.status() === 307 && asked.pathname === "/age-check",
  "an unverified shopper is sent to the age check",
  `${gate.status()} ${gate.headers().location}`,
);
await page.goto(base + asked.pathname + asked.search);
check(!(await page.content()).includes("Gatecheck"), "the age check shows nothing of the product");
await page.locator('form[action="/api/age/accept"] button').waitFor();
// The served storefront accepts the answer only from its own https origin, which this local
// http pass does not have: the form's post is sent with that Origin instead of clicking it.
// (The button itself is covered by the gate script and the step-56 tests.)
const answer = await context.request.post(base + "/api/age/accept", {
  headers: { origin: "https://shop.gate-check.test" },
  form: { return: "/p/gatecheck-halo" },
  maxRedirects: 0,
});
check(
  answer.status() === 303 && answer.headers().location === "/p/gatecheck-halo",
  "accepting returns the shopper to the product",
  `${answer.status()} ${answer.headers().location}`,
);
await page.goto(base + "/p/gatecheck-halo");
// Product and variant: nothing is preselected; the shopper picks one and adds it.
await page.getByRole("heading", { name: "Gatecheck Halo" }).waitFor();
await page
  .locator("label", { hasText: /^grape/ })
  .first()
  .click();
await page.getByRole("button", { name: "Add to cart" }).click();
await page.waitForFunction(() => (localStorage.getItem("ih_cart_v1") ?? "").includes("variantId"));
check(
  (await storage()).local.ih_cart_v1.includes(variant),
  "the chosen variant is in the device cart",
);
await page.goto(base + "/cart");
await page.getByLabel("Delivery area").selectOption({ index: 1 });
await page.getByText("Total", { exact: true }).waitFor();
const link = page.getByRole("link", { name: "Checkout · Cash on delivery" });
await link.waitFor({ timeout: 10000 });
check(true, "cart page offers checkout once the total is accepted");
await link.click();
await page.waitForURL("**/checkout");
await page.getByRole("heading", { name: "Contact" }).waitFor();
// The area chosen on the cart page came along in memory.
await page.getByText("Total", { exact: true }).waitFor({ timeout: 10000 });
check(
  (await page.getByLabel("Delivery area").inputValue()) !== "",
  "the chosen area is carried to checkout",
);
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > window.innerWidth,
);
check(!overflow, "no horizontal scroll at 360px");
await page.screenshot({ path: join(shots, "checkout-360.png"), fullPage: true });

// Empty submit: every message at once, nothing sent.
await page.getByRole("button", { name: /^Place order/ }).click();
const summary = page.getByRole("alert").filter({ hasText: "Please fix" });
await summary.waitFor();
const summaryText = await summary.innerText();
check(
  [
    "Enter your full name",
    "Enter your mobile number",
    "Enter your building name",
    "Enter your apartment number",
    "Confirm you are 18 or older",
  ].every((m) => summaryText.includes(m)) && summaryText.includes("5 things"),
  "an empty form shows all five problems",
  summaryText,
);
check(orderPosts.length === 0, "an invalid form sends nothing");
await page.screenshot({ path: join(shots, "checkout-errors-360.png"), fullPage: true });

// Order attempts are limited per phone (five a minute): each journey uses its own number.
const fill = async (mobile = "50 123 4567") => {
  await page.getByLabel("Full name").fill("Synthetic Buyer");
  await page.getByLabel("Mobile number").fill(mobile);
  await page.getByLabel("Building name").fill("Probe Tower");
  await page.getByLabel("Apartment no.").fill("2408");
  await page.getByLabel(/Delivery notes/).fill("Gate code 1");
  await page.getByLabel("I confirm I am 18 or older.").check();
};
await fill();
await noPii("after typing");
check(
  (await storage()).local.ih_checkout_attempt_v1 === undefined,
  "no attempt key before the first attempt",
);

// A lost answer: the request reaches the shop but the answer never arrives.
await page.route("**/api/v1/store/orders", async (route) => {
  await route.fetch().catch(() => null);
  await route.abort("connectionreset");
});
await page.getByRole("button", { name: /^Place order/ }).click();
await page.getByText("Pressing again will not order twice.").waitFor({ timeout: 15000 });
check(true, "a lost answer says pressing again is safe");
const stored = JSON.parse((await storage()).local.ih_checkout_attempt_v1 ?? "null");
check(
  stored && Object.keys(stored).sort().join() === "createdAt,key" && stored.key === orderPosts[0],
  "the device keeps only the attempt key and its time",
  JSON.stringify(stored),
);
await noPii("after a lost answer");
check(
  (await storage()).local.ih_cart_v1?.includes("variantId"),
  "the cart is kept while the outcome is unknown",
);
await page.unroute("**/api/v1/store/orders");

// Refresh: the form is empty again (memory only), the key survives.
await page.reload();
await page.getByRole("heading", { name: "Contact" }).waitFor();
check(
  (await page.getByLabel("Full name").inputValue()) === "",
  "a refresh forgets the typed details",
);
check(
  JSON.parse((await storage()).local.ih_checkout_attempt_v1).key === stored.key,
  "the attempt key survives a refresh",
);
check(orders() === 1, "the lost answer did place the order (one row)");
// Different details with the same key: the shop says an order exists and places nothing.
await page.getByLabel("Delivery area").selectOption({ index: 1 });
await page.getByText("Total", { exact: true }).waitFor({ timeout: 10000 });
await fill();
await page.getByLabel("Full name").fill("Synthetic Buyer Two");
await page.getByRole("button", { name: /^Place order · AED/ }).click();
await page
  .getByRole("heading", { name: "This order was already placed" })
  .waitFor({ timeout: 15000 });
check(orders() === 1, "a changed form with the same key places nothing");
check(
  JSON.parse((await storage()).local.ih_checkout_attempt_v1).key === stored.key,
  "the key is kept on the already-placed screen",
);
check(
  (await storage()).local.ih_cart_v1?.includes("variantId"),
  "the cart is kept on the already-placed screen",
);
await page.screenshot({ path: join(shots, "checkout-already-placed-360.png"), fullPage: true });
// The same details as the first time: the first order is answered again.
await page.reload();
await page.getByRole("heading", { name: "Contact" }).waitFor();
await page.getByLabel("Delivery area").selectOption({ index: 1 });
await page.getByText("Total", { exact: true }).waitFor({ timeout: 10000 });
await fill();
await page.getByRole("button", { name: /^Place order · AED/ }).click();
await page.waitForURL("**/order-confirmation", { timeout: 15000 });
await page.getByRole("heading", { name: "Order placed. Thank you." }).waitFor({ timeout: 15000 });
const placedText = await page.locator("main").innerText();
check(
  /IH-\d{6}/.test(placedText),
  "the retry is answered with the order number",
  placedText.slice(0, 200),
);
check(
  orderPosts.length === 3 && orderPosts.every((sent) => sent === stored.key),
  "the retry used the same key",
  orderPosts.join(" "),
);
const after = await storage();
check(
  after.local.ih_checkout_attempt_v1 === undefined,
  "the attempt ends after the acknowledgement",
);
check(
  !after.local.ih_cart_v1?.includes("variantId"),
  "the cart is emptied after the acknowledgement",
  after.local.ih_cart_v1,
);
await noPii("after the order");
const cookies = await context.cookies(base);
const confirmation = cookies.find((item) => item.name === "__Host-ih_order");
check(
  !!confirmation && confirmation.httpOnly && confirmation.secure,
  "the confirmation cookie is set, HttpOnly and Secure",
);
check(
  !page.url().includes("?") && !page.url().includes("#"),
  "nothing is put in the URL",
  page.url(),
);
// The confirmation page (step 81): the API's snapshot, read with the cookie.
check(
  ["Pay in cash on delivery", "AED 64", "What happens next", "Probe Tower", "Total to pay"].every(
    (text) => placedText.includes(text),
  ),
  "the confirmation shows the total, the next steps and the delivery address",
  placedText.slice(0, 400),
);
check(
  !["Synthetic Buyer", "501234567", "Gate code"].some((text) => placedText.includes(text)),
  "the confirmation shows no name, phone or delivery note",
);
check(
  !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
  "confirmation: no horizontal scroll at 360px",
);
const foreign = await page.evaluate(() =>
  [...document.querySelectorAll("script[src],iframe[src]")]
    .map((node) => node.src)
    .filter((src) => new URL(src).origin !== location.origin),
);
check(
  foreign.length === 0,
  "the confirmation loads no script from another origin",
  foreign.join(" "),
);
await page.screenshot({ path: join(shots, "confirmation-360.png"), fullPage: true });
await page.reload();
await page.getByRole("heading", { name: "Order placed. Thank you." }).waitFor({ timeout: 15000 });
check(true, "a reload shows the order again while the cookie is valid");
await page.goBack();
await page.waitForLoadState("domcontentloaded");
check(!page.url().endsWith("/checkout"), "Back does not return to the checkout form", page.url());
// Without the cookie (expired, or another device) the page says so and shows nothing.
await context.clearCookies({ name: "__Host-ih_order" });
await page.goto(base + "/order-confirmation");
await page
  .getByRole("heading", { name: "This order can't be shown here" })
  .waitFor({ timeout: 15000 });
const expiredText = await page.locator("main").innerText();
check(
  !/IH-\d{6}|Probe Tower|AED 64/.test(expiredText),
  "without the cookie no order detail is shown",
);
await page.screenshot({ path: join(shots, "confirmation-expired-360.png"), fullPage: true });

// Second journey: the price moves and the stock runs out while the shopper is at checkout.
await page.goto(base + "/p/gatecheck-halo");
await page
  .locator("label", { hasText: /^grape/ })
  .first()
  .click();
await page.getByRole("button", { name: "Add to cart" }).click();
await page.waitForFunction(() => (localStorage.getItem("ih_cart_v1") ?? "").includes("variantId"));
await page.goto(base + "/checkout");
await page.getByRole("heading", { name: "Contact" }).waitFor();
await page.getByLabel("Delivery area").selectOption({ index: 1 });
await page.getByRole("button", { name: "Place order · AED 64" }).waitFor({ timeout: 10000 });
await fill("50 123 4568");
const productId = sql(`SELECT product_id FROM variants WHERE id='${variant}'`);
const priced = sql(`SELECT base_price_fils FROM products WHERE id='${productId}'`);
sql(
  `UPDATE products SET base_price_fils=${Number(priced) + 200}, version=version+1 WHERE id='${productId}'`,
);
await page.getByRole("button", { name: "Place order · AED 64" }).click();
await page.getByText("Your total changed. Check the new total").waitFor({ timeout: 15000 });
const accept = page.getByRole("button", { name: "Accept new total" });
await accept.waitFor({ timeout: 10000 });
check(orders() === 1, "an order at the old total is refused");
check(
  (await page.locator("main").innerText()).includes("AED 64 to AED 66"),
  "the shopper is shown the old and the new total",
);
check(
  (await page.getByRole("button", { name: /^Place order/ }).innerText()) === "Place order",
  "the button names no total until the new one is accepted",
);
await page.screenshot({ path: join(shots, "checkout-total-changed-360.png"), fullPage: true });
await accept.click();
await page.getByRole("button", { name: "Place order · AED 66" }).waitFor({ timeout: 10000 });
// Someone else buys the rest before the button is pressed.
const stock = Number(sql(`SELECT stock_on_hand FROM variants WHERE id='${variant}'`));
sql(
  `INSERT INTO stock_movements (variant_id, delta, balance_after, reason, note, command_id) VALUES ('${variant}', ${-stock}, 0, 'DAMAGE', 'QA journey', gen_random_uuid())`,
);
await page.getByRole("button", { name: "Place order · AED 66" }).click();
await page.getByText("Something in your cart just sold out.").waitFor({ timeout: 15000 });
check(orders() === 1, "a sold-out line is not ordered");
check(
  (await storage()).local.ih_cart_v1?.includes("variantId"),
  "the cart is kept when nothing was placed",
);
await page.screenshot({ path: join(shots, "checkout-sold-out-360.png"), fullPage: true });
// Back in stock: the same attempt key was never used for an order, so it places this one.
sql(
  `INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id) VALUES ('${variant}', 3, 3, 'RESTOCK', gen_random_uuid())`,
);
await page.reload();
await page.getByRole("heading", { name: "Contact" }).waitFor();
await page.getByLabel("Delivery area").selectOption({ index: 1 });
await page.getByRole("button", { name: "Place order · AED 66" }).waitFor({ timeout: 10000 });
await fill("50 123 4568");
await page.getByRole("button", { name: "Place order · AED 66" }).click();
await page.waitForURL("**/order-confirmation", { timeout: 15000 });
await page.getByRole("heading", { name: "Order placed. Thank you." }).waitFor({ timeout: 15000 });
check(
  (await page.locator("main").innerText()).includes("AED 66"),
  "the second order is placed at the accepted new total",
);
check(orders() === 2, "two journeys made exactly two orders");
check(
  Number(sql(`SELECT stock_on_hand FROM variants WHERE id='${variant}'`)) === 2,
  "stock went down by exactly the one unit sold",
);
check(
  sql("SELECT string_agg(total_fils::text, ',' ORDER BY order_number) FROM orders") === "6400,6600",
  "each order is stored at the total its shopper accepted",
);

// Worker effects: the served stack runs the worker's relay, queue and consumers, so both
// orders placed above reach the staff inbox and their email effect is completed. Every consumer
// of `order.created` (inbox, email and, since step 107, the analytics rollup) must complete.
let done = false;
for (let i = 0; i < 60 && !done; i++) {
  done =
    sql(
      "SELECT string_agg(e.consumer || ':' || e.status, ',' ORDER BY e.consumer, e.event_id) FROM consumer_effects e JOIN outbox_events o ON o.id=e.event_id WHERE o.event_type='order.created'",
    ) ===
    "analytics_rollup:completed,analytics_rollup:completed,email:completed,email:completed,notification:completed,notification:completed";
  if (!done) await new Promise((wait) => setTimeout(wait, 500));
}
check(done, "the worker completed the inbox and email effects of both orders");
check(
  sql(
    "SELECT count(*) || '/' || count(DISTINCT source_event_id) FROM notifications WHERE type='order.new'",
  ) === "2/2",
  "each order has exactly one inbox notification",
);
check(
  sql(
    "SELECT bool_and(n.title = 'New order IH-' || lpad(o.order_number::text, 6, '0')) FROM notifications n JOIN outbox_events e ON e.id=n.source_event_id JOIN orders o ON o.id::text=e.aggregate_id",
  ) === "t",
  "each notification names its own order",
);
const end = await storage();
check(
  Object.keys(end.session).length === 0 &&
    // The anonymous telemetry ID (step 104) is the only other key allowed.
    Object.keys(end.local).every((key) =>
      ["ih_cart_v1", "ih_lists_v1", "ih_anon_v1"].includes(key),
    ),
  "after checkout the device holds only the cart, the saved lists and the anonymous ID",
  JSON.stringify(Object.keys({ ...end.local, ...end.session })),
);

// Desktop layout.
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(base + "/checkout");
await page.getByRole("heading", { name: "Your cart is empty" }).waitFor();
check(true, "checkout with an empty cart says so");
await page.screenshot({ path: join(shots, "checkout-empty-1280.png") });
await browser.close();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
