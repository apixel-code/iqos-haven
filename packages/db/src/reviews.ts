import { createHash, randomBytes } from "node:crypto";
import {
  REVIEW_PROOF_TTL_DAYS,
  reviewLinkResponseSchema,
  reviewProofTokenSchema,
  type ConflictCode,
  type ReviewLinkResponse,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { formatOrderNumber, whatsappMessageHref } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { PrismaAuditWriter } from "./audit";
import { CatalogueForbiddenError, lockCatalogueActor } from "./catalogue-parents";
import { lockOrder, OrderNotFoundError } from "./order-locks";
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
