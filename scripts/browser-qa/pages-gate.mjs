// Browser pass of the saved, compare, help and brands pages and the age gate as the prototype
// draws them (V-S6b, ADR 0097) against the real served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve &   (SERVING)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/pages-gate.mjs <SERVING> [<SHOTS_DIR>]
// The gate stack has one product (/p/gatecheck-halo, a disposable) of the brand Gatebrand and
// no kit, so the comparison is checked with that product, which it must refuse as "not a kit".
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
async function visitor(viewport, verified) {
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
const noSideways = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

try {
  // The gate, unverified: the prototype's card, then the restricted page after "No".
  for (const width of [360, 1280]) {
    const guest = await visitor({ width, height: 800 }, false);
    // The redirect to the gate goes to the stack's public host (covered by `pnpm test:gate`);
    // here the gate page is opened directly.
    await guest.page.goto(base + "/age-check?return=%2F");
    const card = guest.page.locator(".gate .gate-card");
    await card.waitFor();
    check(
      (await card.locator(".gate-seal").innerText()).trim() === "18+",
      `gate @${width}: the 18+ seal`,
    );
    check(
      (await card.locator(".gate-actions button").count()) === 2,
      `gate @${width}: two answers side by side in the prototype's group`,
    );
    check(
      !(await guest.page.content()).includes("Gatecheck Halo"),
      `gate @${width}: no product data on the gate`,
    );
    check(await noSideways(guest.page), `gate @${width}: no sideways scroll`);
    await guest.page.screenshot({ path: join(shots, `gate-${width}.png`) });
    if (width === 360) {
      check(
        (await card.locator('form[action="/api/age/reject"] button').count()) === 1,
        "gate: the under-age answer is a plain form post",
      );
      await guest.page.goto(base + "/restricted");
      check(
        (await guest.page.locator(".gate.restricted .gate-seal.lock").count()) === 1,
        "restricted: the lock seal",
      );
      check(
        (await guest.page.getByRole("link", { name: /Leave this site/ }).count()) === 1,
        "restricted: the way out",
      );
      await guest.page.screenshot({ path: join(shots, "restricted-360.png") });
    }
    check(guest.errors.length === 0, `gate @${width}: no page errors`, guest.errors.join("; "));
    await guest.context.close();
  }

  const phone = await visitor({ width: 360, height: 780 }, true);
  await phone.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const { page } = phone;

  // Saved items: the empty state, then a saved product.
  await page.goto(base + "/wishlist");
  await page.getByRole("heading", { name: "Nothing saved yet" }).waitFor();
  check(
    (await page.locator(".empty .ic").count()) === 1 &&
      /Saved on this device/.test(await page.locator(".shop-head").innerText()),
    "saved: the prototype's empty state and the device note",
  );
  await page.evaluate(() =>
    localStorage.setItem(
      "ih_lists_v1",
      JSON.stringify({ v: 1, saved: ["gatecheck-halo"], compare: [], recent: [] }),
    ),
  );
  await page.reload();
  await page.locator(".list-page .pgrid .card").first().waitFor();
  check(true, "saved: a saved product shows as a card");

  // Compare: a disposable in the list is not a kit, so it is reported and nothing is compared.
  await page.evaluate(() =>
    localStorage.setItem(
      "ih_lists_v1",
      JSON.stringify({ v: 1, saved: [], compare: ["gatecheck-halo"], recent: [] }),
    ),
  );
  await page.goto(base + "/compare");
  await page.locator(".list-page .notice").waitFor();
  check(
    (await page.getByRole("heading", { name: "Choose kits to compare" }).count()) === 1,
    "compare: a non-kit is reported and the prototype's empty state shows",
  );
  await page.locator(".notice .link").click();
  await page.locator(".notice").waitFor({ state: "detached" });
  check(true, "compare: the unavailable item can be removed");
  check(await noSideways(page), "compare: no sideways scroll");

  // Help: topic chips, sections, FAQ, copy the number.
  await page.goto(base + "/help");
  check((await page.locator(".tabs .chip").count()) >= 3, "help: the topic chips");
  await page.locator(".tabs .chip", { hasText: "FAQ" }).click();
  await page.waitForURL(/#help-faq/);
  const faq = page.locator(".faq details").first();
  await faq.locator("summary").click();
  check(await faq.evaluate((element) => element.open), "help: a question opens");
  const copy = page.getByRole("button", { name: "Copy number" });
  if (await copy.count()) {
    await copy.click();
    await page.locator(".toasts .toast", { hasText: "Copied" }).waitFor();
    check(true, "help: copying the number confirms with a toast");
  } else check(true, "help: no number configured, no copy button");
  check(await noSideways(page), "help: no sideways scroll");
  await page.screenshot({ path: join(shots, "help-360.png"), fullPage: true });

  // Brands: tiles in a grid, shop by type, the brand page's header.
  await page.goto(base + "/brands");
  await page.locator(".brands-grid .brand").first().waitFor();
  check(
    (await page.locator(".brands-grid .brand", { hasText: "Gatebrand" }).count()) === 1,
    "brands: the brand tile",
  );
  check((await page.locator(".cats .cat").count()) === 2, "brands: shop by type");
  await page.screenshot({ path: join(shots, "brands-360.png"), fullPage: true });
  await page.locator(".brands-grid .brand", { hasText: "Gatebrand" }).click();
  await page.waitForURL(/\/brands\/gatebrand/);
  const hero = page.locator(".bhero");
  await hero.waitFor();
  check(
    (await hero.getByRole("heading", { level: 1, name: "Gatebrand" }).count()) === 1 &&
      /1\s*product/.test(await hero.locator(".stats").innerText()),
    "brand page: the prototype's header with the product count",
  );
  check(await noSideways(page), "brand page: no sideways scroll");
  await page.screenshot({ path: join(shots, "brand-360.png") });
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
