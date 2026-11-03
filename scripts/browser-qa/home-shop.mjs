// Browser QA for the shop-style home page and the shorter quick add (ADR 0105): the product
// rows, the two-brand showcase, the hero's height on a phone, and quick add ending in Checkout.
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open   (prints SERVING)
//   QA_PLAYWRIGHT_DIR=<dir with playwright-core> node scripts/browser-qa/home-shop.mjs <SERVING> [<shots dir>]
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

for (const viewport of [
  { width: 360, height: 780 },
  { width: 1280, height: 900 },
]) {
  const label = `${viewport.width}px`;
  const { context, page, errors } = await shopper(viewport);
  await page.goto(base + "/");
  await page.getByRole("heading", { name: "Shop by category" }).waitFor();
  for (const heading of ["New arrivals", "Shop by brand"])
    check(
      (await page.getByRole("heading", { name: heading, exact: true }).count()) === 1,
      `${label}: "${heading}" section`,
    );
  const card = page.locator(".bshow-card").first();
  check(
    (await card.count()) === 1 && /Shop \S+/.test(await card.innerText()),
    `${label}: brands shown as showcase cards with their own button`,
  );
  const cta = await card.locator(".bshow-cta").boundingBox();
  check(
    cta && cta.height < 48,
    `${label}: the brand button stays on one line`,
    JSON.stringify(cta),
  );
  const hero = await page.locator(".hb-main").boundingBox();
  check(
    hero && (viewport.width >= 720 || hero.height < 420),
    `${label}: the hero is no taller than its content on a phone`,
    JSON.stringify(hero),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  check(!overflow, `${label}: no sideways scroll`);
  await page.screenshot({ path: join(shots, `home-shop-${viewport.width}.png`), fullPage: true });

  // Quick add: choose, add, and the same sheet offers Checkout.
  await page.goto(base + "/shop");
  await page
    .getByRole("button", { name: /^Quick add Gatecheck Halo/ })
    .first()
    .click();
  const quick = page.getByRole("dialog", { name: "Quick add" });
  await quick.locator(".q-head").waitFor();
  const choice = quick.locator("label", { hasText: /^grape/ });
  if (await choice.count()) await choice.first().click();
  await quick.getByRole("button", { name: "Add to cart" }).click();
  const done = page.getByRole("dialog", { name: "Added to cart" });
  await done.waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `quick-added-${viewport.width}.png`) });
  check(
    (await page.locator(".toast", { hasText: "Added to cart" }).count()) === 0,
    `${label}: no toast on top of the sheet`,
  );
  await done.getByRole("button", { name: "Checkout" }).click();
  await page.waitForURL("**/checkout");
  await page.getByRole("heading", { name: "Contact" }).waitFor();
  check(true, `${label}: Checkout in the sheet goes straight to checkout`);
  check(errors.length === 0, `${label}: no page errors`, errors.join("; "));
  await context.close();
}

await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all home and quick add checks passed");
process.exit(failed ? 1 : 0);
