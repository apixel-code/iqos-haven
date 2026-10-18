import type { LaunchFacts } from "@ih/db";

/**
 * Launch readiness (roadmap step 124, ADR 0095). The catalogue, settings and staff are entered
 * through the admin (BI-10, BI-11), so instead of import commands this validates what was
 * entered before the store opens. FAIL blocks the launch; WARN needs a conscious decision.
 * Results carry counts and names of settings only, never personal data.
 */
export type LaunchLevel = "PASS" | "WARN" | "FAIL";
export interface LaunchResult {
  readonly level: LaunchLevel;
  readonly name: string;
  readonly detail?: string;
}

const RESERVED_DOMAIN = /(^|\.)(test|invalid|example|localhost)$|^example\.(com|net|org)$/;

export function evaluateLaunch(facts: LaunchFacts, shipped: readonly string[]): LaunchResult[] {
  const results: LaunchResult[] = [];
  const add = (ok: boolean, name: string, detail: string, failLevel: LaunchLevel = "FAIL") =>
    results.push(ok ? { level: "PASS", name } : { level: failLevel, name, detail });

  if (!facts.migrations)
    results.push({
      level: "WARN",
      name: "migrations are all applied",
      detail: "this role cannot read the migration history; run the check as the migration role",
    });
  else {
    const applied = new Set(facts.migrations.applied);
    const missing = shipped.filter((name) => !applied.has(name));
    add(
      missing.length === 0 && facts.migrations.unfinished === 0,
      "migrations are all applied",
      `${missing.length} not applied${missing.length ? ` (first: ${missing[0]})` : ""}, ${facts.migrations.unfinished} unfinished`,
    );
  }
  add(facts.activeOwners >= 1, "an active Owner exists", "run pnpm bootstrap:owner");
  add(
    facts.testAccounts === 0,
    "no staff account on a test domain",
    `${facts.testAccounts} account(s) on .test/.invalid/.example/localhost addresses`,
  );

  const { settings } = facts;
  add(
    settings.store !== null && !RESERVED_DOMAIN.test(settings.store.domain),
    "store name and domain are set",
    settings.store ? `domain ${settings.store.domain} is reserved` : "Settings → Store is empty",
  );
  add(
    Boolean(settings.contact?.email || settings.contact?.phone),
    "a contact email or phone is set",
    "Settings → Contact has neither",
  );
  add(
    settings.whatsappNumber !== null,
    "the WhatsApp number is set (BI-09)",
    "Settings → WhatsApp has no number",
  );
  add(
    settings.delivery !== null,
    "the delivery fee and promise are set",
    "Delivery → charge is not configured",
  );
  add(facts.activeAreas >= 1, "at least one delivery area is active", "no active area");

  add(facts.publishedProducts >= 1, "at least one product is published", "nothing published");
  add(
    facts.publishedWithoutActiveOption === 0,
    "every published product has an active option",
    `${facts.publishedWithoutActiveOption} published product(s) without one`,
  );
  add(
    facts.publishedWithoutImage === 0,
    "every published product has an image",
    `${facts.publishedWithoutImage} published product(s) without one`,
  );
  add(
    facts.ledgerMismatches === 0,
    "stock matches the stock ledger",
    `${facts.ledgerMismatches} option(s) differ from their movements`,
  );
  add(
    facts.demoCoupons === 0,
    "no prototype demo coupon codes",
    `${facts.demoCoupons} demo code(s)`,
  );
  add(
    facts.fixtureCatalogue === 0,
    "no fixture catalogue records",
    `${facts.fixtureCatalogue} product/brand/category slug(s) start with gatecheck/qa/test/synthetic/fixture`,
  );

  add(
    facts.publishedSoldOut === 0,
    "published products have stock",
    `${facts.publishedSoldOut} published product(s) are sold out (they stay listed)`,
    "WARN",
  );
  add(
    settings.newOrderEmail,
    "new-order email alerts are on",
    "Settings → Notifications: new orders reach staff only in the admin",
    "WARN",
  );
  add(
    settings.seoIndexing === "public_pages",
    "search indexing is open (BI-05)",
    "SEO policy is closed: search engines are asked not to index the store",
    "WARN",
  );
  add(
    facts.deadEffects === 0,
    "no dead background effects",
    `${facts.deadEffects} effect(s) gave up; see the queue recovery runbook`,
    "WARN",
  );
  return results;
}

export function formatLaunch(results: readonly LaunchResult[]) {
  const lines = results.map(
    (result) => `${result.level} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`,
  );
  const fails = results.filter((result) => result.level === "FAIL").length;
  const warns = results.filter((result) => result.level === "WARN").length;
  lines.push(
    fails
      ? `Not ready: ${fails} blocking, ${warns} to review.`
      : `Ready to launch${warns ? `, with ${warns} to review` : ""}.`,
  );
  return { text: lines.join("\n"), exitCode: fails ? 1 : 0 };
}
