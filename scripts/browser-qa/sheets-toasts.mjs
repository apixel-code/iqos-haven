// Browser pass of the prototype's sheets, toasts, cart-count bump and compare tray (V-S6a,
// ADR 0097; parity G-S10, G-S11) against the real served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve &   (SERVING)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/sheets-toasts.mjs <SERVING> [<SHOTS_DIR>]
// The gate stack has one buyable product (/p/gatecheck-halo, grape in stock) and no kit, so the
// compare tray is checked with that product put in the device's compare list directly.
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
async function addHalo(page) {
  await page.goto(base + "/p/gatecheck-halo");
  await page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  await page.locator(".buy-row").getByRole("button", { name: "Add to cart" }).click();
  const sheet = page.getByRole("dialog", { name: "Your cart" });
  await sheet.locator(".line").first().waitFor({ timeout: 10000 });
  return sheet;
}

try {
  // Phone: the cart sheet from the right, "Removed" with Undo, the count bump.
  const phone = await shopper({ width: 360, height: 780 });
  let page = phone.page;
  let sheet = await addHalo(page);
  check(
    (await sheet.locator(".sheet").getAttribute("class")).includes("right"),
    "phones get the cart sheet from the right",
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "sheet-cart-360.png") });
  await sheet.getByRole("button", { name: /^Remove Gatecheck Halo/ }).click();
  const removed = sheet.locator(".toast", { hasText: "Removed from cart" });
  await removed.waitFor();
  check(true, "removing a line shows the toast inside the open sheet");
  await page.screenshot({ path: join(shots, "toast-removed-360.png") });
  await removed.getByRole("button", { name: "Undo" }).click();
  await sheet.locator(".line").first().waitFor();
  check(
    (await sheet.locator(".line").count()) === 1 &&
      (await page.evaluate(() => localStorage.getItem("ih_cart_v1") ?? "")).includes("variantId"),
    "Undo puts the line back",
  );
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });

  // The count bumps when it changes, not when a page loads with it.
  await page.goto(base + "/p/gatecheck-halo");
  await page.waitForTimeout(600);
  check(
    (await page.locator(".bump").count()) === 0,
    "a page that loads with a cart does not bump the count",
  );
  await page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  await page.locator(".buy-row").getByRole("button", { name: "Add to cart" }).click();
  check(
    await page
      .locator("[data-cc].bump")
      .waitFor({ state: "attached", timeout: 3000 })
      .then(
        () => true,
        () => false,
      ),
    "adding bumps the cart count",
  );
  await page.keyboard.press("Escape");

  // Saving: the toast with "View saved", then "Removed from saved items".
  await page.goto(base + "/shop");
  const heart = page.getByRole("button", { name: "Save Gatecheck Halo" }).first();
  await heart.click();
  const saved = page.locator(".toasts .toast", { hasText: "Saved on this device" });
  await saved.waitFor();
  check(/No account needed/.test(await saved.innerText()), "saving confirms with a toast");
  await page.screenshot({ path: join(shots, "toast-saved-360.png") });
  await saved.getByRole("button", { name: "View saved" }).click();
  await page.waitForURL(/\/wishlist/);
  check(true, "View saved opens the saved items");
  await page.goto(base + "/shop");
  await page
    .getByRole("button", { name: "Remove Gatecheck Halo from saved items" })
    .first()
    .click();
  await page.locator(".toasts .toast", { hasText: "Removed from saved items" }).waitFor();
  check(true, "unsaving confirms with a toast");

  // Compare tray: shown with a compared product, lifts the WhatsApp button, clears.
  await page.evaluate(() =>
    localStorage.setItem(
      "ih_lists_v1",
      JSON.stringify({ v: 1, saved: [], compare: ["gatecheck-halo"], recent: [] }),
    ),
  );
  await page.goto(base + "/shop");
  const tray = page.getByRole("region", { name: "Compare tray" });
  await tray.waitFor();
  check(/1 of 3 kits/.test(await tray.innerText()), "the tray counts the compared kits");
  check(
    (await page.locator(".wafab").getAttribute("class")).includes("up"),
    "the WhatsApp button moves up above the tray",
  );
  await page.screenshot({ path: join(shots, "compare-tray-360.png") });
  await page.goto(base + "/p/gatecheck-halo");
  await page.waitForTimeout(500);
  check(!(await tray.isVisible()), "no tray on a product page");
  await page.goto(base + "/shop");
  await tray.getByRole("button", { name: "Clear compare" }).click();
  await tray.waitFor({ state: "detached" });
  check(true, "clearing empties the compare list and removes the tray");

  // Quick add as a bottom sheet.
  await page
    .getByRole("button", { name: /^Quick add Gatecheck Halo/ })
    .first()
    .click();
  const quick = page.getByRole("dialog", { name: "Quick add" });
  await quick.locator(".q-head").waitFor();
  check(
    (await quick.locator(".sheet").getAttribute("class")).includes("bottom"),
    "quick add is a bottom sheet",
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "sheet-quick-360.png") });
  await page.keyboard.press("Escape");
  await quick.waitFor({ state: "hidden" });
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();

  // Wide: the cart pop-over under the header's cart button.
  const wide = await shopper({ width: 1280, height: 900 });
  page = wide.page;
  sheet = await addHalo(page);
  await page.waitForTimeout(400);
  const panel = sheet.locator(".sheet");
  const anchor = await page.locator("[data-cart-anchor]").boundingBox();
  const box = await panel.boundingBox();
  check(
    (await panel.getAttribute("class")).includes("pop") &&
      anchor &&
      box &&
      box.y > anchor.y + anchor.height &&
      box.x + box.width > anchor.x,
    "wide screens get the pop-over under the cart button",
    JSON.stringify({ anchor, box }),
  );
  await page.screenshot({ path: join(shots, "sheet-cart-1280.png") });
  check(wide.errors.length === 0, "no page errors on a wide screen", wide.errors.join("; "));
  await wide.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
