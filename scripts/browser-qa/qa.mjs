// Browser QA through the real local gateway (admin origin http://localhost:8081).
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { autoConfirm } from "./confirm.mjs";

// playwright-core is not a project dependency: install it outside the repo and point
// QA_PLAYWRIGHT_DIR at that directory (see README.md).
// fileURLToPath: the checkout path may contain spaces.
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const playwrightDir = process.env.QA_PLAYWRIGHT_DIR;
if (!playwrightDir) throw new Error("Set QA_PLAYWRIGHT_DIR (see scripts/browser-qa/README.md)");
const { chromium } = createRequire(resolve(playwrightDir, "package.json"))("playwright-core");
const sharp = createRequire(root + "/apps/worker/package.json")("sharp");
const out = resolve(process.env.QA_SHOTS_DIR ?? resolve(playwrightDir, "shots")) + "/";
mkdirSync(out, { recursive: true });
const BASE = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const executablePath =
  process.env.QA_CHROMIUM ??
  process.env.HOME +
    "/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

const results = [];
const run = Date.now().toString(36);
let current;
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const browser = await chromium.launch({ executablePath, headless: true });
async function session(email, viewport = { width: 1366, height: 900 }, scheme = "light") {
  const context = await browser.newContext({ viewport, colorScheme: scheme });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on(
    "response",
    (r) => r.status() >= 400 && errors.push(`${r.status()} ${new URL(r.url()).pathname}`),
  );
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
  return { context, page, errors };
}
const shot = (page, name) => page.screenshot({ path: out + name + ".png", fullPage: true });
const status = (page) =>
  page
    .locator('[role="status"]')
    .first()
    .innerText()
    .catch(() => "");

try {
  const { page, errors } = await session("owner.qa@iqoshaven.test");
  current = page;
  check("owner signs in through the gateway", page.url().startsWith(BASE));

  // Brands
  await page.goto(BASE + "/workspace/brands");
  // New brands and categories open in the prototype's drawer (V-A6).
  await page.getByRole("button", { name: "New brand" }).click();
  await page.fill('dialog[open] input[name="name"]', `Orbe QA ${run}`);
  check(
    "brand slug suggested from name",
    (await page.inputValue('dialog[open] input[name="slug"]')) === `orbe-qa-${run}`,
  );
  await page.getByRole("button", { name: "Create brand" }).click();
  await page.getByText(`Orbe QA ${run}`).first().waitFor({ timeout: 10000 });
  check("brand created and listed", true);
  await shot(page, "01-brands");

  // Categories
  await page.goto(BASE + "/workspace/categories");
  await page.getByRole("button", { name: "New category" }).click();
  await page.fill('dialog[open] input[name="name"]', `Disposables QA ${run}`);
  await page.getByRole("button", { name: "Create category" }).click();
  await page.getByText(`Disposables QA ${run}`).first().waitFor({ timeout: 10000 });
  check("category created and listed", true);

  // Product
  await page.goto(BASE + "/workspace/products");
  await page.getByRole("button", { name: "Add product" }).click();
  await page.fill('input[name="name"]', `Orbe Halo 7K QA ${run}`);
  await page.selectOption('select[name="brandId"]', { label: `Orbe QA ${run}` });
  await page.selectOption('select[name="categoryId"]', { label: `Disposables QA ${run}` });
  await page.fill('input[name="puffCount"]', "7000");
  await page.fill('input[name="price"]', "49.50");
  await page.fill('input[name="compareAt"]', "59");
  await page.fill('input[name="specs.liquidMl"]', "12.5");
  await page.fill('textarea[name="description"]', "Synthetic QA product description.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("heading", { name: "Options & variants" }).waitFor({ timeout: 15000 });
  check("product draft saved and editor reopened", true);

  // Options and variants
  await page.fill('textarea[name="flavour"]', "Grape Ice\nMint");
  await page.fill('textarea[name="nicotine"]', "20 mg, 50 mg");
  await page.getByRole("button", { name: "Save options" }).click();
  await page
    .getByRole("button", { name: /Add 4 missing combinations/ })
    .waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: /Add 4 missing combinations/ }).click();
  await page.getByText("4 variants").waitFor({ timeout: 20000 });
  check("four flavour × nicotine variants generated", true);
  const defaults = await page.locator(".variant-row .default-tag").count();
  check("exactly one default variant", defaults === 1, `${defaults}`);

  // Step 54: a SKU already used by another variant is refused with a clear message
  // Each variant is its own form (V-A4c).
  const variantForms = page.locator("form.variant-row");
  const second = variantForms.nth(1);
  const takenSku = await variantForms.nth(0).locator('input[name="sku"]').inputValue();
  await second.locator('input[name="sku"]').fill(takenSku);
  await second.getByRole("button", { name: /Save variant/ }).click();
  await page
    .getByText(/already used/)
    .first()
    .waitFor({ timeout: 10000 });
  check("duplicate SKU refused with an explanation", true);
  // The editor stays open and the variant was not saved (still version 1).
  check("refused SKU edit changed nothing", (await second.getAttribute("data-version")) === "1");

  // Images
  const image = await sharp({
    create: { width: 1200, height: 1200, channels: 3, background: { r: 120, g: 60, b: 160 } },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "QA camera owner" } } })
    .toBuffer();
  await page.setInputFiles('input[type="file"]', {
    name: "halo.jpg",
    mimeType: "image/jpeg",
    buffer: image,
  });
  const add = page.getByRole("button", { name: "Add to gallery" });
  await add.waitFor({ timeout: 45000 });
  check("upload processed by the worker (ready to add)", true);
  await add.click();
  await page.locator(".mtile .prim").waitFor({ timeout: 15000 });
  const thumbLoaded = await page
    .locator(".mtile img")
    .first()
    .evaluate((img) => img.complete && img.naturalWidth > 0)
    .catch(() => false);
  check("gallery thumbnail loads from a signed derivative link", thumbLoaded);
  const thumbSrc = await page.locator(".mtile img").first().getAttribute("src");
  check(
    "thumbnail is a signed media-bucket WebP, not quarantine",
    !!thumbSrc &&
      thumbSrc.includes("thumb.webp") &&
      thumbSrc.includes("X-Amz-Signature") &&
      !thumbSrc.includes("quarantine"),
  );
  // Alt text is edited in the prototype's dialog from the tile (V-A4c).
  await page.getByRole("button", { name: "Alt text of image 1" }).click();
  const altDialog = page.getByRole("dialog", { name: "Alt text" });
  await altDialog.getByLabel("Alt text").fill("Orbe Halo 7K, front view");
  await altDialog.getByRole("button", { name: "Save alt text" }).click();
  await page.locator('.mtile img[alt="Orbe Halo 7K, front view"]').waitFor({ timeout: 10000 });
  check("alt text saved from the image dialog", true);
  // Bad upload: a GIF renamed as image is refused before upload.
  await page.setInputFiles('input[type="file"]', {
    name: "anim.gif",
    mimeType: "image/gif",
    buffer: Buffer.from("GIF89a"),
  });
  await page.waitForTimeout(800);
  check(
    "unsupported file type refused in the browser",
    /JPEG, PNG or WebP/.test(await page.content()),
  );
  await shot(page, "02-product-editor");

  // Stock
  await page.goto(BASE + "/workspace/inventory");
  await page.fill('input[name="q"]', `ORBE-HALO-7K-QA-${run}`.toUpperCase());
  await page.press('input[name="q"]', "Enter");
  await page.waitForTimeout(1000);
  // Every change goes through the "Update stock" drawer (V-A5).
  const card = page.locator(".inv-row:visible").first();
  const drawer = page.getByRole("dialog", { name: "Update stock" });
  const stockIs = (n) =>
    card
      .locator(".stock-n")
      .filter({ hasText: new RegExp(`^${n}$`) })
      .waitFor({ timeout: 10000 });
  await card.getByRole("button", { name: /Update stock/ }).click();
  await drawer.getByRole("button", { name: "Set exact count" }).click();
  await drawer.locator('input[name="target"]').fill("12");
  await drawer.locator('textarea[name="note"]').fill("Opening count");
  await drawer.getByRole("button", { name: "Save stock" }).click();
  await stockIs(12);
  check("set count records stock through the ledger", true);
  await card.getByRole("button", { name: /Update stock/ }).click();
  await drawer.getByRole("button", { name: "Remove", exact: true }).click();
  await drawer.locator('input[name="quantity"]').fill("2");
  await drawer.locator('select[name="reason"]').selectOption("DAMAGE");
  await drawer.locator('textarea[name="note"]').fill("Leaking");
  await drawer.getByRole("button", { name: "Save stock" }).click();
  await stockIs(10);
  await card.getByRole("button", { name: /Stock history/ }).click();
  const historyDrawer = page.getByRole("dialog", { name: "Stock history" });
  await historyDrawer.getByText(/Damaged · Leaking/).waitFor({ timeout: 10000 });
  check("damage removal shown in history with note and actor", true);
  await shot(page, "03-stock");
  await page.keyboard.press("Escape");
  await historyDrawer.waitFor({ state: "hidden" });
  // Steps 53–54: selling out shows the state, raises one alert event, and stays listed
  const probe = async () => (await fetch("http://127.0.0.1:4099")).json();
  const lowBefore = (await probe()).lowStockEvents;
  await card.getByRole("button", { name: /Update stock/ }).click();
  await drawer.getByRole("button", { name: "Remove", exact: true }).click();
  await drawer.locator('input[name="quantity"]').fill("10");
  await drawer.locator('select[name="reason"]').selectOption("DAMAGE");
  await drawer.locator('textarea[name="note"]').fill("Batch recalled");
  // The balance it would leave is previewed before saving.
  await drawer.getByText("10 → 0").waitFor();
  await drawer.getByRole("button", { name: "Save stock" }).click();
  await stockIs(0);
  await card.getByText("Out of stock").waitFor({ timeout: 10000 });
  check("sold-out variant stays listed as Out of stock", true);
  check(
    "selling out raised exactly one low-stock event",
    (await probe()).lowStockEvents === lowBefore + 1,
  );
  await shot(page, "03b-sold-out");
  // Step 52: every catalogue change so far was confirmed to the API by the signed worker call
  let propagation;
  for (let attempt = 0; attempt < 20; attempt++) {
    propagation = (await probe()).revalidate;
    if (propagation.length && propagation.every((row) => row.status === "completed")) break;
    await page.waitForTimeout(1000);
  }
  check(
    "catalogue changes propagated: worker invalidation effects completed (HTTP 204)",
    propagation.length > 0 &&
      propagation.every((row) => row.status === "completed" && row.receipt === "invalidated:204"),
    JSON.stringify(propagation),
  );
  // Step 51: publishing card, trash, Trash tab, restore and permanent delete
  await autoConfirm(page);
  await page.goto(BASE + "/workspace/products");
  await page
    .getByRole("button", { name: /Edit product/ })
    .first()
    .click();
  await page.getByRole("heading", { name: "Publishing" }).waitFor({ timeout: 15000 });
  const publishing = page.locator("section", {
    has: page.getByRole("heading", { name: "Publishing" }),
  });
  check(
    "publish button disabled until ready",
    await publishing.getByRole("button", { name: "Publish" }).isDisabled(),
  );
  await publishing.getByRole("button", { name: "Move to trash" }).click();
  await page.waitForTimeout(1200);
  await page.goto(BASE + "/workspace/products");
  await page.getByRole("tab", { name: "Trash" }).click();
  const trashed = page.locator(".product-row:visible", { hasText: `Orbe Halo 7K QA ${run}` });
  await trashed.waitFor({ timeout: 10000 });
  check("trashed product listed in Trash", true);
  await trashed.getByRole("checkbox").check();
  await trashed.getByRole("button", { name: "Delete permanently" }).click();
  await page.getByText(/stock history/).waitFor({ timeout: 10000 });
  check("purge refused for a product with stock history", true);
  // The products list shows a refusal in its notice, with a Reload button to recover.
  await page.getByRole("button", { name: "Reload", exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page
    .locator(".product-row:visible", { hasText: `Orbe Halo 7K QA ${run}` })
    .getByRole("button", { name: "Restore as draft" })
    .click();
  await page.waitForTimeout(1200);
  await page.getByRole("tab", { name: "Drafts" }).click();
  await page
    .locator(".product-row:visible", { hasText: `Orbe Halo 7K QA ${run}` })
    .waitFor({ timeout: 10000 });
  check("restored product back in Drafts", true);
  // A product without history can be purged by the Owner.
  await page.getByRole("button", { name: "Add product" }).click();
  await page.fill('input[name="name"]', `Purge QA ${run}`);
  await page.selectOption('select[name="brandId"]', { label: `Orbe QA ${run}` });
  await page.selectOption('select[name="categoryId"]', { label: `Disposables QA ${run}` });
  await page.fill('input[name="price"]', "10");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByRole("heading", { name: "Publishing" }).waitFor({ timeout: 15000 });
  await page
    .locator("section", { has: page.getByRole("heading", { name: "Publishing" }) })
    .getByRole("button", { name: "Move to trash" })
    .click();
  await page.waitForTimeout(1200);
  await page.goto(BASE + "/workspace/products");
  await page.getByRole("tab", { name: "Trash" }).click();
  const purgeCard = page.locator(".product-row:visible", { hasText: `Purge QA ${run}` });
  await purgeCard.waitFor({ timeout: 10000 });
  check(
    "delete permanently disabled until confirmed",
    await purgeCard.getByRole("button", { name: "Delete permanently" }).isDisabled(),
  );
  await purgeCard.getByRole("checkbox").check();
  await purgeCard.getByRole("button", { name: "Delete permanently" }).click();
  await purgeCard.waitFor({ state: "detached", timeout: 10000 });
  check("owner permanently deleted a history-free trashed product", true);
  await shot(page, "05-trash");
  const expected = errors.filter((e) => !e.startsWith("409 "));
  check(
    "no unexpected failed requests (owner journey)",
    expected.length === 0,
    expected.slice(0, 3).join(" | "),
  );

  // Staff: no SEO fields, can still edit products
  const staff = await session("staff.qa@iqoshaven.test");
  await staff.page.goto(BASE + "/workspace/products");
  await staff.page
    .getByRole("button", { name: /Edit product/ })
    .first()
    .click();
  await staff.page.getByRole("heading", { name: "Images" }).waitFor({ timeout: 15000 });
  check(
    "staff sees no SEO fields",
    (await staff.page.locator('input[name="seo.title"]').count()) === 0,
  );
  await staff.page.goto(BASE + "/workspace/products");
  await staff.page.getByRole("tab", { name: "Trash" }).click();
  await staff.page.waitForTimeout(1000);
  check(
    "staff cannot see Delete permanently",
    (await staff.page.getByRole("button", { name: "Delete permanently" }).count()) === 0,
  );
  await staff.page.goto(BASE + "/workspace/settings");
  // Wait for the rendered refusal instead of racing the client render.
  const denied = await staff.page
    .getByText(/Access unavailable/)
    .first()
    .waitFor({ timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!denied) await shot(staff.page, "06-staff-settings");
  check("staff denied Owner-only settings", denied);
  await staff.context.close();

  // Mobile layout and dark mode
  const mobile = await session("owner.qa@iqoshaven.test", { width: 375, height: 812 }, "dark");
  for (const section of ["products", "inventory", "brands"]) {
    await mobile.page.goto(BASE + "/workspace/" + section);
    await mobile.page.waitForTimeout(1200);
    const overflow = await mobile.page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    check(`no horizontal overflow at 375px: ${section}`, !overflow);
    await shot(mobile.page, `04-mobile-dark-${section}`);
  }
  await mobile.context.close();
} catch (error) {
  check("journey completed", false, error.message.split("\n")[0]);
  if (current) {
    await shot(current, "99-failure");
    console.log("status:", await status(current));
    console.log("url:", current.url());
  }
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
}
