// Browser pass of the storefront cart sheet (parity G-S1, ADR 0082) against the real served
// stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   (SERVING)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/cart-sheet.mjs <SERVING> [<SHOTS_DIR>]
// Adds from the product page and from quick add at 360px and 1280px, and checks what the sheet
// shows, its controls, focus, closing, and its place on the screen.
import { createRequire } from "node:module";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");
const [base, shots = join(process.env.QA_PLAYWRIGHT_DIR ?? ".", "shots")] = process.argv.slice(2);
if (!/^https?:\/\//.test(base ?? "")) throw new Error("usage: <SERVING> [<SHOTS_DIR>]");
mkdirSync(shots, { recursive: true });
let failed = 0;
const check = (ok, name, detail = "") => {
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
const sheetOf = (page) => page.getByRole("dialog", { name: /Your cart/ });
const cartQuantity = (page) =>
  page.evaluate(() =>
    (JSON.parse(localStorage.getItem("ih_cart_v1") ?? "{}").lines ?? []).reduce(
      (sum, line) => sum + line.quantity,
      0,
    ),
  );
async function addFromProductPage(page) {
  await page.goto(base + "/p/gatecheck-halo");
  await page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await sheetOf(page).waitFor({ timeout: 10000 });
}

try {
  // 1. Phone: the sheet after adding, its controls and its way on.
  const phone = await shopper({ width: 360, height: 780 });
  const { page } = phone;
  await addFromProductPage(page);
  const sheet = sheetOf(page);
  await sheet.getByText(/Subtotal \(1 item\)/).waitFor({ timeout: 10000 });
  const text = await sheet.innerText();
  check(
    /AED/.test(text) && /View cart and checkout/.test(text),
    "the sheet shows the line, subtotal and the way on",
    text.slice(0, 300),
  );
  check(
    await page.evaluate(() => document.activeElement?.closest("dialog") !== null),
    "focus moves into the sheet",
  );
  const box = await sheet.boundingBox();
  check(
    box && Math.round(box.y + box.height) === 780 && Math.round(box.width) === 360,
    "on a phone the sheet is a full-width bottom sheet",
    JSON.stringify(box),
  );
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "no sideways scrolling at 360px",
  );
  await page.screenshot({ path: join(shots, "cart-sheet-360.png") });
  await sheet.getByRole("button", { name: "Increase" }).click();
  await sheet.getByText(/Subtotal \(2 items\)/).waitFor();
  check((await cartQuantity(page)) === 2, "the quantity control changes the device cart");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  check(true, "Escape closes the sheet");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await sheet.waitFor();
  await sheet.getByRole("button", { name: "Continue shopping" }).click();
  await sheet.waitFor({ state: "hidden" });
  check(page.url().includes("/p/gatecheck-halo"), "Continue shopping stays on the page");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await sheet.getByRole("link", { name: "View cart and checkout" }).click();
  await page.waitForURL(/\/cart$/);
  await page.getByRole("complementary", { name: "Order summary" }).waitFor();
  check(
    !(await sheet.isVisible()),
    "View cart and checkout opens the cart page with the sheet closed",
  );
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();

  // 2. Wide screen: quick add, side panel, removing the last line.
  const wide = await shopper({ width: 1280, height: 800 });
  await wide.page.goto(base + "/shop");
  await wide.page
    .getByRole("button", { name: /^Quick add/ })
    .first()
    .click();
  const quick = wide.page.getByRole("dialog", { name: "Quick add" });
  await quick.waitFor();
  const choice = quick.locator("label", { hasText: /^grape/ });
  if (await choice.count()) await choice.first().click();
  await quick.getByRole("button", { name: "Add to cart" }).click();
  const side = sheetOf(wide.page);
  await side.waitFor();
  check(!(await quick.isVisible()), "quick add closes and hands over to the cart sheet");
  const panel = await side.boundingBox();
  check(
    panel && Math.round(panel.x + panel.width) === 1280 && Math.round(panel.height) === 800,
    "on a wide screen the sheet is a full-height side panel",
    JSON.stringify(panel),
  );
  await wide.page.screenshot({ path: join(shots, "cart-sheet-1280.png") });
  await side.getByRole("button", { name: /^Remove/ }).click();
  await side.getByText("Your cart is empty").waitFor();
  check((await cartQuantity(wide.page)) === 0, "removing the last line empties the cart");
  await wide.page.mouse.click(100, 400);
  await side.waitFor({ state: "hidden" });
  check(true, "a click outside the panel closes it");
  check(wide.errors.length === 0, "no page errors on a wide screen", wide.errors.join("; "));
  await wide.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
