// Browser QA for flavour pictures (ADR 0107): choosing a flavour on the product page brings its
// picture into view, at phone and desktop width, and the added-to-cart toast shows it.
//   pnpm build && node scripts/check-gate-e2e.cjs --serve --checkout-open   (prints SERVING, SCHEMA)
//   QA_PLAYWRIGHT_DIR=<dir with playwright-core> node scripts/browser-qa/flavour-pictures.mjs <SERVING> <shots dir> <SCHEMA>
// Seeds three pictures (general, grape, mint) on the served stack's Gatecheck Halo, then waits
// out the store cache (60 s). The picture files do not exist; the checks read alt text and links.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");

const [base, shots, schema] = process.argv.slice(2);
if (!base || !shots || !/^ih_test_[0-9a-f]{32}$/.test(schema ?? ""))
  throw new Error("usage: <SERVING> <shots> <SCHEMA>");
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
    .pop();
let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
};

// Seed: a general primary picture, then one per flavour, through the same rows the gallery writes.
const product = sql("SELECT id FROM products WHERE slug='gatecheck-halo'");
const staff = sql("SELECT id FROM staff_users ORDER BY created_at LIMIT 1");
sql(`DELETE FROM product_images WHERE product_id='${product}'`);
const assets = {};
for (const [index, flavour] of ["", "grape", "mint"].entries()) {
  const variant = flavour
    ? `(SELECT id FROM variants WHERE product_id='${product}' AND attributes->>'flavour'='${flavour}')`
    : "NULL";
  const alt = flavour ? `${flavour} pack` : "Gatecheck Halo";
  const asset = sql("SELECT gen_random_uuid()");
  const keys = (name) => `products/${product}/${asset}/${name}.webp`;
  sql(`INSERT INTO media_assets (id, product_id, uploaded_by, quarantine_key, declared_type,
      declared_bytes, state, observed_bytes, width, height, sha256, derivative_keys,
      upload_expires_at)
    VALUES ('${asset}', '${product}', '${staff}', 'uploads/${asset}', 'image/jpeg', 10, 'ready',
      10, 1200, 900, repeat('a', 64),
      jsonb_build_object('large', '${keys("large")}', 'medium', '${keys("medium")}',
        'thumb', '${keys("thumb")}'),
      statement_timestamp())`);
  sql(`INSERT INTO product_images (product_id, media_asset_id, asset_key, is_primary, sort_order,
      alt, width, height, mime, variant_id)
    VALUES ('${product}', '${asset}', '${keys("large")}', ${index === 0}, ${index}, '${alt}',
      1200, 900, 'image/webp', ${variant})`);
  assets[flavour || "main"] = asset;
}
console.log("seeded 3 pictures; waiting for the store cache");
await new Promise((done) => setTimeout(done, 62_000));

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

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  const label = `${viewport.width}px`;
  const context = await browser.newContext({ viewport });
  await context.request.post(base + "/api/age/accept", {
    headers: { origin: "https://shop.gate-check.test" },
    form: { return: "/" },
    maxRedirects: 0,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/p/gatecheck-halo");
  const shown = async () => {
    await page.waitForTimeout(900);
    return page.locator('.gal-slide[aria-hidden="false"] img').getAttribute("alt");
  };
  check((await shown()) === "Gatecheck Halo", `${label}: opens on the main picture`);
  const choose = (flavour) =>
    page
      .locator(".buy label", { hasText: new RegExp(`^${flavour}`) })
      .first()
      .click();
  await choose("mint");
  check((await shown()) === "mint pack", `${label}: choosing mint shows the mint pack`);
  await page.screenshot({ path: join(shots, `flavour-mint-${viewport.width}.png`) });
  await choose("grape");
  check((await shown()) === "grape pack", `${label}: choosing grape shows the grape pack`);
  await page.getByRole("button", { name: "Add to cart" }).first().click();
  const toast = page.locator(".toast img");
  await toast.waitFor();
  check(
    ((await toast.getAttribute("src")) ?? "").includes(`/${assets.grape}/thumb.webp`),
    `${label}: the toast shows the grape pack`,
  );
  check(errors.length === 0, `${label}: no page errors`, errors.join("; "));
  await context.close();
}

await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all flavour picture checks passed");
process.exit(failed ? 1 : 0);
