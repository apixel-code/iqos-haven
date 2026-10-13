import { customerAddressSchema, type CustomerAddressType } from "@ih/contracts";
import { normalizeCustomerName, normalizePhone, normalizeTextLine } from "@ih/domain";
import { Prisma, type Database, type Tx } from "./client";
import { holdsDeliveryArea, noteAreaReference } from "./delivery";
import { enterLockGroup, isUnitOfWork } from "./transaction";
export class CustomerNotFoundError extends Error {}
export class CustomerAddressAreaError extends Error {}
export interface CustomerIdentityInput {
  phone: string;
  displayName: string;
}
export interface CustomerAddressInput {
  areaId: string;
  type: CustomerAddressType;
  building: string;
  unit?: string | null | undefined;
  street?: string | null | undefined;
  makani?: string | null | undefined;
  notes?: string | null | undefined;
}
function unitOfWork(tx: Tx) {
  if (!isUnitOfWork(tx)) throw new Error("Customer writes require a unit of work");
}
/** Customer rows each open transaction already holds FOR UPDATE. */
const heldCustomers = new WeakMap<object, Set<string>>();
function hold(tx: Tx, customerId: string) {
  const held = heldCustomers.get(tx) ?? new Set<string>();
  heldCustomers.set(tx, held);
  held.add(customerId);
}
/** Locks the customer already owned by an existing order before later commerce resources. */
export async function lockExistingOrderCustomer(tx: Tx, customerId: string) {
  unitOfWork(tx);
  enterLockGroup(tx, "customer");
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM customers WHERE id=${customerId}::uuid FOR UPDATE`,
  );
  if (!rows.length) throw new CustomerNotFoundError();
  hold(tx, customerId);
}
/**
 * Customer group of the resource order (after the idempotency claim / existing order, before
 * settings and areas). Finds or creates the guest customer of a normalized phone and holds its
 * row lock until commit, so two concurrent first orders of one phone share one customer.
 * The latest typed name becomes the display name; orders keep their own snapshot (step 73).
 * The owning order/checkout command writes the audit entry and events in this same transaction:
 * this primitive writes neither, so nothing else may call it. Because a guest does not prove
 * the phone is theirs, staff views of an order must show that order's snapshot name.
 * Throws `InvalidPhoneError` / `InvalidCustomerNameError` before touching the database.
 */
export async function lockCustomerForOrder(tx: Tx, input: CustomerIdentityInput) {
  unitOfWork(tx);
  const phoneE164 = normalizePhone(input.phone);
  const displayName = normalizeCustomerName(input.displayName);
  enterLockGroup(tx, "customer");
  // DO NOTHING waits for a concurrent insert of the same phone instead of failing the
  // transaction with a unique violation; the locking read below then sees the winner.
  const created =
    (await tx.$executeRaw(
      Prisma.sql`INSERT INTO customers (phone_e164,display_name) VALUES (${phoneE164},${displayName}) ON CONFLICT (phone_e164) DO NOTHING`,
    )) === 1;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM customers WHERE phone_e164=${phoneE164} FOR UPDATE`);
  const row = await tx.customer.findUniqueOrThrow({ where: { phoneE164 } });
  hold(tx, row.id);
  if (row.displayName === displayName) return { customer: row, created };
  await tx.$executeRaw(
    Prisma.sql`UPDATE customers SET display_name=${displayName},version=version+1,updated_at=statement_timestamp() WHERE id=${row.id}::uuid`,
  );
  return { customer: await tx.customer.findUniqueOrThrow({ where: { id: row.id } }), created };
}
/** Stamps the first order time once; later calls change nothing. Caller holds the customer lock. */
export async function markCustomerFirstOrder(tx: Tx, customerId: string) {
  unitOfWork(tx);
  if (!heldCustomers.get(tx)?.has(customerId))
    throw new Error("Stamp the first order only for a customer locked in this unit of work");
  return (
    (await tx.$executeRaw(
      Prisma.sql`UPDATE customers SET first_order_at=statement_timestamp(),version=version+1,updated_at=statement_timestamp() WHERE id=${customerId}::uuid AND first_order_at IS NULL`,
    )) === 1
  );
}
/**
 * Saves a delivery address under the customer lock, reusing an identical saved row. Rows are
 * immutable, so a correction is a new row. Does not decide whether the area is deliverable:
 * `lockDeliverySelection` does. In an order, `lockCustomerForOrder` has taken the customer row
 * earlier and this runs after `lockDeliverySelection`: the insert takes a key-share lock on the
 * area row, which belongs after the settings lock in the resource order. Called on its own it
 * takes the customer lock itself, and refuses if a later lock group was already entered.
 * Same audit rule as `lockCustomerForOrder`.
 */
export async function saveCustomerAddress(tx: Tx, customerId: string, input: CustomerAddressInput) {
  unitOfWork(tx);
  const address = customerAddressSchema.parse({
    areaId: input.areaId,
    type: input.type,
    building: normalizeTextLine(input.building),
    unit: normalizeTextLine(input.unit),
    street: normalizeTextLine(input.street),
    makani: normalizeTextLine(input.makani),
    notes: normalizeTextLine(input.notes),
  });
  if (!heldCustomers.get(tx)?.has(customerId)) {
    enterLockGroup(tx, "customer");
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM customers WHERE id=${customerId}::uuid FOR UPDATE`,
    );
    if (!locked.length) throw new CustomerNotFoundError();
    hold(tx, customerId);
  }
  // The insert below takes a key-share lock on the area. Either the transaction already holds
  // that area (after the settings lock), or it must never ask for the delivery selection later.
  if (!holdsDeliveryArea(tx, address.areaId)) {
    enterLockGroup(tx, "delivery");
    noteAreaReference(tx);
  }
  const same = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM customer_addresses WHERE customer_id=${customerId}::uuid AND area_id=${address.areaId}::uuid AND type=${address.type} AND building=${address.building} AND unit IS NOT DISTINCT FROM ${address.unit}::text AND street IS NOT DISTINCT FROM ${address.street}::text AND makani IS NOT DISTINCT FROM ${address.makani}::text AND notes IS NOT DISTINCT FROM ${address.notes}::text ORDER BY created_at,id LIMIT 1`,
  );
  if (same[0])
    return {
      address: await tx.customerAddress.findUniqueOrThrow({ where: { id: same[0].id } }),
      created: false,
    };
  // Not a lock: the foreign key is the guard. This only turns a missing area into a typed error.
  const area = await tx.deliveryArea.findUnique({
    where: { id: address.areaId },
    select: { id: true },
  });
  if (!area) throw new CustomerAddressAreaError();
  return {
    address: await tx.customerAddress.create({ data: { ...address, customerId } }),
    created: true,
  };
}
/** Read by typed phone (any accepted form). No aggregate spend: that is permissioned (step 90). */
export async function findCustomerByPhone(db: Database | Tx, phone: string) {
  return db.customer.findUnique({ where: { phoneE164: normalizePhone(phone) } });
}
