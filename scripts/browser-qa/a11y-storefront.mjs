// Accessibility pass of the storefront (roadmap step 120, local part) against the real served
// stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   (SERVING)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/a11y-storefront.mjs <SERVING> [<SHOTS_DIR>]
// QA_PLAYWRIGHT_DIR must hold playwright-core and axe-core (`npm i playwright-core@1 axe-core@4`).
// axe-core (WCAG 2.1 A/AA rules) on every shopper page at 360px and 1280px, then keyboard-only
// journeys: product → add → cart sheet → cart, the menu sheet, and checkout's form errors.
import { createRequire } from "node:module";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const qaDir = process.env.QA_PLAYWRIGHT_DIR ?? process.cwd();
const require = createRequire(join(qaDir, "noop.js"));
const { chromium } = require("playwright-core");
const axePath = require.resolve("axe-core/axe.min.js");
const [base, shots = join(qaDir, "shots")] = process.argv.slice(2);
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
async function shopper(viewport, verified = true) {
  const context = await browser.newContext({ viewport });
  if (verified)
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
/** axe on the current page; serious and critical violations fail, the rest are listed. */
async function scan(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () =>
    // eslint-disable-next-line no-undef
    axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }),
  );
  const blocking = result.violations.filter((v) => ["serious", "critical"].includes(v.impact));
  const describe = (list) =>
    list
      .map((v) => `${v.id}(${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`)
      .join("; ");
  check(blocking.length === 0, `axe ${label}`, describe(blocking));
  const minor = result.violations.filter((v) => !blocking.includes(v));
  if (minor.length) console.log(`  note ${label}: ${describe(minor)}`);
}
const focusInDialog = (page) =>
  page.evaluate(() => document.activeElement?.closest("dialog[open]") !== null);
async function tabTo(page, matches, limit = 60) {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(matches)) return true;
  }
  return false;
}

const PAGES = [
  "/",
  "/shop",
  "/disposable-vapes",
  "/brands",
  "/offers",
  "/search?q=gatecheck",
  "/p/gatecheck-halo",
  "/cart",
  "/checkout",
  "/wishlist",
  "/compare",
  "/help",
  "/responsible-use",
];
try {
  // 1. Automated rules on every page, both sizes, with a cart line so cart pages are full.
  for (const viewport of [
    { width: 360, height: 780 },
    { width: 1280, height: 800 },
  ]) {
    const { context, page, errors } = await shopper(viewport);
    await page.goto(base + "/p/gatecheck-halo");
    await page
      .locator("label", { hasText: /^grape/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.getByRole("dialog", { name: /Your cart/ }).waitFor();
    await scan(page, `cart sheet @${viewport.width}`);
    for (const path of PAGES) {
      await page.goto(base + path);
      await page.waitForLoadState("networkidle");
      await scan(page, `${path} @${viewport.width}`);
    }
    if (viewport.width === 360) {
      await page.goto(base + "/shop");
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("dialog", { name: "Menu" }).waitFor();
      await scan(page, "menu sheet @360");
    }
    check(errors.length === 0, `no page errors @${viewport.width}`, errors.join("; "));
    await context.close();
  }
  const visitor = await shopper({ width: 360, height: 780 }, false);
  // The gate redirects "/" to the configured https origin; the age page itself is served here.
  await visitor.page.goto(base + "/age-check");
  await visitor.page.waitForLoadState("networkidle");
  await scan(visitor.page, "age check (unverified) @360");
  await visitor.context.close();

  // 2. Keyboard only: product → add → cart sheet → cart page.
  const keys = await shopper({ width: 1280, height: 800 });
  const { page } = keys;
  await page.goto(base + "/p/gatecheck-halo");
  check(
    await tabTo(page, () => document.activeElement?.closest("fieldset") !== null),
    "Tab reaches the option choice",
  );
  // Arrow keys move between the options of a group; choose the in-stock "grape" one.
  for (let i = 0; i < 6; i++) {
    const value = await page.evaluate(() => document.activeElement?.getAttribute("value") ?? "");
    if (value.startsWith("grape")) break;
    await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("Space");
  check(
    await tabTo(page, () => document.activeElement?.textContent?.trim() === "Add to cart"),
    "Tab reaches Add to cart",
  );
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: /Your cart/ });
  await sheet.waitFor();
  check(await focusInDialog(page), "the cart sheet takes focus");
  // A modal dialog keeps focus in itself; past its last control the browser's own toolbar may
  // take one stop (seen as <body>), then focus comes back into the dialog.
  let trapped = true;
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    trapped &&= await page.evaluate(
      () =>
        document.activeElement === document.body ||
        document.activeElement?.closest("dialog[open]") !== null,
    );
  }
  check(trapped, "Tab never reaches the page behind the open cart sheet");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  check(
    await page.evaluate(() => document.activeElement?.textContent?.trim() === "Add to cart"),
    "closing the cart sheet returns focus to Add to cart",
  );
  // Straight away, before the dialog's close event: the sheet must open again.
  await page.keyboard.press("Enter");
  await sheet.waitFor({ timeout: 5000 });
  check(true, "adding again right after closing reopens the sheet");
  check(
    await tabTo(
      page,
      () => document.activeElement?.textContent?.trim() === "View cart and checkout",
      30,
    ),
    "Tab reaches View cart and checkout in the sheet",
  );
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/cart$/);
  check(true, "Enter follows the sheet's link to the cart");

  // 3. Checkout form errors are announced and reachable.
  await page.goto(base + "/checkout");
  await page.getByRole("heading", { name: "Contact" }).waitFor({ timeout: 15000 });
  const submit = page.getByRole("button", { name: /Place order/ });
  await submit.waitFor({ timeout: 15000 });
  if (await submit.isDisabled()) {
    await page.getByLabel("Delivery area").selectOption({ index: 1 });
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("button")].find((b) => /Place order/.test(b.textContent))
          ?.disabled,
      null,
      { timeout: 15000 },
    );
  }
  await submit.click();
  await page.waitForTimeout(500);
  const invalid = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-invalid="true"]')].map((el) => ({
      id: el.id,
      described: (el.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .filter(Boolean)
        .every((ref) => document.getElementById(ref)?.textContent?.trim()),
    })),
  );
  check(invalid.length > 0, "an empty checkout marks its fields invalid", JSON.stringify(invalid));
  check(
    invalid.every((field) => field.described),
    "every invalid field points at a visible error text",
    JSON.stringify(invalid),
  );
  // Focus goes to the error summary ("Please fix …"), announced as an alert, whose links lead
  // to each invalid field.
  const summary = await page.evaluate(() => {
    const box = document.activeElement;
    if (box?.getAttribute("role") !== "alert") return null;
    return [...box.querySelectorAll("a[href^='#']")].map((link) => {
      const target = document.getElementById(link.getAttribute("href").slice(1));
      return target?.getAttribute("aria-invalid") === "true";
    });
  });
  check(
    summary !== null && summary.length === invalid.length && summary.every(Boolean),
    "focus moves to an error summary that links to every invalid field",
    JSON.stringify(summary),
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  check(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-invalid") === "true"),
    "following a summary link by keyboard reaches that field",
    await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120) ?? ""),
  );
  await page.screenshot({ path: join(shots, "a11y-checkout-errors.png"), fullPage: true });
  await scan(page, "checkout with errors @1280");
  check(
    keys.errors.length === 0,
    "no page errors in the keyboard journeys",
    keys.errors.join("; "),
  );
  await keys.context.close();

  // 4. Keyboard only: the menu sheet on a phone.
  const small = await shopper({ width: 360, height: 780 });
  await small.page.goto(base + "/shop");
  check(
    await tabTo(
      small.page,
      () => document.activeElement?.getAttribute("aria-label") === "Open menu",
    ),
    "Tab reaches the Open menu button",
  );
  await small.page.keyboard.press("Enter");
  await small.page.getByRole("dialog", { name: "Menu" }).waitFor();
  check(await focusInDialog(small.page), "the menu takes focus");
  check(
    await tabTo(
      small.page,
      () =>
        document.activeElement?.tagName === "SUMMARY" &&
        /Brands/.test(document.activeElement.textContent),
      15,
    ),
    "Tab reaches Brands",
  );
  await small.page.keyboard.press("Enter");
  check(
    await tabTo(
      small.page,
      () => /\/brands\/.+/.test(document.activeElement?.getAttribute("href") ?? ""),
      10,
    ),
    "Brands opens with Enter and its links are reachable",
  );
  await small.page.keyboard.press("Escape");
  check(
    await small.page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") === "Open menu",
    ),
    "Escape returns focus to Menu",
  );
  await small.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
