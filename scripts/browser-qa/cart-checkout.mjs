// Browser pass of the cart and checkout as the prototype draws them (V-S5, ADR 0097; collapsed
// mobile summary G-S8, empty-cart best sellers G-S14) against the real served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open &   (SERVING, SCHEMA)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/cart-checkout.mjs <SERVING> <SCHEMA> [<SHOTS_DIR>]
// The gate stack publishes no home content, so a manual best-sellers section with the gate
// product is written through `docker exec` psql (QA_PSQL overrides the command). No order is
// placed here (checkout.mjs does that).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");
const [base, schema, shots = join(process.env.QA_PLAYWRIGHT_DIR ?? ".", "shots")] =
  process.argv.slice(2);
if (!/^https?:\/\//.test(base ?? "") || !/^ih_test_[0-9a-f]{32}$/.test(schema ?? ""))
  throw new Error("usage: <SERVING> <SCHEMA> [<SHOTS_DIR>]");
mkdirSync(shots, { recursive: true });
const PSQL = (
  process.env.QA_PSQL ?? "docker exec -i iqos-haven-postgres-1 psql -U ih_owner -d iqos_haven_test"
).split(" ");
const sql = (statement) =>
  execFileSync(
    PSQL[0],
    [
      ...PSQL.slice(1),
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `SET search_path TO "${schema}"; ${statement}`,
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    // psql's command tags are not values.
    .filter((line) => !/^(SET|INSERT \d+ \d+|UPDATE \d+)$/.test(line))
    .pop();
let failed = 0;
const check = (ok, name, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
};

const product = sql("SELECT id FROM products WHERE slug = 'gatecheck-halo'");
const staff = sql("SELECT id FROM staff_users ORDER BY created_at LIMIT 1");
const section = JSON.stringify({ mode: "manual", productIds: [product] });
// A section starts as a draft (database guard), then is published like the admin does.
sql(
  `INSERT INTO content_sections (key, schema_version, draft, draft_updated_by)
   VALUES ('best_sellers', 1, '${section}', '${staff}') ON CONFLICT (key) DO NOTHING`,
);
sql(
  `UPDATE content_sections SET published = draft, published_schema_version = schema_version,
     published_by = '${staff}', published_at = now(), version = version + 1
   WHERE key = 'best_sellers' AND published IS NULL`,
);

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
const noSideways = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

try {
  const phone = await shopper({ width: 360, height: 780 });
  const { page } = phone;

  // Empty cart, nothing viewed: the best sellers (the API caches home content for up to 60 s).
  let picks = "";
  for (let attempt = 0; attempt < 15; attempt++) {
    await page.goto(base + "/cart");
    await page.getByRole("heading", { name: "Your cart is empty" }).waitFor();
    await page.waitForTimeout(800);
    picks = (await page.locator(".cart-picks").count())
      ? await page.locator(".cart-picks").innerText()
      : "";
    if (picks) break;
    await page.waitForTimeout(4000);
  }
  check(
    /Best sellers/i.test(picks) && picks.includes("Gatecheck Halo"),
    "an empty cart with no history shows the best sellers (G-S14)",
    picks,
  );
  await page.screenshot({ path: join(shots, "cart-empty-360.png"), fullPage: true });

  // After viewing a product: the recently viewed instead.
  await page.goto(base + "/p/gatecheck-halo");
  await page.getByRole("heading", { level: 1, name: "Gatecheck Halo" }).waitFor();
  await page.waitForTimeout(500);
  await page.goto(base + "/cart");
  await page.locator(".cart-picks").waitFor();
  check(
    /Recently viewed/i.test(await page.locator(".cart-picks").innerText()),
    "with a product viewed, the empty cart shows it as recently viewed",
  );

  // A line in the cart: the prototype's line, WhatsApp card and summary panel.
  await page.goto(base + "/p/gatecheck-halo");
  await page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  await page.locator(".buy-row").getByRole("button", { name: "Add to cart" }).click();
  await page.getByRole("dialog", { name: /Your cart/ }).waitFor();
  await page.goto(base + "/cart");
  await page.locator(".cart-page .line").first().waitFor();
  check((await page.locator(".cart-page .line").count()) === 1, "one cart line");
  check(
    /1 item/.test(await page.locator(".shop-head").innerText()),
    "the heading counts the items",
  );
  check((await page.locator(".cart-page .wa-card").count()) === 1, "the WhatsApp order card");
  check(
    (await page.getByRole("complementary", { name: "Order summary" }).count()) === 1,
    "the summary panel",
  );
  await page.getByLabel("Delivery area").selectOption({ index: 1 });
  await page.locator(".totals .grand").waitFor({ timeout: 10000 });
  check(true, "choosing an area shows the total");
  check(await noSideways(page), "no sideways scroll on the cart at 360px");
  await page.screenshot({ path: join(shots, "cart-360.png"), fullPage: true });

  // Checkout on a phone: the summary folds away with the amount in its title (G-S8).
  await page.getByRole("link", { name: "Checkout · Cash on delivery" }).click();
  await page.getByRole("heading", { name: "Contact" }).waitFor();
  const folded = page.locator("details.sumdet");
  check(await folded.isVisible(), "phones show the folded summary");
  check(
    !(await page.locator("aside.co-sum-d").isVisible()),
    "phones hide the summary beside the form",
  );
  await page.locator(".co-step .totals .grand").waitFor({ timeout: 10000 });
  const title = (await folded.locator("summary").innerText()).replace(/\s+/g, " ");
  const button = (
    await page.getByRole("button", { name: /^Place order · AED/ }).innerText()
  ).replace(/\s+/g, " ");
  const amount = (text) => /(\d[\d,.]*)\s*$/.exec(text.trim())?.[1];
  check(
    /^Order summary · /.test(title) && amount(title) === amount(button),
    "the folded title shows the accepted total, the same as the button",
    `${title} | ${button}`,
  );
  check(
    !(await folded.locator(".mini-line").first().isVisible()),
    "the lines are hidden until opened",
  );
  await folded.locator("summary").click();
  check(await folded.locator(".mini-line").first().isVisible(), "opening it shows the lines");
  check(await noSideways(page), "no sideways scroll on checkout at 360px");
  await page.screenshot({ path: join(shots, "checkout-360.png"), fullPage: true });

  // An empty submit: the prototype's error summary takes focus.
  await page.getByRole("button", { name: /^Place order/ }).click();
  await page.locator(".errsum").waitFor();
  check(
    await page.evaluate(() => document.activeElement?.classList.contains("errsum")),
    "the error summary takes focus",
  );
  check(
    (await page.locator(".input.err").count()) >= 2,
    "fields with an error are marked like the prototype",
  );
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();

  // Wide: the summary sits beside the form, the folded one is gone.
  const wide = await shopper({ width: 1280, height: 900 });
  await wide.page.goto(base + "/p/gatecheck-halo");
  await wide.page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  await wide.page.locator(".buy-row").getByRole("button", { name: "Add to cart" }).click();
  await wide.page.getByRole("dialog", { name: /Your cart/ }).waitFor();
  await wide.page.goto(base + "/cart");
  await wide.page.getByLabel("Delivery area").selectOption({ index: 1 });
  await wide.page.locator(".totals .grand").waitFor({ timeout: 10000 });
  const lines = await wide.page.locator(".cart-page > div").first().boundingBox();
  const panel = await wide.page.locator(".cart-page > aside").boundingBox();
  check(lines && panel && panel.x >= lines.x + lines.width, "cart: summary beside the lines");
  await wide.page.screenshot({ path: join(shots, "cart-1280.png"), fullPage: true });
  await wide.page.getByRole("link", { name: "Checkout · Cash on delivery" }).click();
  await wide.page.getByRole("heading", { name: "Contact" }).waitFor();
  check(
    await wide.page.locator("aside.co-sum-d").isVisible(),
    "checkout: the summary beside the form",
  );
  check(
    !(await wide.page.locator("details.sumdet").isVisible()),
    "checkout: no folded summary on a wide screen",
  );
  await wide.page.screenshot({ path: join(shots, "checkout-1280.png"), fullPage: true });
  check(wide.errors.length === 0, "no page errors on a wide screen", wide.errors.join("; "));
  await wide.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
