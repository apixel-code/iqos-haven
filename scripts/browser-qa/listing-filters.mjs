// Browser pass of the listing-page filters (parity G-S2, ADR 0086) against the real served stack:
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
const filtersOf = (page) => page.locator("aside[aria-label=Filters] div.hidden.lg\\:flex form");
const legends = async (page) =>
  (await filtersOf(page).locator("legend").allTextContents()).map((text) => text.trim());
const products = (page) => page.locator("section[aria-label=Products]");

try {
  const { context, page, errors } = await shopper({ width: 1280, height: 900 });

  // The full shop offers every filter, with counts.
  await page.goto(base + "/shop");
  let shown = await legends(page);
  check(
    ["Sort by", "Category", "Brand", "Price (AED)", "Availability"].every((name) =>
      shown.some((legend) => legend.startsWith(name)),
    ),
    "the shop offers sort, type, brand, price and availability",
    shown.join(", "),
  );
  check(
    /\d+\s+products?/.test(await products(page).innerText()),
    "the shop shows how many products match",
  );

  // A type page does not offer its own type; a filter narrows and stays in the page's path.
  await page.goto(base + "/disposable-vapes");
  shown = await legends(page);
  check(
    !shown.includes("Category"),
    "a type page does not offer the type it is about",
    shown.join(", "),
  );
  check(
    shown.some((legend) => legend.startsWith("Puff count")),
    "disposables offer the puff count filter",
  );
  await filtersOf(page).getByLabel("In stock only").check();
  await filtersOf(page).getByRole("button", { name: "Show results" }).click();
  await page.waitForURL(
    (url) => url.pathname === "/disposable-vapes" && url.searchParams.get("inStock") === "true",
  );
  check(
    !new URL(page.url()).searchParams.has("type"),
    "a filter submits to the listing page itself, without its fixed type",
  );
  check(
    (await products(page).innerText()).includes("Gatecheck Halo"),
    "the in-stock product stays listed",
  );
  await filtersOf(page).getByLabel("Minimum price in dirhams").fill("1000");
  await filtersOf(page).getByRole("button", { name: "Show results" }).click();
  await page.waitForURL(/minPrice=1000/);
  await page.getByText("No products match these filters").waitFor();
  check(true, "a filter that matches nothing says so");
  await page.getByRole("link", { name: "Clear all filters" }).click();
  await page.waitForURL((url) => url.pathname === "/disposable-vapes" && !url.search);
  check(true, "Clear all filters returns to the plain listing");

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
  await page.screenshot({ path: join(shots, "listing-filters-1280.png"), fullPage: true });
  check(errors.length === 0, "no page errors on a wide screen", errors.join("; "));
  await context.close();

  // Phone: filters are in a collapsible block that opens when a filter is active.
  const phone = await shopper({ width: 360, height: 780 });
  await phone.page.goto(base + "/vape-kits?inStock=true");
  const block = phone.page.locator("aside[aria-label=Filters] details");
  check(
    (await block.getAttribute("open")) !== null,
    "the phone filter block opens when a filter is active",
  );
  check(
    /Filters \(1\)/.test(await block.locator("summary").innerText()),
    "it counts the active filter",
  );
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
