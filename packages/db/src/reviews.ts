import { createHash, randomBytes } from "node:crypto";
import {
  defineEvent,
  REVIEW_PROOF_TTL_DAYS,
  reviewLinkResponseSchema,
  reviewProofTokenSchema,
  type ConflictCode,
  type ReviewLinkResponse,
  type StoreReviewRequest,
  type StoreReviewResponse,
  adminReviewsQuerySchema,
  adminReviewsResponseSchema,
  reviewModerationRequestSchema,
  reviewModerationResponseSchema,
  STORE_REVIEWS_SHOWN,
  type AdminReviewsQuery,
  type AdminReviewsResponse,
  type ReviewModerationRequest,
  type ReviewModerationResponse,
  type StoreRating,
  type StoreReview,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { formatOrderNumber, whatsappMessageHref } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { lockOrder, OrderNotFoundError } from "./order-locks";
import { PrismaOutboxWriter } from "./outbox";
import { withTransaction } from "./transaction";

/**
 * Verified-purchase proof (roadmap step 93, ADR 0061; architecture §10). Staff create a review
 * link for a Delivered order and send it to the customer themselves. The link carries a random
 * token in its fragment; only the token's SHA-256 is stored. The token lets its holder review
 * the order's products, once each, until it expires or a newer link replaces it. It never
 * reveals anything about the order: an order ID or number alone proves nothing.
 */
export class ReviewLinkForbiddenError extends Error {}
export class ReviewLinkNotFoundError extends Error {}
export class ReviewLinkConflictError extends Error {
  constructor(
    readonly reason: Extract<
      ConflictCode,
      "REVIEW_NOT_ALLOWED" | "NOTHING_TO_REVIEW" | "STORE_DOMAIN_REQUIRED"
    >,
  ) {
    super(reason);
  }
}
/** Any token that does not prove a reviewable purchase: one reason, so nothing can be probed. */
export class ReviewProofInvalidError extends Error {
  readonly code = "REVIEW_PROOF_INVALID";
}

/** Who may create a link: it goes to the customer's phone, as the WhatsApp messages do. */
const LINK_PERMISSIONS = ["orders.read", "customers.read"] as const;
const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest();

/** The order's products that are still in the catalogue and not reviewed for this order. */
async function reviewableProducts(db: Database | Tx, orderId: string) {
  return db.$queryRaw<Array<{ productId: string; name: string }>>(Prisma.sql`
    SELECT DISTINCT ON (p.id) p.id AS "productId", p.name
    FROM order_items i JOIN products p ON p.id=i.product_id
    WHERE i.order_id=${orderId}::uuid AND p.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM reviews r WHERE r.order_id=i.order_id AND r.product_id=p.id)
    ORDER BY p.id`);
}

const REVIEW_LINK_TEXT =
  "Hi, this is {{store_name}}. Thank you for your order {{order_number}}. If you would like to review what you bought, you can do it here: {{link}}";

/**
 * Creates a review link for a Delivered order, revoking the previous one. Needs `orders.read`
 * and `customers.read`, and the store's domain in Settings (the link points to the store).
 */
export async function issueReviewLink(
  db: Database,
  context: CommandContext,
  orderId: string,
): Promise<ReviewLinkResponse> {
  const token = randomBytes(32).toString("base64url");
  return withTransaction(db, async (tx) => {
    try {
      await lockCatalogueActor(tx, context.actorId, LINK_PERMISSIONS, true);
    } catch (error) {
      if (error instanceof CatalogueForbiddenError) throw new ReviewLinkForbiddenError();
      throw error;
    }
    let order;
    try {
      order = await lockOrder(tx, orderId);
    } catch (error) {
      if (error instanceof OrderNotFoundError) throw new ReviewLinkNotFoundError();
      throw error;
    }
    if (order.status !== "delivered") throw new ReviewLinkConflictError("REVIEW_NOT_ALLOWED");
    const products = await reviewableProducts(tx, orderId);
    if (!products.length) throw new ReviewLinkConflictError("NOTHING_TO_REVIEW");
    const settings = await tx.$queryRaw<Array<{ key: string; value: Record<string, unknown> }>>(
      Prisma.sql`SELECT key, value FROM settings WHERE key='store'`,
    );
    const store = settings[0]?.value;
    if (typeof store?.domain !== "string" || !store.domain)
      throw new ReviewLinkConflictError("STORE_DOMAIN_REQUIRED");

    await tx.$executeRaw(Prisma.sql`
      UPDATE review_proofs SET revoked_at=statement_timestamp()
      WHERE order_id=${orderId}::uuid AND revoked_at IS NULL`);
    const [proof] = await tx.$queryRaw<Array<{ id: string; expiresAt: Date }>>(Prisma.sql`
      INSERT INTO review_proofs (order_id, token_hash, issued_by, expires_at)
      VALUES (${orderId}::uuid, ${hashToken(token)}, ${context.actorId}::uuid,
        statement_timestamp() + make_interval(days => ${REVIEW_PROOF_TTL_DAYS}::int))
      RETURNING id, expires_at AS "expiresAt"`);
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: "order.review_link_issued",
        entity: { type: "order", id: orderId },
        // Never the token or anything that leads to it.
        after: { proofId: proof!.id, expiresAt: proof!.expiresAt.toISOString() },
      }),
    );

    const link = `https://${store.domain}/review#${token}`;
    const [phone] = await tx.$queryRaw<Array<{ phone: string }>>(Prisma.sql`
      SELECT customer_phone_e164 AS phone FROM orders WHERE id=${orderId}::uuid`);
    const values: Record<string, string> = {
      store_name:
        typeof store.name === "string" ? store.name.replace(/[\r\n]+/g, " ") : "Iqos Haven",
      order_number: formatOrderNumber(order.orderNumber),
      link,
    };
    // A replacer function: a "$" in the store name stays as typed.
    const text = REVIEW_LINK_TEXT.replace(/\{\{(\w+)\}\}/g, (_all, key: string) => values[key]!);
    const href = phone ? whatsappMessageHref(phone.phone, text) : null;
    return reviewLinkResponseSchema.parse({
      orderId,
      link,
      expiresAt: proof!.expiresAt.toISOString(),
      products: products.length,
      // Placeholder wording until the client approves copy (BI-09).
      whatsapp: href ? { href, text, placeholder: true } : null,
    });
  });
}

interface ProofRow {
  id: string;
  orderId: string;
  expiresAt: Date;
}
const LIVE_PROOF = (token: string) => Prisma.sql`
  SELECT p.id, p.order_id AS "orderId", p.expires_at AS "expiresAt"
  FROM review_proofs p JOIN orders o ON o.id=p.order_id
  WHERE p.token_hash=${hashToken(token)} AND p.revoked_at IS NULL
    AND p.expires_at > statement_timestamp() AND o.status='delivered'`;

/**
 * What a review link may still be used for: the products left to review, by ID and catalogue
 * name. Nothing about the order or the customer. Null for anything that is not a live proof.
 */
export async function readReviewProof(
  db: Database,
  token: string,
): Promise<{ expiresAt: string; products: Array<{ productId: string; name: string }> } | null> {
  if (!reviewProofTokenSchema.safeParse(token).success) return null;
  const [proof] = await db.$queryRaw<ProofRow[]>(LIVE_PROOF(token));
  if (!proof) return null;
  const products = await reviewableProducts(db, proof.orderId);
  return products.length ? { expiresAt: proof.expiresAt.toISOString(), products } : null;
}

/**
 * For the review submission transaction (step 94): locks the order, then the live proof, and
 * confirms the proof covers `productId` and that the product has no review for this order yet.
 * Two submissions with the same link take turns on the order row; the database's
 * one-review-per-purchase constraint backs this up.
 */
export async function lockReviewProof(
  tx: Tx,
  token: string,
  productId: string,
): Promise<{ proofId: string; orderId: string }> {
  if (!reviewProofTokenSchema.safeParse(token).success) throw new ReviewProofInvalidError();
  // The order first (lock order: order before what hangs off it), so a cancellation cannot
  // commit between the Delivered check and the review insert.
  const [found] = await tx.$queryRaw<Array<{ orderId: string }>>(Prisma.sql`
    SELECT order_id AS "orderId" FROM review_proofs WHERE token_hash=${hashToken(token)}`);
  if (!found) throw new ReviewProofInvalidError();
  const order = await lockOrder(tx, found.orderId);
  if (order.status !== "delivered") throw new ReviewProofInvalidError();
  const [proof] = await tx.$queryRaw<ProofRow[]>(Prisma.sql`${LIVE_PROOF(token)} FOR UPDATE OF p`);
  if (!proof) throw new ReviewProofInvalidError();
  const products = await reviewableProducts(tx, proof.orderId);
  if (!products.some((product) => product.productId === productId))
    throw new ReviewProofInvalidError();
  return { proofId: proof.id, orderId: proof.orderId };
}

/**
 * A shopper's review through a review link (roadmap step 94, ADR 0062). One transaction: the
 * proof is locked and checked, the review is written pending with its audit entry and its
 * `review.submitted` event. Nothing is published here; only moderation (step 95) does that.
 * The answer says how many products the link still covers, never anything about the order.
 */
export async function submitReview(
  db: Database,
  input: StoreReviewRequest & { requestId: string },
): Promise<StoreReviewResponse> {
  return withTransaction(db, async (tx) => {
    const { orderId, proofId } = await lockReviewProof(tx, input.token, input.productId);
    const [review] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO reviews (product_id, order_id, proof_id, rating, title, body, author_name)
      VALUES (${input.productId}::uuid, ${orderId}::uuid, ${proofId}::uuid, ${input.rating},
        ${input.title}, ${input.body}, ${input.authorName})
      RETURNING id`);
    const reviewId = review!.id;
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(
        { requestId: input.requestId, actorId: null },
        {
          action: "review.submitted",
          entity: { type: "review", id: reviewId },
          // The customer's words and name stay in the review row, not in the audit trail.
          after: { productId: input.productId, orderId, proofId, rating: input.rating },
          reason: "review link",
        },
      ),
    );
    await new PrismaOutboxWriter().publish(
      tx,
      defineEvent("review.submitted", reviewId, { reviewId }, 1),
    );
    const remaining = await reviewableProducts(tx, orderId);
    return { status: "pending" as const, remaining: remaining.length };
  }).catch((error: unknown) => {
    // The order lock makes this unreachable; should a second review slip past it, the one
    // review per purchase constraint refuses it and the shopper gets the same answer.
    if (pgCode(error) === "23505") throw new ReviewProofInvalidError();
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

// --- Moderation and public reviews (roadmap step 95, ADR 0063) ---
export class ReviewModerationForbiddenError extends Error {}
export class ReviewNotFoundError extends Error {}
export class ReviewCursorError extends Error {}
export class ReviewModerationConflictError extends Error {
  constructor(readonly reason: Extract<ConflictCode, "VERSION_CONFLICT" | "INVALID_TRANSITION">) {
    super(reason);
  }
}

async function moderatorRights(db: Database | Tx, actorId: string) {
  const [row] = await db.$queryRaw<Array<{ permissions: string[] }>>(Prisma.sql`
    SELECT coalesce(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
    FROM staff_users u
    LEFT JOIN role_permissions rp ON rp.role_id=u.role_id
    LEFT JOIN permissions p ON p.id=rp.permission_id
    WHERE u.id=${actorId}::uuid AND u.active GROUP BY u.id`);
  const held = row?.permissions ?? [];
  if (!held.includes("reviews.moderate")) throw new ReviewModerationForbiddenError();
  return { orders: held.includes("orders.read") };
}
const average = (value: string | number | null) =>
  value === null ? null : Math.round(Number(value) * 10) / 10;

interface AdminReviewRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  rating: number;
  title: string;
  body: string;
  authorName: string;
  productId: string;
  productName: string;
  orderId: string;
  orderNumber: string;
  verified: boolean;
  createdAt: Date;
  moderatedAt: Date | null;
  version: number;
  cursor: string;
}

/**
 * Reviews for moderation, newest first by keyset, with the counts per status and the approved
 * average. Needs `reviews.moderate`; the order behind a review is named only to a moderator
 * who may also read orders.
 */
export async function listAdminReviews(
  db: Database,
  actorId: string,
  input: AdminReviewsQuery,
): Promise<AdminReviewsResponse> {
  const query = adminReviewsQuerySchema.parse(input);
  const rights = await moderatorRights(db, actorId);
  const filters: Prisma.Sql[] = [Prisma.sql`true`];
  if (query.status) filters.push(Prisma.sql`r.status=${query.status}`);
  if (query.productId) filters.push(Prisma.sql`r.product_id=${query.productId}::uuid`);
  if (query.rating) filters.push(Prisma.sql`r.rating=${query.rating}`);
  if (query.after) {
    let after: [string, string];
    try {
      after = JSON.parse(Buffer.from(query.after, "base64url").toString("utf8")) as [
        string,
        string,
      ];
      if (
        !Array.isArray(after) ||
        !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?\+00$/.test(after[0]) ||
        !/^[0-9a-f-]{36}$/i.test(after[1])
      )
        throw new Error("shape");
    } catch {
      throw new ReviewCursorError();
    }
    filters.push(Prisma.sql`(r.created_at, r.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)`);
  }
  // One snapshot, so the tab counts and the average agree with the listed reviews.
  const { rows, summary, products } = await db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<AdminReviewRow[]>(Prisma.sql`
      SELECT r.id, r.status, r.rating::int AS rating, r.title, r.body, r.author_name AS "authorName",
        p.id AS "productId", p.name AS "productName", o.id AS "orderId",
        o.order_number::text AS "orderNumber", (r.proof_id IS NOT NULL) AS verified,
        r.created_at AS "createdAt", r.moderated_at AS "moderatedAt", r.version,
        -- The cursor is written in UTC whatever the session's time zone.
        to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' AS cursor
      FROM reviews r JOIN products p ON p.id=r.product_id JOIN orders o ON o.id=r.order_id
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ${query.limit + 1}`);
      const [summary] = await tx.$queryRaw<
        Array<{ pending: number; approved: number; rejected: number; average: string | null }>
      >(Prisma.sql`
      SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
        count(*) FILTER (WHERE status='approved')::int AS approved,
        count(*) FILTER (WHERE status='rejected')::int AS rejected,
        avg(rating) FILTER (WHERE status='approved')::text AS average
      FROM reviews`);
      const products = await tx.$queryRaw<Array<{ id: string; name: string }>>(Prisma.sql`
      SELECT p.id, p.name FROM products p
      WHERE EXISTS (SELECT 1 FROM reviews r WHERE r.product_id=p.id)
      ORDER BY lower(p.name), p.id LIMIT 500`);
      return { rows, summary: summary!, products };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return adminReviewsResponseSchema.parse({
    items: page.map((row) => ({
      id: row.id,
      status: row.status,
      rating: row.rating,
      title: row.title,
      body: row.body,
      authorName: row.authorName,
      product: { id: row.productId, name: row.productName },
      verified: row.verified,
      ...(rights.orders
        ? { order: { id: row.orderId, orderNumber: formatOrderNumber(row.orderNumber) } }
        : {}),
      createdAt: row.createdAt.toISOString(),
      moderatedAt: row.moderatedAt?.toISOString() ?? null,
      version: row.version,
    })),
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(JSON.stringify([last.cursor, last.id])).toString("base64url")
        : null,
    counts: { pending: summary.pending, approved: summary.approved, rejected: summary.rejected },
    approvedAverage: average(summary.average),
    products,
  });
}

/**
 * Approves or rejects a review at the version the moderator saw. Approving shows it on the
 * product page; rejecting hides it, also after approval. The content never changes and a review
 * never goes back to pending (the database enforces both). The audit entry, and a
 * `catalog.changed` event for the product so every cache drops its page, commit with it.
 */
export async function moderateReview(
  db: Database,
  context: CommandContext,
  reviewId: string,
  request: ReviewModerationRequest,
): Promise<ReviewModerationResponse> {
  const input = reviewModerationRequestSchema.parse(request);
  const to = input.decision === "approve" ? "approved" : "rejected";
  return withTransaction(db, async (tx) => {
    try {
      await lockCatalogueActor(tx, context.actorId, ["reviews.moderate"], true);
    } catch (error) {
      if (error instanceof CatalogueForbiddenError) throw new ReviewModerationForbiddenError();
      throw error;
    }
    const [review] = await tx.$queryRaw<
      Array<{ status: string; version: number; productId: string }>
    >(Prisma.sql`
      SELECT status, version, product_id AS "productId" FROM reviews
      WHERE id=${reviewId}::uuid FOR UPDATE`);
    if (!review) throw new ReviewNotFoundError();
    if (review.version !== input.expectedVersion)
      throw new ReviewModerationConflictError("VERSION_CONFLICT");
    if (review.status === to) throw new ReviewModerationConflictError("INVALID_TRANSITION");
    const [updated] = await tx.$queryRaw<Array<{ version: number; moderatedAt: Date }>>(Prisma.sql`
      UPDATE reviews SET status=${to}, moderated_by=${context.actorId}::uuid,
        moderated_at=statement_timestamp(), version=version+1
      WHERE id=${reviewId}::uuid
      RETURNING version, moderated_at AS "moderatedAt"`);
    await new PrismaAuditWriter().append(
      tx,
      toAuditEntry(context, {
        action: input.decision === "approve" ? "review.approved" : "review.rejected",
        entity: { type: "review", id: reviewId },
        before: { status: review.status, version: review.version },
        after: { status: to, version: updated!.version },
      }),
    );
    await new PrismaOutboxWriter().publish(
      tx,
      defineEvent("catalog.changed", review.productId, {
        entityType: "product",
        entityId: review.productId,
      }),
    );
    return reviewModerationResponseSchema.parse({
      id: reviewId,
      status: to,
      version: updated!.version,
      moderatedAt: updated!.moderatedAt.toISOString(),
    });
  });
}

/**
 * The public side of a product's reviews: the rating from approved reviews and the newest
 * approved ones. Pending and rejected reviews never leave the database through this, and
 * neither does anything about the order behind a review.
 */
export async function readProductReviews(
  db: Database | Tx,
  productId: string,
): Promise<{ rating: StoreRating | null; reviews: StoreReview[] }> {
  const [summary] = await db.$queryRaw<
    Array<{ count: number; average: string | null; distribution: number[] }>
  >(Prisma.sql`
    SELECT count(*)::int AS count, avg(rating)::text AS average,
      ARRAY[count(*) FILTER (WHERE rating=5), count(*) FILTER (WHERE rating=4),
        count(*) FILTER (WHERE rating=3), count(*) FILTER (WHERE rating=2),
        count(*) FILTER (WHERE rating=1)]::int[] AS distribution
    FROM reviews WHERE product_id=${productId}::uuid AND status='approved'`);
  const rows = await db.$queryRaw<
    Array<{
      rating: number;
      title: string;
      body: string;
      authorName: string;
      date: string;
      verified: boolean;
    }>
  >(Prisma.sql`
    SELECT rating::int AS rating, title, body, author_name AS "authorName",
      to_char(created_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD') AS date,
      (proof_id IS NOT NULL) AS verified
    FROM reviews WHERE product_id=${productId}::uuid AND status='approved'
    ORDER BY created_at DESC, id DESC LIMIT ${STORE_REVIEWS_SHOWN}`);
  return {
    rating:
      summary && summary.count > 0
        ? {
            average: average(summary.average)!,
            count: summary.count,
            distribution: summary.distribution as StoreRating["distribution"],
          }
        : null,
    reviews: rows,
  };
}
