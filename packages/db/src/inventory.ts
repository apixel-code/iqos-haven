import {
  inventoryItemSchema,
  inventoryQuerySchema,
  stockAdjustmentRequestSchema,
  stockAdjustmentResponseSchema,
  stockMovementSchema,
  stockMovementsQuerySchema,
  type InventoryItem,
  type InventoryQuery,
  type StockAdjustmentRequest,
  type StockAdjustmentResponse,
  type StockMovement,
  type StockMovementsQuery,
} from "@ih/contracts";
import { toAuditEntry, type CommandContext } from "@ih/application";
import { Prisma, type Database, type Tx } from "./client";
import { withTransaction } from "./transaction";
import { PrismaAuditWriter } from "./audit";
import {
  CatalogueConflictError,
  CatalogueNotFoundError,
  lockCatalogueActor,
} from "./catalogue-parents";

/**
 * Inventory read and stock adjustment (roadmap step 46, ADR 0017). The only stock write is an
 * INSERT into `stock_movements`; its trigger applies the delta to the variant (row lock) and
 * records the balance, and the variant CHECK refuses negative stock. Adjustments are replay-safe
 * by command ID: the same command and payload returns the original movement, a different payload
 * is a conflict. Lock order: actor share lock → variant row (via the movement trigger).
 */
interface ItemRow {
  variantId: string;
  productId: string;
  productName: string;
  productStatus: "draft" | "published";
  sku: string;
  attributes: Record<string, string>;
  stockOnHand: number;
  lowStockThreshold: number;
  active: boolean;
}
interface MovementRow {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: StockMovement["reason"];
  note: string | null;
  actorId: string | null;
  actorName: string | null;
  createdAt: Date;
}

/** Out at zero; low at or below the threshold; zero stock never unpublishes (architecture §6). */
export function stockState(stock: number, threshold: number): InventoryItem["stockState"] {
  if (stock <= 0) return "out";
  return stock <= threshold ? "low" : "in_stock";
}

const ITEM = Prisma.sql`
  SELECT v.id AS "variantId", p.id AS "productId", p.name AS "productName",
    p.status AS "productStatus", v.sku, v.attributes, v.stock_on_hand AS "stockOnHand",
    v.low_stock_threshold AS "lowStockThreshold", v.active
  FROM variants v JOIN products p ON p.id=v.product_id`;

function item(row: ItemRow): InventoryItem {
  return inventoryItemSchema.parse({
    ...row,
    stockState: stockState(row.stockOnHand, row.lowStockThreshold),
  });
}
function movement(row: MovementRow): StockMovement {
  return stockMovementSchema.parse({
    id: row.id,
    delta: row.delta,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
    note: row.note,
    actor: row.actorId ? { id: row.actorId, name: row.actorName } : null,
    createdAt: row.createdAt.toISOString(),
  });
}

async function loadItem(tx: Database | Tx, variantId: string) {
  const [row] = await tx.$queryRaw<ItemRow[]>(Prisma.sql`${ITEM} WHERE v.id=${variantId}::uuid`);
  return row ? item(row) : null;
}

const MOVEMENT = Prisma.sql`
  SELECT m.id, m.delta, m.balance_after AS "balanceAfter", m.reason, m.note,
    m.actor_id AS "actorId", s.name AS "actorName", m.created_at AS "createdAt"
  FROM stock_movements m LEFT JOIN staff_users s ON s.id=m.actor_id`;

const like = (term: string) => "%" + term.replace(/[\\%_]/g, (c) => "\\" + c) + "%";

export async function listInventory(db: Database, actorId: string, input: InventoryQuery) {
  const query = inventoryQuerySchema.parse(input);
  await lockCatalogueActor(db, actorId, ["inventory.read"], false);
  const filters = [Prisma.sql`p.deleted_at IS NULL`];
  if (query.productId) filters.push(Prisma.sql`p.id=${query.productId}::uuid`);
  if (query.q)
    filters.push(Prisma.sql`(v.sku ILIKE ${like(query.q)} OR p.name ILIKE ${like(query.q)})`);
  if (query.state === "out") filters.push(Prisma.sql`v.stock_on_hand=0`);
  if (query.state === "low")
    filters.push(Prisma.sql`v.stock_on_hand>0 AND v.stock_on_hand<=v.low_stock_threshold`);
  if (query.state === "in_stock") filters.push(Prisma.sql`v.stock_on_hand>v.low_stock_threshold`);
  if (query.after) filters.push(Prisma.sql`v.id>${query.after}::uuid`);
  const rows = await db.$queryRaw<ItemRow[]>(Prisma.sql`
    ${ITEM} WHERE ${Prisma.join(filters, " AND ")} ORDER BY v.id LIMIT ${query.limit + 1}`);
  const items = rows.slice(0, query.limit).map(item);
  return {
    items,
    nextCursor: rows.length > query.limit ? (items.at(-1)?.variantId ?? null) : null,
  };
}

export async function listStockMovements(
  db: Database,
  actorId: string,
  variantId: string,
  input: StockMovementsQuery,
) {
  const query = stockMovementsQuerySchema.parse(input);
  await lockCatalogueActor(db, actorId, ["inventory.read"], false);
  return db.$transaction(
    async (tx) => {
      const current = await loadItem(tx as unknown as Tx, variantId);
      if (!current) throw new CatalogueNotFoundError();
      const rows = await tx.$queryRaw<MovementRow[]>(Prisma.sql`
        ${MOVEMENT} WHERE m.variant_id=${variantId}::uuid
        ${query.before ? Prisma.sql`AND m.id<${query.before}::uuid` : Prisma.empty}
        ORDER BY m.id DESC LIMIT ${query.limit + 1}`);
      const movements = rows.slice(0, query.limit).map(movement);
      return {
        item: current,
        movements,
        nextCursor: rows.length > query.limit ? (movements.at(-1)?.id ?? null) : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function databaseCode(error: unknown): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  if (error.code === "P2002") return "23505";
  const meta = error.meta as
    { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined;
  return meta?.code ?? meta?.driverAdapterError?.cause?.originalCode;
}

/** Upper bound of a variant's balance (variants_stock_max CHECK). */
export const MAX_STOCK = 100_000_000;

/**
 * The committed adjustment for this command ID, if any. A command ID names one user action, so
 * reusing it for another variant or another payload is refused (COMMAND_REUSED).
 */
async function existingCommand(
  tx: Database | Tx,
  variantId: string,
  command: { commandId: string; reason: string; delta: number; note?: string | undefined },
) {
  const [row] = await tx.$queryRaw<Array<MovementRow & { variantId: string }>>(Prisma.sql`
    SELECT q.*, m.variant_id AS "variantId" FROM (${MOVEMENT}
      WHERE m.command_id=${command.commandId} AND m.effect='adjust') q
    JOIN stock_movements m ON m.id=q.id`);
  if (!row) return null;
  const same =
    row.variantId === variantId &&
    row.reason === command.reason &&
    row.delta === command.delta &&
    row.note === (command.note ?? null);
  if (!same) throw new CatalogueConflictError("COMMAND_REUSED");
  return row;
}

export async function adjustStock(
  db: Database,
  context: CommandContext,
  variantId: string,
  input: StockAdjustmentRequest,
): Promise<StockAdjustmentResponse> {
  const command = stockAdjustmentRequestSchema.parse(input);
  try {
    return await withTransaction(db, async (tx) => {
      await lockCatalogueActor(tx, context.actorId, ["inventory.adjust"], true);
      const replay = await existingCommand(tx, variantId, command);
      if (replay) {
        const current = await loadItem(tx, variantId);
        return stockAdjustmentResponseSchema.parse({
          item: current,
          movement: movement(replay),
          replayed: true,
        });
      }
      const [before] = await tx.$queryRaw<Array<{ stock: number; movements: boolean }>>(
        Prisma.sql`
          SELECT stock_on_hand AS stock,
            EXISTS (SELECT 1 FROM stock_movements WHERE variant_id=${variantId}::uuid) AS movements
          FROM variants WHERE id=${variantId}::uuid FOR UPDATE`,
      );
      if (!before) throw new CatalogueNotFoundError();
      // A concurrent duplicate may have committed while this request waited for the row lock;
      // re-read (new statement, new snapshot) so it replays instead of failing a stock check.
      const raced = await existingCommand(tx, variantId, command);
      if (raced)
        return stockAdjustmentResponseSchema.parse({
          item: await loadItem(tx, variantId),
          movement: movement(raced),
          replayed: true,
        });
      if (command.reason === "INITIAL_STOCK" && before.movements)
        throw new CatalogueConflictError("INITIAL_STOCK_EXISTS");
      const balance = before.stock + command.delta;
      if (balance < 0) throw new CatalogueConflictError("INSUFFICIENT_STOCK");
      if (balance > MAX_STOCK) throw new CatalogueConflictError("STOCK_LIMIT");
      // Computed under the row lock; the trigger applies the delta and verifies this balance.
      const [inserted] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO stock_movements (variant_id, delta, balance_after, reason, note, command_id,
          actor_id)
        VALUES (${variantId}::uuid, ${command.delta}, ${balance}, ${command.reason},
          ${command.note ?? null},
          ${command.commandId}, ${context.actorId}::uuid)
        RETURNING id`);
      const [row] = await tx.$queryRaw<MovementRow[]>(
        Prisma.sql`${MOVEMENT} WHERE m.id=${inserted!.id}::uuid`,
      );
      await new PrismaAuditWriter().append(
        tx,
        toAuditEntry(context, {
          action: "inventory.adjusted",
          entity: { type: "variant", id: variantId },
          before: { stockOnHand: before.stock },
          after: {
            stockOnHand: row!.balanceAfter,
            delta: command.delta,
            reason: command.reason,
            // The note is free text written by staff; the audit only records that one was given.
            noteProvided: command.note !== undefined,
          },
        }),
      );
      return stockAdjustmentResponseSchema.parse({
        item: await loadItem(tx, variantId),
        movement: movement(row!),
        replayed: false,
      });
    });
  } catch (error) {
    // Stock checks run under the row lock, so a CHECK failure here is a bug and stays loud.
    const code = databaseCode(error);
    if (code === "23505") {
      // A concurrent request with the same command won; read the committed winner afresh.
      const winner = await existingCommand(db, variantId, command);
      if (winner)
        return stockAdjustmentResponseSchema.parse({
          item: await loadItem(db, variantId),
          movement: movement(winner),
          replayed: true,
        });
      if (command.reason === "INITIAL_STOCK")
        throw new CatalogueConflictError("INITIAL_STOCK_EXISTS");
    }
    throw error;
  }
}

/**
 * Variants whose balance differs from the sum of their ledger, or from the balance recorded by
 * their latest movement (should always be empty; alerting arrives with step 53).
 */
export async function stockReconciliationMismatches(db: Database) {
  return db.$queryRaw<
    Array<{ variantId: string; stockOnHand: number; ledgerSum: number; lastBalance: number | null }>
  >(Prisma.sql`
    SELECT v.id AS "variantId", v.stock_on_hand AS "stockOnHand",
      coalesce(s.total, 0)::int AS "ledgerSum", l.balance_after AS "lastBalance"
    FROM variants v
    LEFT JOIN (SELECT variant_id, sum(delta) AS total FROM stock_movements GROUP BY variant_id) s
      ON s.variant_id=v.id
    LEFT JOIN LATERAL (SELECT balance_after FROM stock_movements m WHERE m.variant_id=v.id
      ORDER BY m.id DESC LIMIT 1) l ON true
    WHERE v.stock_on_hand <> coalesce(s.total, 0)
       OR (l.balance_after IS NOT NULL AND l.balance_after <> v.stock_on_hand)`);
}
