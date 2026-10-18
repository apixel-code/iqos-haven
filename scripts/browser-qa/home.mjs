// Browser pass of the home page with published content (step 99) against the real stack:
//   pnpm build && node scripts/check-gate-e2e.cjs --serve &      (prints SERVING and SCHEMA)
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/home.mjs <SERVING> <shots dir> <SCHEMA>
// Content is published with the real storage commands on the served schema; the API cache is
// cleared through the gateway's own invalidation (a content save drops it) by waiting out the
// TTL only when needed. Afterwards stop the served stack.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");
const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const fromApi = createRequire(join(root, "apps/api/package.json"));
const config = fromApi("@ih/config");
const { createDatabase, createPool, publishContentSection, saveContentDraft } = fromApi("@ih/db");
const [base, shots, schema] = process.argv.slice(2);
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? ""))
  throw new Error("usage: <SERVING> <shots> <SCHEMA>");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-home",
  searchPath: schema,
});
const db = createDatabase(pool, { schema });
let failed = 0;
const check = (ok, name, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
};
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];

const owner = await one(
  "SELECT s.id FROM staff_users s JOIN roles r ON r.id=s.role_id WHERE r.key='owner' LIMIT 1",
);
const as = () => ({ requestId: randomUUID(), actorId: owner.id });
const product = await one(
  "SELECT id, brand_id AS \"brandId\" FROM products WHERE slug='gatecheck-halo'",
);
async function publish(key, content) {
  const current = await one("SELECT version FROM content_sections WHERE key=$1", [key]);
  const saved = await saveContentDraft(db, as(), key, {
    expectedVersion: current?.version ?? 0,
    content,
  });
  await publishContentSection(db, as(), key, saved.version);
}
await publish("ticker", {
  enabled: true,
  messages: [
    "Cash on delivery across the UAE",
    "Questions? Chat with us on WhatsApp",
    "New flavours every week",
  ],
});
await publish("hero", {
  slides: [
    {
      style: "navy",
      eyebrow: "UAE-wide delivery",
      title: "Premium vapes, delivered across the UAE.",
      subtitle: "Disposables and pod kits from leading brands. Pay cash when it arrives.",
      cta: { label: "Shop now", link: { kind: "shop" } },
      secondaryCta: { label: "Browse brands", link: { kind: "shop" } },
      image: null,
    },
    {
      style: "lilac",
      eyebrow: "New arrival",
      title: "Fresh flavours this week.",
      subtitle: null,
      cta: { label: "See what's new", link: { kind: "shop" } },
      secondaryCta: null,
      image: null,
    },
  ],
});
await publish("featured", { productIds: [product.id] });
await publish("best_sellers", { mode: "manual", productIds: [product.id] });
await publish("brands", { brandIds: [product.brandId] });
await publish("campaign_banner", {
  banners: [
    {
      enabled: true,
      title: "Pod kits for every day",
      subtitle: "Refillable kits from leading brands.",
      cta: { label: "Shop kits", link: { kind: "product", productId: product.id } },
      image: null,
    },
  ],
});
await publish("offers", { enabled: true, title: "This week's offers", productIds: [product.id] });

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
try {
  for (const [label, viewport, motion] of [
    ["360", { width: 360, height: 780 }, "no-preference"],
    ["1280", { width: 1280, height: 900 }, "no-preference"],
    ["360-reduced", { width: 360, height: 780 }, "reduce"],
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: motion });
    await context.request.post(base + "/api/age/accept", {
      headers: { origin: "https://shop.gate-check.test" },
      form: { return: "/" },
      maxRedirects: 0,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // The API caches the home for up to 60 s; publishing above cleared nothing in that process.
    let found = false;
    for (let n = 0; n < 15 && !found; n++) {
      await page.goto(base + "/");
      found =
        (await page
          .getByRole("heading", { name: "Premium vapes, delivered across the UAE." })
          .count()) > 0;
      if (!found) await new Promise((done) => setTimeout(done, 5000));
    }
    check(found, `${label}: published hero shown`);
    // The hero carousel (ADR 0097): two slides, dots, arrows, pause, reduced motion.
    const dot = (n) => page.getByRole("button", { name: `Slide ${n}`, exact: true });
    const onSlide = async (n) => (await dot(n).getAttribute("aria-current")) === "true";
    if (label === "1280") {
      await page.getByRole("button", { name: "Pause slides" }).click();
      check(
        (await page.getByRole("button", { name: "Play slides" }).count()) === 1,
        "1280: the carousel can be paused",
      );
      await page.getByRole("button", { name: "Next slide" }).click();
      await page.waitForTimeout(1000);
      check(await onSlide(2), "1280: Next slide shows the second slide");
      await dot(1).click();
      await page.waitForTimeout(1000);
      check(await onSlide(1), "1280: a dot goes back to its slide");
    } else if (label === "360") {
      await page.waitForTimeout(6500);
      check(await onSlide(2), "360: the carousel advances by itself");
    } else {
      await page.waitForTimeout(6500);
      check(await onSlide(1), "360-reduced: with reduced motion it does not move by itself");
    }
    check(
      await page.getByRole("region", { name: "Current offers" }).isVisible(),
      `${label}: promotional bar shown`,
    );
    check(
      await page.getByRole("heading", { name: "Pod kits for every day" }).isVisible(),
      `${label}: campaign banner shown`,
    );
    check(
      await page.getByRole("heading", { name: "This week's offers" }).isVisible(),
      `${label}: offers shown`,
    );
    const moving = await page
      .locator(".promo-track")
      .evaluate((node) => getComputedStyle(node).animationName);
    check(
      motion === "reduce" ? moving === "none" : moving === "ticker",
      `${label}: ticker motion follows the preference`,
      moving,
    );
    if (motion !== "reduce") {
      await page.getByRole("button", { name: "Pause offers ticker" }).click();
      const state = await page
        .locator(".promo-track")
        .evaluate((node) => getComputedStyle(node).animationPlayState);
      check(state === "paused", `${label}: the pause button stops the ticker`, state);
    }
    check(
      !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
      `${label}: no horizontal scroll`,
    );
    check(errors.length === 0, `${label}: no page errors`, errors.join("; "));
    await page.screenshot({ path: join(shots, `home-${label}.png`), fullPage: true });
    await context.close();
  }
} finally {
  await browser.close();
  await db.$disconnect();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
