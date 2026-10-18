// Browser pass of the product page as the prototype draws it (V-S4, ADR 0097; gallery swipe and
// zoom, parity G-S12) against the real served stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve &   (SERVING, SCHEMA)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/product-page.mjs <SERVING> <SCHEMA> [<SHOTS_DIR>]
// The gate stack's products have no images, so three ready gallery images are written to
// /p/gatecheck-halo through `docker exec` psql (QA_PSQL overrides the command). Their signed
// links point at the real media bucket; the browser is answered with drawn images instead.
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
    // psql's command tags ("SET", "INSERT 0 1") are not values.
    .filter((line) => !/^(SET|INSERT \d+ \d+)$/.test(line))
    .pop();
let failed = 0;
const check = (ok, name, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
};

// Three ready images on the product (idempotent: a rerun keeps the first three).
const product = sql("SELECT id FROM products WHERE slug = 'gatecheck-halo'");
const staff = sql("SELECT id FROM staff_users ORDER BY created_at LIMIT 1");
if (Number(sql(`SELECT count(*) FROM product_images WHERE product_id = '${product}'`)) === 0) {
  for (const n of [1, 2, 3]) {
    const keys = JSON.stringify({
      large: `qa-pdp/${n}-large.webp`,
      medium: `qa-pdp/${n}-medium.webp`,
      thumb: `qa-pdp/${n}-thumb.webp`,
    });
    const asset = sql(
      `WITH g AS (SELECT uuidv7() AS id)
       INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
         declared_bytes, observed_bytes, state, width, height, sha256, derivative_keys,
         upload_expires_at)
       SELECT g.id, '${product}', '${staff}', 'uploads/' || g.id, 'image/webp', 1000, 1000,
         'ready', 1200, 1200, repeat('${n}', 64), '${keys}', now() + interval '1 hour' FROM g
       RETURNING id`,
    );
    sql(
      `INSERT INTO product_images (product_id, asset_key, is_primary, sort_order, alt, width,
         height, mime, media_asset_id)
       VALUES ('${product}', 'qa-pdp/${n}-large.webp', ${n === 1}, ${n}, '', 1200, 1200,
         'image/webp', '${asset}')`,
    );
  }
}
const HUES = { 1: "#d9534f", 2: "#3b82f6", 3: "#22a06b" };
const drawn = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200"><rect width="1200" height="1200" fill="${HUES[n]}"/><text x="600" y="660" font-size="220" text-anchor="middle" fill="#fff">${n}</text></svg>`;

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
  await context.route(/\/qa-pdp\/(\d)-/, (route) => {
    const n = /\/qa-pdp\/(\d)-/.exec(route.request().url())[1];
    return route.fulfill({ contentType: "image/svg+xml", body: drawn(n) });
  });
  await context.request.post(base + "/api/age/accept", {
    headers: { origin: "https://shop.gate-check.test" },
    form: { return: "/" },
    maxRedirects: 0,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The API caches catalogue reads for up to 60 s, so fresh images can take a reload or two.
  for (let attempt = 0; ; attempt++) {
    await page.goto(base + "/p/gatecheck-halo");
    await page.getByRole("heading", { level: 1, name: "Gatecheck Halo" }).waitFor();
    if ((await page.locator(".gal-slide img").count()) === 3 || attempt === 14) break;
    await page.waitForTimeout(5000);
  }
  return { context, page, errors };
}
const dotOn = (page) =>
  page.locator(".gal-dots i").evaluateAll((dots) => dots.findIndex((d) => d.className === "on"));

try {
  // Phone: swipe track with dots, no thumbnails, zoom dialog.
  const phone = await shopper({ width: 360, height: 780 });
  let { page } = phone;
  check((await page.locator(".gal-slide img").count()) === 3, "three slides in the gallery");
  check(
    (await page
      .locator(".gal-slide img")
      .first()
      .evaluate((img) => img.naturalWidth)) > 0,
    "the first image loads",
  );
  check(await page.locator(".gal-dots").isVisible(), "phones show the dots");
  check(!(await page.locator(".gal-thumbs").isVisible()), "phones hide the thumbnails");
  check((await dotOn(page)) === 0, "the first dot is on");
  // A swipe is a scroll of the snap track.
  await page.locator(".gal-track").evaluate((track) => track.scrollTo({ left: track.clientWidth }));
  await page.waitForTimeout(400);
  check((await dotOn(page)) === 1, "swiping to the second image moves the dot");
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    "no sideways page scroll at 360px",
  );
  await page.screenshot({ path: join(shots, "pdp-360.png") });

  await page.getByRole("button", { name: /^Zoom/ }).click();
  await page.getByRole("dialog", { name: /Gatecheck Halo: image 2 of 3/ }).waitFor();
  // The dialog's name follows the image, so later steps find it by its element.
  const zoom = page.locator("dialog.gal-lightbox");
  check(true, "Zoom opens the dialog on the image in view");
  const magnify = zoom.getByRole("button", { name: "Zoom in" });
  await magnify.focus();
  await page.keyboard.press("Enter");
  check(
    (await zoom.getByRole("button", { name: "Zoom out" }).getAttribute("aria-pressed")) === "true",
    "Enter magnifies the image",
  );
  await page.waitForTimeout(400);
  check(
    /scale\(2\)|matrix\(2/.test(
      await zoom.locator("img").evaluate((img) => getComputedStyle(img).transform),
    ),
    "the magnified image is drawn at 2×",
  );
  await page.keyboard.press("ArrowRight");
  check(
    (await zoom.locator(".gal-lb-count").innerText()).trim() === "3 / 3",
    "the arrow key steps to the next image",
  );
  check(
    (await zoom.getByRole("button", { name: "Zoom in" }).count()) === 1,
    "a new image starts unmagnified",
  );
  await page.screenshot({ path: join(shots, "pdp-zoom-360.png") });
  await page.keyboard.press("Escape");
  await zoom.waitFor({ state: "detached" });
  await page.waitForTimeout(400);
  check((await dotOn(page)) === 2, "closing leaves the gallery on the last image viewed");
  check(phone.errors.length === 0, "no page errors on a phone", phone.errors.join("; "));
  await phone.context.close();

  // Wide: two columns, thumbnails, buy box like the prototype.
  const wide = await shopper({ width: 1280, height: 900 });
  page = wide.page;
  check(!(await page.locator(".gal-dots").isVisible()), "wide screens hide the dots");
  const thumbs = page.locator(".gal-thumbs button");
  check((await thumbs.count()) === 3, "three thumbnails");
  await thumbs.nth(2).click();
  await page.waitForTimeout(600);
  check((await thumbs.nth(2).getAttribute("aria-current")) === "true", "a thumbnail selects it");
  const gal = await page.locator(".gal").boundingBox();
  const buy = await page.locator("#buybox").boundingBox();
  check(
    // The gallery is sticky, so only the columns' sides are compared.
    gal && buy && buy.x >= gal.x + gal.width,
    "two columns",
    JSON.stringify({ gal, buy }),
  );
  check(
    (await page
      .locator(".buy-row")
      .getByRole("button", { name: "Save to saved items" })
      .count()) === 1,
    "the heart sits beside Add to cart",
  );
  check((await page.locator(".assure > div").count()) === 3, "three assurance rows");
  check(
    !/Dubai|demo/i.test(await page.locator("main").innerText()),
    "no Dubai-only or demo copy on the page",
  );
  check((await page.locator("table.specs").count()) <= 1, "specifications as the prototype table");
  check(
    (await page.getByRole("heading", { name: "Reviews", exact: true }).count()) === 1,
    "the reviews section is there",
  );
  await page
    .locator("label", { hasText: /^grape/ })
    .first()
    .click();
  check((await page.locator(".stock:not(.no) > i").count()) === 1, "in stock, with its dot");
  await page.locator(".buy-row").getByRole("button", { name: "Add to cart" }).click();
  await page.getByRole("dialog", { name: /Your cart/ }).waitFor();
  check(true, "adding from the product page opens the cart sheet");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(shots, "pdp-1280.png"), fullPage: true });
  check(wide.errors.length === 0, "no page errors on a wide screen", wide.errors.join("; "));
  await wide.context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
