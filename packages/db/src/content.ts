import {
  contentReferences,
  contentSchema,
  CURRENT_CONTENT_SCHEMA,
  defineEvent,
  type ContentProblem,
  type ContentReferences,
  type ContentSectionKey,
  type SectionContent,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { PrismaOutboxWriter } from "./outbox";
import { withTransaction } from "./transaction";

/**
 * Storefront content storage (roadmap step 96, ADR 0064). One row per section: a draft that is
 * always valid for its schema version, and the published copy, which is the draft as it was
 * when the Owner published it (the database enforces that). `content.manage` (Owner only).
 * Drafts may point at products or images that are not ready yet; publishing checks every
 * reference, and the read side (step 98) checks them again.
 */
export class ContentForbiddenError extends Error {}
export class ContentNotFoundError extends Error {}
export class ContentConflictError extends Error {
  constructor(readonly reason: "VERSION_CONFLICT" | "NOTHING_TO_PUBLISH") {
    super(reason);
  }
}
/** The draft is not valid for its schema (only possible for rows written outside the API). */
export class ContentInvalidError extends Error {}
/** Publishing refused: these references cannot be shown. */
export class ContentReferenceError extends Error {
  constructor(readonly problems: ContentProblem[]) {
    super("CONTENT_REFERENCES");
  }
}

export interface ContentSectionRecord {
  key: ContentSectionKey;
  schemaVersion: number;
  draft: SectionContent;
  draftUpdatedAt: string;
  published: SectionContent | null;
  publishedSchemaVersion: number | null;
  publishedAt: string | null;
  /** The draft differs from what is published (or nothing is published yet). */
  unpublishedChanges: boolean;
  version: number;
}
interface Row {
  id: string;
  key: ContentSectionKey;
  schemaVersion: number;
  draft: unknown;
  draftUpdatedAt: Date;
  published: unknown;
  publishedSchemaVersion: number | null;
  publishedAt: Date | null;
  version: number;
  same: boolean;
}
const SELECT = Prisma.sql`
  SELECT id, key, schema_version AS "schemaVersion", draft, draft_updated_at AS "draftUpdatedAt",
    published, published_schema_version AS "publishedSchemaVersion",
    published_at AS "publishedAt", version, (published IS NOT NULL AND published = draft) AS same
  FROM content_sections`;
const toRecord = (row: Row): ContentSectionRecord => ({
  key: row.key,
  schemaVersion: row.schemaVersion,
  draft: row.draft as SectionContent,
  draftUpdatedAt: row.draftUpdatedAt.toISOString(),
  published: (row.published as SectionContent | null) ?? null,
  publishedSchemaVersion: row.publishedSchemaVersion,
  publishedAt: row.publishedAt?.toISOString() ?? null,
  unpublishedChanges: !row.same,
  version: row.version,
});

async function editor(tx: Database | Tx, actorId: string | null, lock: boolean) {
  try {
    await lockCatalogueActor(tx, actorId, ["content.manage"], lock);
  } catch (error) {
    if (error instanceof CatalogueForbiddenError) throw new ContentForbiddenError();
    throw error;
  }
}

/** Every section that has been saved, in the fixed section order. */
export async function listContentSections(
  db: Database,
  actorId: string,
): Promise<ContentSectionRecord[]> {
  await editor(db, actorId, false);
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`${SELECT}
    ORDER BY array_position(${[...Object.keys(CURRENT_CONTENT_SCHEMA)]}::text[], key)`);
  return rows.map(toRecord);
}

/**
 * Saves a section's draft at the current schema version. `expectedVersion` is the version the
 * editor loaded, or 0 for a section never saved. Nothing public changes.
 */
export async function saveContentDraft(
  db: Database,
  context: CommandContext,
  key: ContentSectionKey,
  input: { expectedVersion: number; content: unknown },
): Promise<ContentSectionRecord> {
  const schemaVersion = CURRENT_CONTENT_SCHEMA[key];
  // Throws a ZodError for an invalid document; the route answers 400.
  const content = contentSchema(key, schemaVersion).parse(input.content);
  const saved = withTransaction(db, async (tx) => {
    await editor(tx, context.actorId, true);
    const [current] = await tx.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE key=${key} FOR UPDATE`);
    if ((current?.version ?? 0) !== input.expectedVersion)
      throw new ContentConflictError("VERSION_CONFLICT");
    const json = JSON.stringify(content);
    const [row] = current
      ? await tx.$queryRaw<Row[]>(Prisma.sql`
          UPDATE content_sections SET schema_version=${schemaVersion}, draft=${json}::jsonb,
            draft_updated_by=${context.actorId}::uuid, draft_updated_at=statement_timestamp(),
            version=version+1
          WHERE key=${key}
          RETURNING id, key, schema_version AS "schemaVersion", draft,
            draft_updated_at AS "draftUpdatedAt", published,
            published_schema_version AS "publishedSchemaVersion", published_at AS "publishedAt",
            version, (published IS NOT NULL AND published = draft) AS same`)
      : await tx.$queryRaw<Row[]>(Prisma.sql`
          INSERT INTO content_sections (key, schema_version, draft, draft_updated_by)
          VALUES (${key}, ${schemaVersion}, ${json}::jsonb, ${context.actorId}::uuid)
          RETURNING id, key, schema_version AS "schemaVersion", draft,
            draft_updated_at AS "draftUpdatedAt", published,
            published_schema_version AS "publishedSchemaVersion", published_at AS "publishedAt",
            version, false AS same`);
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: "content.draft_saved",
        entity: { type: "content_section", id: row!.id },
        before: current ? { version: current.version } : null,
        after: { key, schemaVersion, version: row!.version },
      }),
    );
    return toRecord(row!);
  });
  // Two first saves of a new section: the second meets the first's row.
  return saved.catch((error: unknown) => {
    if (pgCode(error) === "23505") throw new ContentConflictError("VERSION_CONFLICT");
    throw error;
  });
}
function pgCode(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  if (error.code === "P2002") return "23505";
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  const code = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
  return typeof code === "string" ? code : undefined;
}

/**
 * What a document points at that a shopper could not see: products that are not visible,
 * brands or categories that are hidden or trashed, images that are not processed content
 * images. Read inside the publishing transaction; the read side checks again.
 */
export async function checkContentReferences(
  db: Database | Tx,
  refs: ContentReferences,
): Promise<ContentProblem[]> {
  const problems: ContentProblem[] = [];
  const check = async (
    kind: ContentProblem["kind"],
    list: string[],
    query: (ids: string[]) => Prisma.Sql,
  ) => {
    if (!list.length) return;
    const rows = await db.$queryRaw<Array<{ id: string; ok: boolean }>>(query(list));
    const found = new Map(rows.map((row) => [row.id, row.ok]));
    for (const id of list) {
      const ok = found.get(id);
      if (ok === true) continue;
      problems.push({
        kind,
        id,
        reason: ok === undefined ? "missing" : kind === "image" ? "not_ready" : "not_visible",
      });
    }
  };
  await check(
    "product",
    refs.productIds,
    (ids) => Prisma.sql`
      SELECT p.id, (p.status='published' AND p.deleted_at IS NULL AND b.active
        AND b.deleted_at IS NULL AND c.active AND c.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active)) AS ok
      FROM products p JOIN brands b ON b.id=p.brand_id JOIN categories c ON c.id=p.category_id
      WHERE p.id = ANY(${ids}::uuid[])`,
  );
  await check(
    "brand",
    refs.brandIds,
    (ids) => Prisma.sql`
      SELECT id, (active AND deleted_at IS NULL) AS ok FROM brands WHERE id = ANY(${ids}::uuid[])`,
  );
  await check(
    "category",
    refs.categoryIds,
    (ids) => Prisma.sql`
      SELECT id, (active AND deleted_at IS NULL) AS ok
      FROM categories WHERE id = ANY(${ids}::uuid[])`,
  );
  await check(
    "image",
    refs.assetIds,
    (ids) => Prisma.sql`
      SELECT id, (state='ready') AS ok FROM media_assets
      WHERE id = ANY(${ids}::uuid[]) AND purpose='content'`,
  );
  return problems;
}

/**
 * Publishes a section's current draft at `expectedVersion`: every reference must be showable.
 * The published copy, the audit entry and the `content.published` event commit together.
 */
export async function publishContentSection(
  db: Database,
  context: CommandContext,
  key: ContentSectionKey,
  expectedVersion: number,
): Promise<ContentSectionRecord> {
  return withTransaction(db, async (tx) => {
    await editor(tx, context.actorId, true);
    const [current] = await tx.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE key=${key} FOR UPDATE`);
    if (!current) throw new ContentNotFoundError();
    if (current.version !== expectedVersion) throw new ContentConflictError("VERSION_CONFLICT");
    if (current.same) throw new ContentConflictError("NOTHING_TO_PUBLISH");
    const parsed = contentSchema(key, current.schemaVersion).safeParse(current.draft);
    if (!parsed.success) throw new ContentInvalidError();
    const problems = await checkContentReferences(tx, contentReferences(parsed.data));
    if (problems.length) throw new ContentReferenceError(problems);
    const [row] = await tx.$queryRaw<Row[]>(Prisma.sql`
      UPDATE content_sections SET published=draft, published_schema_version=schema_version,
        published_by=${context.actorId}::uuid, published_at=statement_timestamp(),
        version=version+1
      WHERE key=${key}
      RETURNING id, key, schema_version AS "schemaVersion", draft,
        draft_updated_at AS "draftUpdatedAt", published,
        published_schema_version AS "publishedSchemaVersion", published_at AS "publishedAt",
        version, true AS same`);
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: "content.published",
        entity: { type: "content_section", id: row!.id },
        before: {
          version: current.version,
          publishedAt: current.publishedAt?.toISOString() ?? null,
        },
        after: { key, schemaVersion: current.schemaVersion, version: row!.version },
      }),
    );
    await new PrismaOutboxWriter().publish(
      tx,
      defineEvent("content.published", row!.id, { contentId: row!.id }, row!.version),
    );
    return toRecord(row!);
  });
}

/**
 * The editor's preview of a draft (step 97): what each reference is now, and what would stop
 * it from being published. Admin only; nothing here is public and nothing is written.
 */
export async function readContentPreview(
  db: Database,
  actorId: string,
  key: ContentSectionKey,
): Promise<{
  key: ContentSectionKey;
  version: number;
  problems: ContentProblem[];
  products: Array<{
    id: string;
    name: string;
    visible: boolean;
    soldOut: boolean;
    priceFromFils: number | null;
  }>;
  brands: Array<{ id: string; name: string; visible: boolean }>;
  categories: Array<{ id: string; name: string; visible: boolean }>;
  images: Array<{ id: string; ready: boolean; derivativeKeys: Record<string, string> }>;
}> {
  await editor(db, actorId, false);
  const [row] = await db.$queryRaw<Row[]>(Prisma.sql`${SELECT} WHERE key=${key}`);
  if (!row) throw new ContentNotFoundError();
  const parsed = contentSchema(key, row.schemaVersion).safeParse(row.draft);
  if (!parsed.success) throw new ContentInvalidError();
  const refs = contentReferences(parsed.data);
  const problems = await checkContentReferences(db, refs);
  const hidden = (kind: ContentProblem["kind"], id: string) =>
    problems.some((problem) => problem.kind === kind && problem.id === id);
  const products = refs.productIds.length
    ? await db.$queryRaw<
        Array<{ id: string; name: string; soldOut: boolean; priceFromFils: number | null }>
      >(Prisma.sql`
        SELECT p.id, p.name,
          NOT coalesce(bool_or(v.active AND v.stock_on_hand > 0), false) AS "soldOut",
          min(coalesce(v.price_override_fils, p.base_price_fils)) FILTER (WHERE v.active)::int
            AS "priceFromFils"
        FROM products p LEFT JOIN variants v ON v.product_id=p.id
        WHERE p.id = ANY(${refs.productIds}::uuid[]) GROUP BY p.id, p.name`)
    : [];
  const named = async (table: "brands" | "categories", list: string[]) =>
    list.length
      ? db.$queryRaw<Array<{ id: string; name: string }>>(
          Prisma.sql`SELECT id, name FROM ${Prisma.raw(table)} WHERE id = ANY(${list}::uuid[])`,
        )
      : [];
  const brands = await named("brands", refs.brandIds);
  const categories = await named("categories", refs.categoryIds);
  const images = refs.assetIds.length
    ? await db.$queryRaw<
        Array<{ id: string; ready: boolean; derivativeKeys: Record<string, string> }>
      >(
        Prisma.sql`
          SELECT id, (state='ready') AS ready, derivative_keys AS "derivativeKeys"
          FROM media_assets WHERE id = ANY(${refs.assetIds}::uuid[]) AND purpose='content'`,
      )
    : [];
  // In the draft's order.
  const ordered = <T extends { id: string }>(list: string[], rows: T[]) =>
    list.flatMap((id) => rows.filter((row) => row.id === id));
  return {
    key,
    version: row.version,
    problems,
    products: ordered(refs.productIds, products).map((product) => ({
      ...product,
      visible: !hidden("product", product.id),
    })),
    brands: ordered(refs.brandIds, brands).map((brand) => ({
      ...brand,
      visible: !hidden("brand", brand.id),
    })),
    categories: ordered(refs.categoryIds, categories).map((category) => ({
      ...category,
      visible: !hidden("category", category.id),
    })),
    images: ordered(refs.assetIds, images),
  };
}
