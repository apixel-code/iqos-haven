// Browser pass of the storefront mobile menu sheet (parity G-S4, ADR 0083) against the real
// served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   (SERVING)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/menu-sheet.mjs <SERVING> [<SHOTS_DIR>]
// At 360px: the compact header, the menu's sections, brands, saved count, help and closing.
// At 1280px: the full header and no menu button.
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
const menuOf = (page) => page.getByRole("dialog", { name: "Menu" });
const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  // 1. Phone.
  const phone = await shopper({ width: 360, height: 780 });
  const { page } = phone;
  await page.goto(base + "/p/gatecheck-halo");
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.goto(base + "/shop");
  const menuButton = header(page).getByRole("button", { name: "Open menu" });
  check(await menuButton.isVisible(), "the phone header has a Menu button");
  check(
    !(await header(page).getByRole("link", { name: "Disposables" }).isVisible()),
    "the section links leave the phone header",
  );
  const headerBox = await header(page).boundingBox();
  check(
    headerBox && headerBox.height < 140,
    "the phone header stays compact",
    JSON.stringify(headerBox),
  );
  check(await noSideScroll(page), "no sideways scrolling at 360px");
  await menuButton.click();
  const menu = menuOf(page);
  await menu.waitFor();
  check(
    await page.evaluate(() => document.activeElement?.closest("dialog") !== null),
    "focus moves into the menu",
  );
  const box = await menu.boundingBox();
  check(
    box && Math.round(box.x) === 0 && Math.round(box.height) === 780,
    "the menu is a full-height sheet from the left",
    JSON.stringify(box),
  );
  const text = await menu.innerText();
  for (const label of [
    "Home",
    "Shop",
    "Disposables",
    "Vape kits",
    "Offers",
    "Brands",
    "Compare kits",
    "Help & info",
  ])
    check(text.includes(label), `the menu lists ${label}`);
  check(/Saved items\s*1/.test(text), "the menu shows the saved count", text);
  await page.screenshot({ path: join(shots, "menu-sheet-360.png") });
  await menu.getByRole("button", { name: "Brands", exact: true }).click();
  await menu.getByRole("link", { name: /Gatebrand/ }).waitFor({ timeout: 10000 });
  check(true, "opening Brands loads the brands");
  await page.screenshot({ path: join(shots, "menu-sheet-brands-360.png") });
  await menu.getByRole("link", { name: /Gatebrand/ }).click();
  await page.waitForURL(/\/brands\//);
  await menu.waitFor({ state: "hidden" });
  check(true, "a brand opens its page and closes the menu");
  await menuButton.click();
  await menu.getByRole("button", { name: "Help & info" }).click();
  await menu.getByRole("link", { name: "Delivery information" }).click();
  await page.waitForURL(/\/help#help-delivery/);
  await menu.waitFor({ state: "hidden" });
  check(true, "a help link opens that section and closes the menu");
  await menuButton.click();
  await menu.waitFor();
  const wa = menu.getByRole("link", { name: "Chat on WhatsApp" });
  check(
    (await wa.count()) === 0 || /^https:\/\/wa\.me\//.test((await wa.getAttribute("href")) ?? ""),
    "WhatsApp is offered only as a wa.me link, when a number is set",
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  check(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Open menu"),
    "Escape closes the menu and returns focus to its button",
  );
  await menuButton.click();
  await page.mouse.click(350, 400);
  await menu.waitFor({ state: "hidden" });
  check(true, "a click outside the panel closes the menu");
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();

  // 2. Wide screen.
  const wide = await shopper({ width: 1280, height: 800 });
  await wide.page.goto(base + "/shop");
  check(
    !(await header(wide.page).getByRole("button", { name: "Open menu" }).isVisible()),
    "a wide screen has no Menu button",
  );
  check(
    (await header(wide.page).getByRole("link", { name: "Disposable Vapes" }).isVisible()) &&
      (await header(wide.page)
        .getByRole("link", { name: /Saved items/ })
        .isVisible()),
    "a wide screen keeps the sections and the saved-items button in the header",
  );
  await wide.page.screenshot({ path: join(shots, "menu-header-1280.png") });
  check(wide.errors.length === 0, "no page errors on a wide screen", wide.errors.join("; "));
  await wide.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
