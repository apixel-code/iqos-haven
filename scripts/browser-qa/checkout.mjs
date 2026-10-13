// Browser pass of the storefront checkout form (step 80) against the real stack.
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open   (prints SERVING, COOKIE, VARIANT, SCHEMA)
//   QA_PLAYWRIGHT_DIR=<dir with playwright-core> node scripts/browser-qa/checkout.mjs <SERVING> <COOKIE> <shots dir> <VARIANT>
// Afterwards stop the served stack and drop its schema.
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");

const [base, cookie, shots, variant] = process.argv.slice(2);
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
const [name, value] = cookie.split("=");
await context.addCookies([
  { name, value, url: base, httpOnly: true, secure: true, sameSite: "Lax" },
]);
const page = await context.newPage();
const storage = () =>
  page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
const PII = ["Synthetic", "501234567", "Probe Tower", "2408", "Gate code"];
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

// One unit in the device cart, as the product page would store it.
await page.goto(base + "/cart");
await page.evaluate((variantId) => {
  localStorage.setItem(
    "ih_cart_v1",
    JSON.stringify({
      v: 1,
      lines: [
        {
          variantId,
          productSlug: "gatecheck-halo",
          quantity: 1,
          snapshot: { name: "Gatecheck", brand: "Gatebrand", options: "", priceFils: 4900 },
        },
      ],
    }),
  );
}, variant);
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

const fill = async () => {
  await page.getByLabel("Full name").fill("Synthetic Buyer");
  await page.getByLabel("Mobile number").fill("50 123 4567");
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
await page.getByLabel("Delivery area").selectOption({ index: 1 });
await page.getByText("Total", { exact: true }).waitFor({ timeout: 10000 });
await fill();
await page.getByRole("button", { name: /^Place order · AED/ }).click();
await page.getByRole("heading", { name: "Order placed" }).waitFor({ timeout: 15000 });
const placedText = await page.locator("section").filter({ hasText: "Order placed" }).innerText();
check(/IH-\d{6}/.test(placedText), "the retry is answered with the order number", placedText);
check(
  orderPosts.length === 2 && orderPosts[1] === stored.key,
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
await page.screenshot({ path: join(shots, "checkout-placed-360.png"), fullPage: true });

// Desktop layout.
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(base + "/checkout");
await page.getByRole("heading", { name: "Your cart is empty" }).waitFor();
check(true, "checkout with an empty cart says so");
await page.screenshot({ path: join(shots, "checkout-empty-1280.png") });
await browser.close();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
