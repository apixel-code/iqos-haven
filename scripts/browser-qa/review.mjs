// Browser pass of the review link page (step 94) against the real stack, after checkout.mjs has
// placed its orders on the same served schema:
//   QA_PLAYWRIGHT_DIR=<dir with playwright-core> node scripts/browser-qa/review.mjs <SERVING> <shots dir> <SCHEMA>
// The newest order is taken to Delivered and given a review link with the real database commands
// (built `@ih/db`), on the served schema of the test database only.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(join(process.env.QA_PLAYWRIGHT_DIR ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright-core");
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fromApi = createRequire(join(root, "apps/api/package.json"));
const config = fromApi("@ih/config");
const { createDatabase, createPool, issueReviewLink, transitionOrder } = fromApi("@ih/db");

const [base, shots, schema] = process.argv.slice(2);
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? ""))
  throw new Error("usage: <SERVING> <shots> <SCHEMA>");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-review-qa",
  searchPath: schema,
});
const db = createDatabase(pool, { schema });
/** First value of the first row. */
const sql = async (statement, params = []) => {
  const { rows } = await pool.query(statement, params);
  return rows[0] ? String(Object.values(rows[0])[0]) : null;
};
const cache = join(homedir(), "Library/Caches/ms-playwright");
const dir = readdirSync(cache).find((name) => /^chromium-\d+$/.test(name));
const sub = readdirSync(join(cache, dir)).find((name) => name.startsWith("chrome-"));
const executablePath = join(
  cache,
  dir,
  sub,
  "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
let passed = 0;
let failed = 0;
const check = (ok, name, detail = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : " — " + detail}`);
};

// A Delivered order with a live link, through the same commands staff use.
const orderId = await sql("SELECT id FROM orders ORDER BY created_at DESC LIMIT 1");
const ownerId = await sql(
  "SELECT s.id FROM staff_users s JOIN roles r ON r.id=s.role_id WHERE r.key='owner' ORDER BY s.created_at LIMIT 1",
);
const command = { requestId: randomUUID(), actorId: ownerId };
const NEXT = {
  pending: "confirmed",
  confirmed: "processing",
  processing: "out_for_delivery",
  out_for_delivery: "delivered",
};
for (;;) {
  const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!NEXT[order.status]) break;
  await transitionOrder(db, command, orderId, {
    to: NEXT[order.status],
    expectedVersion: order.version,
    commandId: randomUUID(),
  });
}
check(
  (await sql("SELECT status FROM orders WHERE id=$1", [orderId])) === "delivered",
  "order is Delivered",
);
await pool.query(
  `INSERT INTO settings (key, value, updated_by) VALUES ('store', $1, $2)
   ON CONFLICT (key) DO UPDATE SET value = settings.value || $1`,
  [JSON.stringify({ name: "Iqos Haven", domain: "shop.gate-check.test" }), ownerId],
);
const { link } = await issueReviewLink(db, command, orderId);
const token = link.slice(link.indexOf("#") + 1);
const productName = await sql(
  `SELECT p.name FROM order_items i JOIN products p ON p.id=i.product_id
   WHERE i.order_id=$1 ORDER BY p.id LIMIT 1`,
  [orderId],
);

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
const page = await context.newPage();
const api = [];
page.on("request", (request) => {
  if (request.url().includes("/api/v1/store/reviews"))
    api.push({ url: request.url(), referer: request.headers().referer ?? null });
});
// The served storefront accepts the age answer only from its https origin (see checkout.mjs).
await context.request.post(base + "/api/age/accept", {
  headers: { origin: "https://shop.gate-check.test" },
  form: { return: "/review" },
  maxRedirects: 0,
});

// The server-rendered frame names no product: the products come from the API in the browser.
const frame = await context.request.get(base + "/review");
check(
  frame.status() === 200 && !(await frame.text()).includes(productName),
  "the page's HTML holds no product data",
);

await page.goto(base + "/review#" + token);
await page.getByRole("heading", { name: "Review your order" }).waitFor();
check(!page.url().includes("#") && !page.url().includes(token), "the token leaves the address bar");
check(
  await page.getByRole("heading", { name: productName }).isVisible(),
  "the product to review is named",
);
const text = await page.locator("main").innerText();
check(!/IH-\d|AED|Cash on delivery/.test(text), "nothing about the order is shown");
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > window.innerWidth,
);
check(!overflow, "no horizontal scroll at 360px");
await page.screenshot({ path: join(shots, "review-360.png"), fullPage: true });

// An empty send: every message, nothing sent.
const before = api.length;
await page.getByRole("button", { name: "Send review" }).click();
check(
  (await page.locator("[id$='-error']").count()) === 4 && api.length === before,
  "an empty review shows four messages and sends nothing",
);
await page.screenshot({ path: join(shots, "review-errors-360.png"), fullPage: true });

await page.locator("label", { hasText: "4 stars" }).click();
await page.getByLabel("Title").fill("  Smooth   draw ");
await page.getByLabel("Your review").fill("Flavour lasted the whole week.\n\n\n\nWould buy again.");
await page.getByLabel("Name to show").fill("Q. A.");
await page.getByRole("button", { name: "Send review" }).click();
await page.getByText("Thank you", { exact: false }).first().waitFor();
check(true, "the review is acknowledged");
const stored = await sql(
  `SELECT status || '|' || rating || '|' || title || '|' || author_name FROM reviews WHERE order_id=$1`,
  [orderId],
);
check(stored === "pending|4|Smooth draw|Q. A.", "the review is stored pending, as written", stored);
check(
  api.every((request) => !request.url.includes(token) && !request.referer),
  "the token never appears in an API URL, and no Referer is sent",
  JSON.stringify(api),
);
const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
check(!storage.includes(token), "the token is not in device storage");
await page.screenshot({ path: join(shots, "review-sent-360.png"), fullPage: true });

// The worker tells moderators (the served stack runs the notification consumer).
let noted = "";
for (let n = 0; n < 20 && !noted; n++) {
  noted =
    (await sql("SELECT title FROM notifications WHERE type='review.submitted' LIMIT 1")) ?? "";
  if (!noted) await new Promise((done) => setTimeout(done, 500));
}
check(noted === "New review: " + productName, "moderators get an inbox notification", noted);

// A reload has no token left; the same link again has nothing left to review.
await page.reload();
await page.getByRole("heading", { name: "This review link can't be used" }).waitFor();
check(true, "a reload asks for the link from the message");
await page.goto(base + "/review#" + token);
await page.getByRole("heading", { name: "This review link can't be used" }).waitFor();
check(true, "a used-up link says it can't be used");
check(
  (await sql("SELECT count(*) FROM reviews WHERE order_id=$1", [orderId])) === "1",
  "still exactly one review",
);
await browser.close();
await db.$disconnect();
await pool.end();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
