// Browser pass of the mobile search sheet (parity G-S3, ADR 0087) against the real served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve &   (SERVING)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/search-sheet.mjs <SERVING> [<SHOTS_DIR>]
// The gate stack's catalogue: one published disposable (Gatecheck Halo, Gatebrand).
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
const header = (page) => page.locator("header").first();

try {
  const { context, page, errors } = await shopper({ width: 360, height: 780 });
  // Remember one product as recently viewed.
  await page.goto(base + "/p/gatecheck-halo");
  // The view is saved on the device after hydration.
  await page.waitForFunction(() =>
    (localStorage.getItem("ih_lists_v1") ?? "").includes("gatecheck-halo"),
  );
  await page.goto(base + "/shop");
  check(
    !(await header(page).getByRole("search").isVisible()),
    "the phone header has no inline search box",
  );
  const button = header(page).getByRole("button", { name: "Search" });
  await button.click();
  const sheet = page.getByRole("dialog", { name: "Search" });
  await sheet.waitFor();
  check(
    await page.evaluate(() => document.activeElement?.getAttribute("type") === "search"),
    "the sheet opens with the field focused",
  );
  const box = await sheet.boundingBox();
  check(
    box && Math.round(box.width) === 360 && Math.round(box.height) === 780,
    "the sheet fills the phone screen",
    JSON.stringify(box),
  );
  await sheet.getByRole("link", { name: "Gatebrand", exact: true }).waitFor({ timeout: 10000 });
  check(true, "before typing, the brands are offered");
  // Recently viewed cards are fetched separately from the brands.
  await sheet.getByRole("heading", { name: "Recently viewed" }).waitFor({ timeout: 10000 });
  check(
    (await sheet.getByRole("link", { name: /Gatecheck Halo/ }).count()) === 1,
    "before typing, the recently viewed product is offered",
  );
  await page.screenshot({ path: join(shots, "search-sheet-empty-360.png") });

  await page.keyboard.type("gatech");
  await sheet.getByRole("heading", { name: "Products" }).waitFor({ timeout: 10000 });
  check(
    (await sheet.getByRole("link", { name: /Gatecheck Halo/ }).count()) >= 1,
    "typing suggests the matching product",
  );
  const all = sheet.getByRole("link", { name: /See all results for “gatech”/ });
  check((await all.getAttribute("href")) === "/search?q=gatech", "it links to every result");
  await page.screenshot({ path: join(shots, "search-sheet-typed-360.png") });
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/search\?q=gatech/);
  await sheet.waitFor({ state: "hidden" });
  check(true, "Enter searches and the sheet closes");

  await button.click();
  await sheet.waitFor();
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  check(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Search"),
    "Escape closes the sheet and returns focus to its button",
  );
  await button.click();
  await sheet.getByRole("link", { name: "Gatebrand", exact: true }).click();
  await page.waitForURL(/\/brands\/gatebrand/);
  await sheet.waitFor({ state: "hidden" });
  check(true, "a brand opens its page and closes the sheet");
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "no sideways scrolling at 360px",
  );
  check(errors.length === 0, "no page errors on a phone", errors.join("; "));
  await context.close();

  const wide = await shopper({ width: 1280, height: 800 });
  await wide.page.goto(base + "/shop");
  check(
    (await header(wide.page).getByRole("search").isVisible()) &&
      !(await header(wide.page)
        .locator('button[aria-haspopup="dialog"]', { hasText: "Search" })
        .isVisible()),
    "a wide screen keeps the inline search box and no Search sheet button",
  );
  check(wide.errors.length === 0, "no page errors on a wide screen", wide.errors.join("; "));
  await wide.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
