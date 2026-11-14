import {
  defineEvent,
  guideCreateRequestSchema,
  guideResponseSchema,
  guideUpdateRequestSchema,
  MAX_GUIDES,
  storeGuideResponseSchema,
  storeGuideSummarySchema,
  type ConflictCode,
  type GuideCreateRequest,
  type GuideResponse,
  type GuideUpdateRequest,
  type StoreGuideResponse,
  type StoreGuideSummary,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { PrismaAuditWriter } from "./audit";
import { PrismaOutboxWriter } from "./outbox";

/**
 * Guides (ADR 0117). `content.manage` (Owner only), like the rest of the storefront content.
 * Every change is one transaction: actor share lock and permission, the guide row FOR UPDATE,
 * the version the Owner saw, the write, one audit entry and one `guide.updated` event.
 * A guide is never deleted; hiding it keeps its first publish date and its link.
 */
export class GuideForbiddenError extends Error {}
export class GuideNotFoundError extends Error {}
export class GuideConflictError extends Error {
  constructor(readonly reason: ConflictCode) {
    super(reason);
  }
}

interface Row {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  published: boolean;
  publishedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
const COLUMNS = Prisma.sql`id, slug, title, summary, body, published,
  published_at AS "publishedAt", version, created_at AS "createdAt", updated_at AS "updatedAt"`;

const response = (row: Row): GuideResponse =>
  guideResponseSchema.parse({
    ...row,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
/** What the audit trail keeps: the guide's identity and state, not its whole text. */
const facts = (row: Row) => ({
  version: row.version,
  slug: row.slug,
  title: row.title,
  published: row.published,
  bodyLength: row.body.length,
});

async function editor(tx: Database | Tx, actorId: string | null, lock: boolean) {
  try {
    await lockCatalogueActor(tx, actorId, ["content.manage"], lock);
  } catch (error) {
    if (error instanceof CatalogueForbiddenError) throw new GuideForbiddenError();
    throw error;
  }
}
async function read(tx: Database | Tx, id: string, lock = false) {
  const [row] = await tx.$queryRaw<Row[]>(
    Prisma.sql`SELECT ${COLUMNS} FROM guides WHERE id=${id}::uuid ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`,
  );
  return row ?? null;
}
async function record(tx: Tx, context: CommandContext, before: Row | null, after: Row) {
  await new PrismaAuditWriter().append(
    tx,
    toAuditEntry(context, {
      action: "guide.updated",
      entity: { type: "guide", id: after.id },
      before: before ? facts(before) : { version: 0 },
      after: facts(after),
      reason: before ? "guide updated" : "guide created",
    }),
  );
  await new PrismaOutboxWriter().publish(
    tx,
    defineEvent("guide.updated", after.id, { guideId: after.id }, after.version),
  );
}
function isUniqueViolation(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2002") return true;
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return (meta?.code ?? meta?.driverAdapterError?.cause?.originalCode) === "23505";
}

export async function listGuides(
  db: Database,
  actorId: string,
): Promise<{ items: GuideResponse[] }> {
  await editor(db, actorId, false);
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT ${COLUMNS} FROM guides ORDER BY updated_at DESC, id DESC LIMIT ${MAX_GUIDES}`);
  return { items: rows.map(response) };
}

export async function readGuide(db: Database, actorId: string, id: string) {
  await editor(db, actorId, false);
  const row = await read(db, id);
  if (!row) throw new GuideNotFoundError();
  return response(row);
}

export async function createGuide(
  db: Database,
  context: CommandContext,
  input: GuideCreateRequest,
) {
  const command = guideCreateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await editor(tx, context.actorId, true);
      const [count] = await tx.$queryRaw<Array<{ n: number }>>(
        Prisma.sql`SELECT count(*)::int AS n FROM guides`,
      );
      if (count!.n >= MAX_GUIDES) throw new GuideConflictError("IN_USE");
      const [created] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO guides (slug, title, summary, body, published, published_at, updated_by)
        VALUES (${command.slug}, ${command.title}, ${command.summary}, ${command.body},
          ${command.published},
          ${command.published ? Prisma.sql`statement_timestamp()` : Prisma.sql`NULL`},
          ${context.actorId}::uuid)
        RETURNING id`);
      const row = (await read(tx, created!.id))!;
      await record(tx, context, null, row);
      return response(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new GuideConflictError("DUPLICATE");
    throw error;
  }
}

export async function updateGuide(
  db: Database,
  context: CommandContext,
  id: string,
  input: GuideUpdateRequest,
) {
  const command = guideUpdateRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await editor(tx, context.actorId, true);
      const before = await read(tx, id, true);
      if (!before) throw new GuideNotFoundError();
      if (before.version !== command.version) throw new GuideConflictError("VERSION_CONFLICT");
      // Once published, the address may be in search results and links: it stays.
      if (before.publishedAt && before.slug !== command.slug)
        throw new GuideConflictError("GUIDE_SLUG_LOCKED");
      const unchanged =
        before.slug === command.slug &&
        before.title === command.title &&
        before.summary === command.summary &&
        before.body === command.body &&
        before.published === command.published;
      if (unchanged) return response(before);
      await tx.$executeRaw(Prisma.sql`
        UPDATE guides SET slug=${command.slug}, title=${command.title},
          summary=${command.summary}, body=${command.body}, published=${command.published},
          published_at=coalesce(published_at,
            ${command.published ? Prisma.sql`statement_timestamp()` : Prisma.sql`NULL`}),
          version=version+1, updated_by=${context.actorId}::uuid,
          updated_at=statement_timestamp()
        WHERE id=${id}::uuid`);
      const after = (await read(tx, id))!;
      await record(tx, context, before, after);
      return response(after);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new GuideConflictError("DUPLICATE");
    throw error;
  }
}

/** Published guides for the store, newest first. The age ticket is checked by the caller. */
export async function listStoreGuides(db: Database | Tx): Promise<StoreGuideSummary[]> {
  const rows = await db.$queryRaw<
    Array<{ slug: string; title: string; summary: string; publishedAt: Date; updatedAt: Date }>
  >(Prisma.sql`
    SELECT slug, title, summary, published_at AS "publishedAt", updated_at AS "updatedAt"
    FROM guides WHERE published ORDER BY published_at DESC, id DESC LIMIT ${MAX_GUIDES}`);
  return rows.map((row) =>
    storeGuideSummarySchema.parse({
      ...row,
      publishedAt: row.publishedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
}

/** One published guide, or null (a hidden guide is answered like an unknown one). */
export async function readStoreGuide(
  db: Database | Tx,
  slug: string,
): Promise<StoreGuideResponse | null> {
  const [row] = await db.$queryRaw<
    Array<{
      slug: string;
      title: string;
      summary: string;
      body: string;
      publishedAt: Date;
      updatedAt: Date;
    }>
  >(Prisma.sql`
    SELECT slug, title, summary, body, published_at AS "publishedAt", updated_at AS "updatedAt"
    FROM guides WHERE slug=${slug} AND published`);
  if (!row) return null;
  return storeGuideResponseSchema.parse({
    ...row,
    publishedAt: row.publishedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
