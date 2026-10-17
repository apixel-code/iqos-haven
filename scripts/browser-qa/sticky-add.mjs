// Browser pass of the sticky add-to-cart bar on phones (parity G-S5, ADR 0088) against the real
// served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve &   (SERVING)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/sticky-add.mjs <SERVING> [<SHOTS_DIR>]
// The gate stack's product /p/gatecheck-halo has a flavour choice (grape in stock).
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
const inView = (page, locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return box.top < window.innerHeight && box.bottom > 0;
  });

try {
  const { context, page, errors } = await shopper({ width: 360, height: 780 });
  await page.goto(base + "/p/gatecheck-halo");
  const bar = page.getByRole("region", { name: "Add to cart" });
  await bar.waitFor({ state: "attached" });
  check(!(await inView(page, bar)), "the bar is hidden while the main button is on screen");
  check(
    await bar.evaluate((element) => element.inert === true),
    "the hidden bar is inert (not focusable)",
  );

  // Scroll past the main button.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  check(await inView(page, bar), "the bar slides in once the main button is scrolled away");
  check(await bar.evaluate((element) => element.inert === false), "the shown bar is usable");
  const text = await bar.innerText();
  check(
    text.includes("Gatecheck Halo") && /Choose an option/.test(text) && /AED/.test(text),
    "it names the product, asks for an option and shows the price",
    text,
  );
  const box = await bar.boundingBox();
  check(
    box && Math.round(box.y + box.height) === 780,
    "it sits on the bottom edge",
    JSON.stringify(box),
  );
  await page.screenshot({ path: join(shots, "sticky-add-choose-360.png") });
  const covered = await page.evaluate(() => {
    const last = [...document.querySelectorAll("footer p")].at(-1);
    const bar = document.querySelector('[role="region"][aria-label="Add to cart"]');
    return last && bar
      ? last.getBoundingClientRect().bottom > bar.getBoundingClientRect().top
      : true;
  });
  check(!covered, "at the bottom of the page the bar covers no footer text");

  // No option chosen: the bar takes the shopper to the choice, nothing is added.
  await bar.getByRole("button", { name: "Add to cart" }).click();
  await page.waitForTimeout(700);
  check(
    await page.evaluate(() => document.activeElement?.closest("fieldset[data-option]") !== null),
    "with no option chosen, focus goes to the option choice",
  );
  check(
    await page.evaluate(() => !(localStorage.getItem("ih_cart_v1") ?? "").includes("variantId")),
    "nothing is added without a choice",
  );

  // Choose, scroll away again, add from the bar.
  await page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  check(
    /AED 49 · grape/.test(await bar.innerText()),
    "the bar shows the chosen option and its price",
  );
  await bar.getByRole("button", { name: "Add to cart" }).click();
  await page.getByRole("dialog", { name: /Your cart/ }).waitFor();
  check(true, "adding from the bar opens the cart sheet");
  check(errors.length === 0, "no page errors on a phone", errors.join("; "));
  await context.close();

  const wide = await shopper({ width: 1280, height: 800 });
  await wide.page.goto(base + "/p/gatecheck-halo");
  await wide.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wide.page.waitForTimeout(400);
  check(
    !(await wide.page.getByRole("region", { name: "Add to cart" }).isVisible()),
    "a wide screen has no sticky bar",
  );
  await wide.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
