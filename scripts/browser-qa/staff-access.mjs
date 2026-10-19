// Browser pass of pending invitations and the Owner-sent password reset (parity G-A11, ADR 0094)
// through the real gateway, on the schema served by qa-server.cjs started with invitation and
// reset keys (see README.md):
//   QA_PLAYWRIGHT_DIR=<dir> node scripts/browser-qa/staff-access.mjs <SCHEMA>
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { autoConfirm } from "./confirm.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const playwrightDir = process.env.QA_PLAYWRIGHT_DIR;
if (!playwrightDir) throw new Error("Set QA_PLAYWRIGHT_DIR (see scripts/browser-qa/README.md)");
const { chromium } = createRequire(resolve(playwrightDir, "package.json"))("playwright-core");
const schema = process.argv[2];
if (!/^ih_test_[0-9a-f]{32}$/.test(schema ?? "")) throw new Error("usage: <SCHEMA>");
const fromApi = createRequire(root + "/apps/api/package.json");
const config = fromApi("@ih/config");
const { createPool } = fromApi("@ih/db");
process.chdir(root);
config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
const pool = createPool({
  connectionString: DATABASE_TEST_URL,
  applicationName: "ih-qa-staff-access",
  searchPath: schema,
});
const out = resolve(process.env.QA_SHOTS_DIR ?? resolve(playwrightDir, "shots")) + "/";
mkdirSync(out, { recursive: true });
const BASE = "http://localhost:8081";
const PASSWORD = "copper-lantern-river-71";
const executablePath =
  process.env.QA_CHROMIUM ??
  process.env.HOME +
    "/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
let failed = 0;
const check = (ok, name, detail = "") => {
  if (typeof name !== "string") throw new Error("check(ok, name): name must be text");
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? " — " + detail : ""}`);
};
const tag = Math.random().toString(36).slice(2, 7);
const email = `invitee.${tag}@iqoshaven.test`;
const pendingRow = async () =>
  (
    await pool.query(
      "SELECT id FROM staff_invitation_tokens WHERE email=$1 AND accepted_at IS NULL AND revoked_at IS NULL",
      [email],
    )
  ).rows[0];

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await autoConfirm(page);
  await page.goto(BASE + "/login");
  await page.fill('input[name="email"]', "owner.qa@iqoshaven.test");
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 });
  await page.goto(BASE + "/workspace/staff");
  const pendingCard = page.locator("section.management-card", {
    has: page.getByRole("heading", { name: "Pending invitations" }),
  });
  await pendingCard.waitFor();

  // Invite: it appears in the pending list with its expiry.
  const form = page.locator("section.management-card", {
    has: page.getByRole("heading", { name: "Invite a team member" }),
  });
  await form.getByLabel(/Full name/).fill("Invitee " + tag);
  await form.getByLabel(/Email/).fill(email);
  await form.getByRole("button", { name: "Queue invitation" }).click();
  const row = pendingCard.locator("article.record-card", { hasText: email });
  await row.waitFor({ timeout: 10000 });
  const text = await row.innerText();
  check(
    /Pending/.test(text) && /expires/.test(text) && /by Owner QA/.test(text),
    "a new invitation is listed as pending with its expiry and inviter",
    text,
  );
  check(Boolean(await pendingRow()), "the invitation is pending in the database");
  await page.screenshot({ path: out + "staff-access-pending.png", fullPage: true });

  // Revoke it from the list.
  await row.getByRole("button", { name: "Revoke invitation" }).click();
  await row.waitFor({ state: "detached", timeout: 10000 });
  check(!(await pendingRow()), "Revoke invitation removes it from the list and the database");

  // Send a reset link to the staff account.
  const before = (
    await pool.query(
      "SELECT count(*)::int AS n FROM password_reset_tokens r JOIN staff_users u ON u.id=r.user_id WHERE u.email='staff.qa@iqoshaven.test'",
    )
  ).rows[0].n;
  const staffCard = page.locator("article.record-card", {
    has: page.getByRole("heading", { name: "Staff QA" }),
  });
  await staffCard.getByRole("button", { name: "Send password reset" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Password reset link queued for staff.qa@iqoshaven.test" })
    .waitFor({ timeout: 10000 });
  const after = (
    await pool.query(
      "SELECT count(*)::int AS n FROM password_reset_tokens r JOIN staff_users u ON u.id=r.user_id WHERE u.email='staff.qa@iqoshaven.test'",
    )
  ).rows[0].n;
  check(after === before + 1, "Send password reset issues one link", `${before} → ${after}`);
  check(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    "no sideways scrolling",
  );
  await page.screenshot({ path: out + "staff-access-reset.png", fullPage: true });
  check(errors.length === 0, "no page errors", errors.join("; "));
  await context.close();
} finally {
  await browser.close();
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
