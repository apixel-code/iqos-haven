import { toAuditEntry, type CommandContext } from "@ih/application";
import {
  defineEvent,
  seoIssuesResponseSchema,
  seoOverviewSchema,
  seoPolicySchema,
  seoPolicyWriteRequestSchema,
  SEO_ISSUE_KINDS,
  type SeoIssuesResponse,
  type SeoOverview,
  type SeoPolicy,
  type SeoPolicyWriteRequest,
} from "@ih/contracts";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaOutboxWriter } from "./outbox";
import { withTransaction } from "./transaction";

/**
 * SEO policy, overview and issue report (roadmap step 113, ADR 0079). The policy lives in the
 * `seo` settings row; no row (or anything unreadable) means `closed`, so a fault never opens the
 * store to crawlers.
 */
export class SeoForbiddenError extends Error {}
export class SeoConflictError extends Error {}
const CLOSED: SeoPolicy = { indexing: "closed" };
/** Recommended maximum lengths (what search results usually show). */
export const SEO_LIMITS = { title: 60, description: 160 } as const;

async function policyRow(db: Database | Tx) {
  const [row] = await db.$queryRaw<Array<{ value: unknown; version: number; updatedAt: Date }>>(
    Prisma.sql`SELECT value, version, updated_at AS "updatedAt" FROM settings WHERE key='seo'`,
  );
  const parsed = seoPolicySchema.safeParse(row?.value);
  return {
    policy: parsed.success ? parsed.data : CLOSED,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** The policy the public storefront applies (robots, sitemap, policy pages). */
export async function readPublicSeoPolicy(db: Database): Promise<SeoPolicy> {
  return (await policyRow(db)).policy;
}

async function requireRight(
  db: Database | Tx,
  actorId: string | null,
  key: "seo.write" | "seo.reports",
) {
  try {
    await lockCatalogueActor(db, actorId, [key], false);
  } catch (error) {
    if (error instanceof CatalogueForbiddenError) throw new SeoForbiddenError();
    throw error;
  }
}

function features(policy: SeoPolicy): SeoOverview["features"] {
  const open = policy.indexing === "public_pages";
  return [
    {
      key: "generic_previews",
      label: "Generic link previews",
      state: "active",
      note: "Every shared link shows the store name and a generic description, never a product.",
    },
    {
      key: "base_canonical",
      label: "Canonical addresses",
      state: "active",
      note: "Product, brand and category pages name their own address once the age check is passed.",
    },
    {
      key: "slug_redirects",
      label: "Redirects from former addresses",
      state: "active",
      note: "A changed brand or category address sends visitors on to the new one.",
    },
    {
      key: "public_sitemap",
      label: "Sitemap of public pages",
      state: open ? "active" : "inactive",
      note: open
        ? "robots.txt and sitemap.xml offer the public policy pages only (responsible use, terms, privacy)."
        : "The store is closed to search engines: robots.txt disallows everything.",
    },
    {
      key: "product_indexing",
      label: "Product indexing",
      state: "inactive",
      note: "Off until the indexing policy (BI-05) is decided and verified search crawlers can be told apart safely.",
    },
    {
      key: "product_previews",
      label: "Product link previews",
      state: "inactive",
      note: "Off: a product's name, image or price never appears before the age check.",
    },
    {
      key: "product_json_ld",
      label: "Product structured data (JSON-LD)",
      state: "inactive",
      note: "Off together with product indexing.",
    },
  ];
}

/** What the SEO screen shows: the policy and which features are really on (`seo.write`). */
export async function readSeoOverview(db: Database, actorId: string): Promise<SeoOverview> {
  await requireRight(db, actorId, "seo.write");
  const { policy, version, updatedAt } = await policyRow(db);
  return seoOverviewSchema.parse({
    policy,
    version,
    updatedAt: updatedAt?.toISOString() ?? null,
    features: features(policy),
  });
}

/**
 * Sets the indexing policy (`seo.write`, at the expected version). The row is locked (a missing
 * row through an inserted sentinel); audit and `seo.policy_updated` commit with it. Setting the
 * same policy again changes nothing.
 */
export async function writeSeoPolicy(
  db: Database,
  context: CommandContext,
  input: SeoPolicyWriteRequest,
): Promise<SeoOverview> {
  const command = seoPolicyWriteRequestSchema.parse(input);
  await withTransaction(db, async (tx) => {
    if (!context.actorId) throw new SeoForbiddenError();
    try {
      await lockCatalogueActor(tx, context.actorId, ["seo.write"], true);
    } catch (error) {
      if (error instanceof CatalogueForbiddenError) throw new SeoForbiddenError();
      throw error;
    }
    const inserted = await tx.$executeRaw(Prisma.sql`
      INSERT INTO settings (key, value, updated_by) VALUES ('seo', 'null'::jsonb, ${context.actorId}::uuid)
      ON CONFLICT (key) DO NOTHING`);
    const [row] = await tx.$queryRaw<Array<{ value: unknown; version: number }>>(
      Prisma.sql`SELECT value, version FROM settings WHERE key='seo' FOR UPDATE`,
    );
    const current = inserted > 0 ? 0 : row!.version;
    if (current !== command.expectedVersion) throw new SeoConflictError();
    const before = seoPolicySchema.safeParse(row!.value);
    const previous = before.success ? before.data.indexing : "closed";
    if (inserted === 0 && before.success && previous === command.indexing) return;
    const version = current + 1;
    await tx.$executeRaw(Prisma.sql`
      UPDATE settings SET value=${JSON.stringify({ indexing: command.indexing })}::jsonb,
        version=${version}, updated_by=${context.actorId}::uuid, updated_at=statement_timestamp()
      WHERE key='seo'`);
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: "seo.policy_updated",
        entity: { type: "setting", id: "seo" },
        before: { version: current, indexing: previous },
        after: { version, indexing: command.indexing },
      }),
    );
    await new PrismaOutboxWriter().publish(
      tx,
      defineEvent("seo.policy_updated", "seo", { key: "seo" }, version),
    );
  });
  return readSeoOverview(db, context.actorId!);
}

/**
 * SEO problems of what shoppers can reach (`seo.reports`): published products and active brands
 * and categories, none in the bin. A missing title or description falls back to the name and
 * the generic text, so those are advice, not errors. Duplicates compare the title a page would
 * show (its SEO title, or else its name), case-insensitively, across all three.
 */
export async function readSeoIssues(db: Database, actorId: string): Promise<SeoIssuesResponse> {
  await requireRight(db, actorId, "seo.reports");
  return db.$transaction(
    async (tx) => {
      const pages = await tx.$queryRaw<
        Array<{
          entity: "product" | "brand" | "category";
          id: string;
          name: string;
          slug: string;
          title: string | null;
          description: string | null;
        }>
      >(Prisma.sql`
        SELECT 'product' AS entity, id, name, slug, seo->>'title' AS title,
          seo->>'description' AS description
        FROM products WHERE status='published' AND deleted_at IS NULL
        UNION ALL
        SELECT 'brand', id, name, slug, seo->>'title', seo->>'description'
        FROM brands WHERE active AND deleted_at IS NULL
        UNION ALL
        SELECT 'category', id, name, slug, seo->>'title', seo->>'description'
        FROM categories WHERE active AND deleted_at IS NULL
        ORDER BY 1, 3, 2`);
      const [{ now }] = (await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT now() AS now`,
      )) as [{ now: Date }];
      type Item = SeoIssuesResponse["items"][number];
      const items: Item[] = [];
      const byTitle = new Map<string, typeof pages>();
      for (const page of pages) {
        const base = { entity: page.entity, id: page.id, name: page.name, slug: page.slug };
        if (!page.title) items.push({ ...base, kind: "missing_title", detail: null });
        else if (page.title.length > SEO_LIMITS.title)
          items.push({
            ...base,
            kind: "title_too_long",
            detail: `${page.title.length} characters`,
          });
        if (!page.description) items.push({ ...base, kind: "missing_description", detail: null });
        else if (page.description.length > SEO_LIMITS.description)
          items.push({
            ...base,
            kind: "description_too_long",
            detail: `${page.description.length} characters`,
          });
        const shown = (page.title ?? page.name).trim().toLowerCase();
        byTitle.set(shown, [...(byTitle.get(shown) ?? []), page]);
      }
      for (const same of byTitle.values())
        if (same.length > 1)
          for (const page of same)
            items.push({
              kind: "duplicate_title",
              entity: page.entity,
              id: page.id,
              name: page.name,
              slug: page.slug,
              detail: (page.title ?? page.name).slice(0, 200),
            });
      const counts = Object.fromEntries(
        SEO_ISSUE_KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length]),
      ) as SeoIssuesResponse["counts"];
      const order = (item: Item) => SEO_ISSUE_KINDS.indexOf(item.kind);
      return seoIssuesResponseSchema.parse({
        generatedAt: now.toISOString(),
        limits: SEO_LIMITS,
        counts,
        checked: {
          products: pages.filter((page) => page.entity === "product").length,
          brands: pages.filter((page) => page.entity === "brand").length,
          categories: pages.filter((page) => page.entity === "category").length,
        },
        // Duplicates and length problems first: they are what most needs fixing.
        items: items
          .sort((a, b) => {
            const rank = (item: Item) =>
              item.kind === "duplicate_title"
                ? -2
                : item.kind.endsWith("too_long")
                  ? -1
                  : order(item);
            return rank(a) - rank(b) || a.name.localeCompare(b.name);
          })
          .slice(0, 200),
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
