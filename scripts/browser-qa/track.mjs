// Browser QA for order tracking (ADR 0104): place an order through the real checkout, then find
// it on /track by its number alone, on a phone and on a wide screen.
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open   (prints SERVING)
//   QA_PLAYWRIGHT_DIR=<dir with playwright-core> node scripts/browser-qa/track.mjs <SERVING> [<shots dir>]
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");

const [base, shots = join(process.env.QA_PLAYWRIGHT_DIR ?? ".", "shots")] = process.argv.slice(2);
if (!base) throw new Error("usage: <SERVING> [<shots>]");
let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
};

const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).find((name) => /^chromium-\d+$/.test(name));
const sub = readdirSync(join(cache, dir)).find((name) => name.startsWith("chrome-"));
const browser = await chromium.launch({
  executablePath: join(
    cache,
    dir,
    sub,
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ),
  headless: true,
});

async function shopper(viewport) {
  const context = await browser.newContext({ viewport });
  await context.request.post(base + "/api/age/accept", {
    headers: { origin: "https://shop.gate-check.test" },
    form: { return: "/" },
    maxRedirects: 0,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

// Place one order through the checkout, as a shopper would.
const buyer = await shopper({ width: 1280, height: 900 });
{
  const { page } = buyer;
  await page.goto(base + "/p/gatecheck-halo");
  await page.getByRole("heading", { name: "Gatecheck Halo" }).waitFor();
  await page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.waitForFunction(() =>
    (localStorage.getItem("ih_cart_v1") ?? "").includes("variantId"),
  );
  await page.goto(base + "/checkout");
  await page.getByRole("heading", { name: "Contact" }).waitFor();
  await page.getByLabel("Delivery area").selectOption({ index: 1 });
  await page.getByLabel("Full name").fill("Tracking Buyer");
  await page.getByLabel("Mobile number").fill("050 777 1234");
  await page.getByLabel("Email").fill("tracking@example.com");
  await page.getByLabel("Building name").fill("Tracking Tower");
  await page.getByLabel("Apartment no.").fill("1701");
  await page.getByLabel("I confirm I am 18 or older.").check();
  await page.getByText("Total", { exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: /^Place order/ }).click();
  await page.waitForURL("**/order-confirmation", { timeout: 20000 });
  await page.getByRole("heading", { name: "Order placed. Thank you." }).waitFor();
}
const placedText = await buyer.page.locator("main").innerText();
const orderNumber = placedText.match(/IH-\d{12}/)?.[0];
check(Boolean(orderNumber), "the new order has a random 12-digit number", placedText.slice(0, 200));
check(
  (await buyer.page.getByRole("link", { name: "Track your order" }).count()) > 0,
  "the confirmation page links to tracking",
);
await buyer.context.close();

for (const viewport of [
  { width: 360, height: 780 },
  { width: 1280, height: 900 },
]) {
  const label = `${viewport.width}px`;
  const { context, page, errors } = await shopper(viewport);
  // Reached from the footer, like any shopper.
  await page.goto(base + "/");
  await page.locator("footer").getByRole("link", { name: "Track your order" }).click();
  await page.waitForURL("**/track");
  await page.getByRole("heading", { name: "Track your order" }).waitFor();
  const field = page.getByLabel("Order number");

  await field.fill("IH-100000000001");
  await page.getByRole("button", { name: "Track order" }).click();
  await page.getByText("We couldn't find an order with that number").waitFor();
  check(true, `${label}: an unknown number says it was not found`);

  // Typed with spaces, as read off an email.
  const digits = orderNumber.slice(3);
  await field.fill(`ih ${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`);
  await page.getByRole("button", { name: "Track order" }).click();
  await page.getByRole("heading", { name: /We have your order/ }).waitFor();
  const text = await page.locator("main").innerText();
  check(text.includes(orderNumber), `${label}: the order is found by its number`);
  check(/Order received[\s\S]*Confirmed[\s\S]*Delivered/.test(text), `${label}: the steps show`);
  check(text.includes("Gatecheck Halo"), `${label}: the items show`);
  check(/Total to pay in cash/.test(text), `${label}: the cash total shows`);
  // The random number may contain any digits, so it is taken out before looking.
  const rest = text.replaceAll(orderNumber, "");
  for (const secret of ["Tracking Buyer", "tracking@example.com", "Tracking Tower", "1701", "777"])
    check(!rest.includes(secret), `${label}: no "${secret}" on the page`);
  check(!page.url().includes(digits), `${label}: the number never enters the address bar`);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  check(!overflow, `${label}: no sideways scroll`);
  await page.screenshot({ path: join(shots, `track-${viewport.width}.png`), fullPage: true });
  check(errors.length === 0, `${label}: no page errors`, errors.join("; "));
  await context.close();
}

await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all tracking checks passed");
process.exit(failed ? 1 : 0);
