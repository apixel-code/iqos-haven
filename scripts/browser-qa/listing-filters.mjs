// Browser pass of the listing-page filters (parity G-S2, ADR 0086; the prototype layout, G-S6,
// G-S7 and G-S9, ADR 0097) against the real served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve &   (SERVING)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/listing-filters.mjs <SERVING> [<SHOTS_DIR>]
// The gate stack's catalogue: one published disposable (Gatecheck Halo, Gatebrand, 7,000 puffs).
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
const filtersOf = (page) => page.locator("aside.shop-side form");
const legends = async (page) =>
  (await filtersOf(page).locator("legend").allTextContents()).map((text) => text.trim());
const products = (page) => page.locator(".shop-main");

try {
  const { context, page, errors } = await shopper({ width: 1280, height: 900 });

  // The full shop offers every filter, with counts, and the sort in the toolbar.
  await page.goto(base + "/shop");
  let shown = await legends(page);
  check(
    ["Category", "Brand", "Price", "Availability"].every((name) =>
      shown.some((legend) => legend.startsWith(name)),
    ) && (await page.getByLabel("Sort by").count()) === 1,
    "the shop offers type, brand, price, availability and the sort",
    shown.join(", "),
  );
  check(
    /\d+\s+products?/.test(await page.locator(".toolbar .cnt").innerText()),
    "the toolbar shows how many products match",
  );

  // A type page does not offer its own type; a change applies at once, in the page's path.
  await page.goto(base + "/disposable-vapes");
  shown = await legends(page);
  check(
    !shown.includes("Category"),
    "a type page does not offer the type it is about",
    shown.join(", "),
  );
  check(
    shown.some((legend) => legend.startsWith("Puff count")),
    "disposables offer the puff count bands",
    shown.join(", ") || (await page.locator("main").innerText()).slice(0, 200),
  );
  // While the next page loads, the grid shows the skeleton (parity G-S7).
  await page.route(/_rsc=/, async (route) => {
    await new Promise((done) => setTimeout(done, 1200));
    await route.continue();
  });
  await filtersOf(page).getByLabel("In stock only").check();
  await page.getByLabel("Loading products").waitFor({ timeout: 3000 });
  check(true, "the grid shows the skeleton while a filter applies");
  await page.waitForURL(
    (url) => url.pathname === "/disposable-vapes" && url.searchParams.get("inStock") === "true",
  );
  await page.unroute(/_rsc=/);
  check(
    !new URL(page.url()).searchParams.has("type"),
    "a filter applies at once to the listing itself, without its fixed type",
  );
  await page.locator(".pgrid").waitFor();
  check(
    (await products(page).innerText()).includes("Gatecheck Halo"),
    "the in-stock product stays listed",
  );
  const chip = page.getByRole("link", { name: "Remove filter In stock" });
  check((await chip.count()) === 1, "the active filter shows as a removable chip");
  await filtersOf(page).locator('label[for="f-price-o200-d"]').click();
  await page.waitForURL(/minPrice=200/);
  await page.getByText("No products match these filters").waitFor();
  check(true, "a price band that matches nothing says so");
  await page.getByRole("link", { name: "Clear all filters" }).click();
  await page.waitForURL((url) => url.pathname === "/disposable-vapes" && !url.search);
  check(true, "Clear all filters returns to the plain listing");
  await page.getByLabel("Sort by").selectOption("price_asc");
  await page.waitForURL(/sort=price_asc/);
  check(true, "the sort applies at once");

  // A brand page does not offer brands; offers do not offer "On sale".
  await page.goto(base + "/brands/gatebrand");
  shown = await legends(page);
  check(!shown.includes("Brand"), "a brand page does not offer brands", shown.join(", "));
  await page.goto(base + "/offers");
  check(
    (await filtersOf(page).getByLabel("On sale").count()) === 0,
    "the offers page does not offer On sale",
  );

  // Old listing links keep working.
  await page.goto(base + "/shop?brand=gatebrand&sort=price_asc");
  check(
    (await products(page).innerText()).includes("Gatecheck Halo"),
    "an old brand and sort link still lists the product",
  );
  await page.goto(base + "/shop?cursor=not*a*cursor");
  check((await products(page).count()) === 1, "a malformed cursor is ignored, not an error");

  // Search with no results offers WhatsApp (parity G-S9).
  await page.goto(base + "/search?q=zzqqxx");
  await page.getByRole("heading", { name: /No results for/ }).waitFor();
  const ask = page.getByRole("link", { name: "Ask us on WhatsApp" });
  check(
    /^https:\/\/wa\.me\/\d+\?text=/.test((await ask.getAttribute("href")) ?? ""),
    "no results offer to ask on WhatsApp with a prepared message",
  );
  await page.screenshot({ path: join(shots, "listing-filters-1280.png"), fullPage: true });
  check(errors.length === 0, "no page errors on a wide screen", errors.join("; "));
  await context.close();

  // Phone: the Filters button with its count opens the bottom sheet (parity G-S6).
  const phone = await shopper({ width: 360, height: 780 });
  await phone.page.goto(base + "/vape-kits?inStock=true");
  const button = phone.page.locator(".fbtn");
  check(
    /Filters\s*1/.test(await button.innerText()),
    "the Filters button counts the active filter",
  );
  await button.click();
  const sheet = phone.page.getByRole("dialog", { name: "Filters" });
  await sheet.waitFor();
  const show = sheet.getByRole("button", { name: /^Show \d+ products?$/ });
  check((await show.count()) === 1, "the sheet shows how many products the filters give");
  await sheet.getByLabel("In stock only").uncheck();
  await phone.page.waitForURL((url) => url.pathname === "/vape-kits" && !url.search);
  check(await sheet.isVisible(), "a change in the sheet applies while it stays open");
  await show.click();
  await sheet.waitFor({ state: "hidden" });
  check(true, "Show N products closes the sheet");
  check(
    await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "no sideways scrolling at 360px",
  );
  await phone.page.screenshot({ path: join(shots, "listing-filters-360.png"), fullPage: true });
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
