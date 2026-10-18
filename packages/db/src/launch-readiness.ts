import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Prisma, type Database } from "./client";

/** The migrations this build ships (`prisma/migrations/<name>/`), oldest first. */
export function shippedMigrations(): string[] {
  return readdirSync(join(__dirname, "..", "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Read-only facts for the launch check (roadmap step 124, ADR 0095). Counts only: no names,
 * emails or other personal data leave this function.
 */
export interface LaunchFacts {
  /** Applied migration names, or null when this role cannot read the history. */
  migrations: { applied: string[]; unfinished: number } | null;
  activeOwners: number;
  /** Active or not: addresses on reserved test domains (QA, demo and fixture accounts). */
  testAccounts: number;
  settings: {
    store: { name: string; domain: string } | null;
    contact: { email: string | null; phone: string | null } | null;
    whatsappNumber: string | null;
    newOrderEmail: boolean;
    seoIndexing: string | null;
    delivery: { flatFeeFils: number; etaText: string } | null;
  };
  activeAreas: number;
  publishedProducts: number;
  publishedWithoutActiveOption: number;
  publishedWithoutImage: number;
  publishedSoldOut: number;
  /** Variants whose stock differs from the sum of their ledger movements. */
  ledgerMismatches: number;
  demoCoupons: number;
  /** Products, brands or categories whose slug marks them as fixtures (gatecheck, qa, test). */
  fixtureCatalogue: number;
  deadEffects: number;
}

/** Reserved for documentation and testing (RFC 2606/6761). */
const TEST_DOMAIN = String.raw`@([a-z0-9-]+\.)*(test|invalid|example|localhost)$|@example\.(com|net|org)$`;
/** Prototype demo coupon codes (step 100), never valid in production. */
const DEMO_COUPONS = ["HAVEN10", "SAVE20", "VEKTOR15", "BIGBOX15"];
const FIXTURE_SLUG = String.raw`^(gatecheck|qa|test|synthetic|fixture)(-|$)`;

async function count(db: Database, query: Prisma.Sql) {
  const rows = await db.$queryRaw<Array<{ n: number }>>(query);
  return rows[0]?.n ?? 0;
}

async function setting(db: Database, key: string) {
  const rows = await db.$queryRaw<Array<{ value: unknown }>>(Prisma.sql`
    SELECT value FROM settings WHERE key = ${key}`);
  const value = rows[0]?.value;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

/** Options whose stock differs from the sum of their ledger movements (launch check, monitor). */
export function ledgerMismatchCount(db: Database) {
  return count(
    db,
    Prisma.sql`SELECT count(*)::int AS n FROM variants v
      WHERE v.stock_on_hand <> coalesce((SELECT sum(m.delta) FROM stock_movements m
        WHERE m.variant_id = v.id), 0)`,
  );
}

export async function launchFacts(db: Database): Promise<LaunchFacts> {
  let migrations: LaunchFacts["migrations"] = null;
  const [history] = await db.$queryRaw<Array<{ readable: boolean }>>(Prisma.sql`
    SELECT coalesce(to_regclass('_prisma_migrations') IS NOT NULL
      AND has_table_privilege(to_regclass('_prisma_migrations'), 'SELECT'), false) AS readable`);
  if (history?.readable) {
    const rows = await db.$queryRaw<
      Array<{ name: string; finished: boolean; rolledBack: boolean }>
    >(Prisma.sql`SELECT migration_name AS name, finished_at IS NOT NULL AS finished,
        rolled_back_at IS NOT NULL AS "rolledBack" FROM _prisma_migrations`);
    migrations = {
      applied: rows.filter((row) => row.finished && !row.rolledBack).map((row) => row.name),
      unfinished: rows.filter((row) => !row.finished && !row.rolledBack).length,
    };
  }
  const store = await setting(db, "store");
  const contact = await setting(db, "contact");
  const whatsapp = await setting(db, "whatsapp");
  const notifications = await setting(db, "notifications");
  const seo = await setting(db, "seo");
  const delivery = await setting(db, "delivery");
  const newOrder = notifications?.newOrderEmail as { enabled?: unknown } | undefined;
  const published = Prisma.sql`p.status = 'published' AND p.deleted_at IS NULL`;
  return {
    migrations,
    activeOwners: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM staff_users u JOIN roles r ON r.id = u.role_id
        WHERE r.key = 'owner' AND u.active`,
    ),
    testAccounts: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM staff_users WHERE lower(email) ~ ${TEST_DOMAIN}`,
    ),
    settings: {
      store:
        text(store?.name) && text(store?.domain)
          ? { name: String(store!.name), domain: String(store!.domain) }
          : null,
      contact: contact ? { email: text(contact.email), phone: text(contact.phone) } : null,
      whatsappNumber: text(whatsapp?.number),
      newOrderEmail: newOrder?.enabled === true,
      seoIndexing: text(seo?.indexing),
      delivery:
        delivery && typeof delivery.flatFeeFils === "number" && text(delivery.etaText)
          ? { flatFeeFils: delivery.flatFeeFils, etaText: String(delivery.etaText) }
          : null,
    },
    activeAreas: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM delivery_areas WHERE active`,
    ),
    publishedProducts: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM products p WHERE ${published}`,
    ),
    publishedWithoutActiveOption: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM products p WHERE ${published}
        AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.active)`,
    ),
    publishedWithoutImage: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM products p WHERE ${published}
        AND NOT EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)`,
    ),
    publishedSoldOut: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM products p WHERE ${published}
        AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.active
          AND v.stock_on_hand > 0)`,
    ),
    ledgerMismatches: await ledgerMismatchCount(db),
    demoCoupons: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM coupons
        WHERE upper(code) IN (${Prisma.join(DEMO_COUPONS)})`,
    ),
    fixtureCatalogue: await count(
      db,
      Prisma.sql`SELECT (
        (SELECT count(*) FROM products WHERE slug ~ ${FIXTURE_SLUG})
        + (SELECT count(*) FROM brands WHERE slug ~ ${FIXTURE_SLUG})
        + (SELECT count(*) FROM categories WHERE slug ~ ${FIXTURE_SLUG}))::int AS n`,
    ),
    deadEffects: await count(
      db,
      Prisma.sql`SELECT count(*)::int AS n FROM consumer_effects WHERE status = 'dead'`,
    ),
  };
}
