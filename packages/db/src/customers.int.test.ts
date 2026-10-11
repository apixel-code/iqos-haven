import { randomUUID } from "node:crypto";
import {
  assertTestDatabase,
  integrationTestEnvSchema,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { InvalidCustomerNameError, InvalidPhoneError } from "@ih/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createPool } from "./client";
import {
  CustomerAddressAreaError,
  CustomerNotFoundError,
  findCustomerByPhone,
  lockCustomerForOrder,
  markCustomerFirstOrder,
  saveCustomerAddress,
} from "./customers";
import { applyMigrations } from "./test-schema";
import { withTransaction } from "./transaction";
loadLocalEnvFile();
const env = loadEnv(integrationTestEnvSchema);
assertTestDatabase(env.DATABASE_TEST_URL, process.env.DATABASE_URL);
const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
const pool = createPool({
  connectionString: env.DATABASE_TEST_URL,
  applicationName: "ih-customers-test",
  searchPath: namespace,
});
const db = createDatabase(pool, { schema: namespace });
// Synthetic numbers only: +97150000xxxx is never a real customer here.
let serial = 0;
const phone = () => "+97150000" + String(++serial).padStart(4, "0");
const rejected = (sql: string, params: unknown[] = [], code = "23514") =>
  expect(pool.query(sql, params)).rejects.toMatchObject({ code });
const columns = async (table: string) =>
  (
    await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
      [namespace, table],
    )
  ).rows.map((row) => row.column_name);
describe("guest customers and addresses (real PostgreSQL, isolated schema)", () => {
  let runtimeRole = false;
  let areaId = "";
  let otherAreaId = "";
  beforeAll(async () => {
    runtimeRole =
      (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'ih_app'")).rowCount === 1;
    if (process.env.CI) expect(runtimeRole).toBe(true);
    await applyMigrations(pool, namespace, runtimeRole ? { runtimeRole: "ih_app" } : {});
    const role = await db.role.findFirstOrThrow({ where: { key: "owner" } });
    const staff = await db.staffUser.create({
      data: {
        email: `customers-${randomUUID()}@iqoshaven.test`,
        name: "Seeder",
        roleId: role.id,
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo",
      },
    });
    const area = (code: string, active: boolean) =>
      db.deliveryArea.create({
        data: { code, name: "Synthetic " + code, active, updatedBy: staff.id },
      });
    areaId = (await area("synthetic_a", true)).id;
    otherAreaId = (await area("synthetic_b", false)).id;
  });
  afterAll(async () => {
    await db.$disconnect();
    await pool.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE');
    await pool.end();
  });
  it("adds two empty tables with no credential, email or session column", async () => {
    for (const table of ["customers", "customer_addresses"])
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    expect(await columns("customers")).toEqual([
      "id",
      "phone_e164",
      "display_name",
      "first_order_at",
      "no_show",
      "version",
      "created_at",
      "updated_at",
    ]);
    expect(await columns("customer_addresses")).toEqual([
      "id",
      "customer_id",
      "area_id",
      "type",
      "building",
      "unit",
      "street",
      "makani",
      "notes",
      "created_at",
    ]);
  });
  it("enforces the phone identity and field bounds in the database", async () => {
    const insert = "INSERT INTO customers (phone_e164,display_name) VALUES ($1,$2) RETURNING id";
    for (const bad of ["0501234567", "971501234567", "+0501234567", "+97150 000 0000", "+1234567"])
      await rejected(insert, [bad, "Synthetic"]);
    for (const bad of ["", " Synthetic", "Synthetic "]) await rejected(insert, [phone(), bad]);
    const number = phone();
    const id = (await pool.query<{ id: string }>(insert, [number, "Synthetic"])).rows[0]!.id;
    expect(id.split("-")[2]![0]).toBe("7");
    await rejected(insert, [number, "Another name"], "23505");
    await rejected("UPDATE customers SET phone_e164=$2 WHERE id=$1", [id, phone()]);
    await rejected("UPDATE customers SET version=0 WHERE id=$1", [id]);
    await pool.query("UPDATE customers SET version=3 WHERE id=$1", [id]);
    await rejected("UPDATE customers SET version=2 WHERE id=$1", [id]);
    await pool.query("UPDATE customers SET first_order_at=statement_timestamp() WHERE id=$1", [id]);
    await rejected("UPDATE customers SET first_order_at=NULL WHERE id=$1", [id]);
    await rejected(
      "UPDATE customers SET first_order_at=statement_timestamp()+interval '1 day' WHERE id=$1",
      [id],
    );
    const address =
      "INSERT INTO customer_addresses (customer_id,area_id,type,building,unit,makani,notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id";
    for (const bad of [
      [id, areaId, "hotel", "Tower", null, null, null],
      [id, areaId, "villa", "", null, null, null],
      [id, areaId, "villa", " Tower", null, null, null],
      [id, areaId, "apartment", "Tower", "", null, null],
      [id, areaId, "apartment", "Tower", "12", "123456789", null],
      [id, areaId, "apartment", "Tower", "12", "12345678ab", null],
      [id, areaId, "apartment", "Tower", "12", null, " "],
    ])
      await rejected(address, bad);
    await rejected(address, [id, areaId, "villa", "x".repeat(151), null, null, null], "22001");
    await rejected(address, [id, randomUUID(), "villa", "Villa 1", null, null, null], "23503");
    const saved = (
      await pool.query<{ id: string }>(address, [
        id,
        areaId,
        "apartment",
        "Tower",
        "12",
        "1234567890",
        "Synthetic note",
      ])
    ).rows[0]!.id;
    await rejected("UPDATE customer_addresses SET building='Other' WHERE id=$1", [saved]);
    // History never cascades: a customer or area that has an address cannot be removed.
    await rejected("DELETE FROM customers WHERE id=$1", [id], "23001");
    await rejected("DELETE FROM delivery_areas WHERE id=$1", [areaId], "23001");
  });
  it("maps every typed form of one number to one customer", async () => {
    const first = await withTransaction(db, (tx) =>
      lockCustomerForOrder(tx, { phone: "050 900 0001", displayName: "  Synthetic   Buyer " }),
    );
    expect(first.created).toBe(true);
    expect(first.customer).toMatchObject({
      phoneE164: "+971509000001",
      displayName: "Synthetic Buyer",
      firstOrderAt: null,
      noShow: false,
      version: 1,
    });
    for (const typed of ["+971 (0)50 900 0001", "00971509000001", "509000001", "971509000001"]) {
      const again = await withTransaction(db, (tx) =>
        lockCustomerForOrder(tx, { phone: typed, displayName: "Synthetic Buyer" }),
      );
      expect(again).toMatchObject({
        created: false,
        customer: { id: first.customer.id, version: 1 },
      });
    }
    expect((await findCustomerByPhone(db, "0509000001"))?.id).toBe(first.customer.id);
    expect(await findCustomerByPhone(db, "0509000002")).toBeNull();
    expect(await db.customer.count({ where: { phoneE164: "+971509000001" } })).toBe(1);
  });
  it("refuses bad input before any write and requires a unit of work", async () => {
    const before = await db.customer.count();
    await expect(
      withTransaction(db, (tx) => lockCustomerForOrder(tx, { phone: "12345", displayName: "A" })),
    ).rejects.toBeInstanceOf(InvalidPhoneError);
    await expect(
      withTransaction(db, (tx) => lockCustomerForOrder(tx, { phone: phone(), displayName: " " })),
    ).rejects.toBeInstanceOf(InvalidCustomerNameError);
    await expect(
      lockCustomerForOrder(db as never, { phone: phone(), displayName: "Synthetic" }),
    ).rejects.toThrow("unit of work");
    expect(await db.customer.count()).toBe(before);
  });
  it("creates exactly one customer when first orders of one phone race", async () => {
    const number = phone();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        withTransaction(db, (tx) =>
          lockCustomerForOrder(tx, { phone: number, displayName: "Synthetic Racer" }),
        ),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.customer.id)).size).toBe(1);
    expect(await db.customer.count({ where: { phoneE164: number } })).toBe(1);
  });
  it("holds the customer row lock until commit", async () => {
    const number = phone();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const holder = withTransaction(db, async (tx) => {
      await lockCustomerForOrder(tx, { phone: number, displayName: "Synthetic Holder" });
      entered();
      await gate;
      order.push("holder");
    });
    await inside;
    const waiter = withTransaction(db, async (tx) => {
      const result = await lockCustomerForOrder(tx, {
        phone: number,
        displayName: "Synthetic Waiter",
      });
      order.push("waiter");
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(order).toEqual([]);
    release();
    await holder;
    const result = await waiter;
    expect(order).toEqual(["holder", "waiter"]);
    expect(result).toMatchObject({
      created: false,
      customer: { displayName: "Synthetic Waiter", version: 2 },
    });
  });
  it("leaves no customer behind when the owning transaction rolls back", async () => {
    const number = phone();
    await expect(
      withTransaction(db, async (tx) => {
        await lockCustomerForOrder(tx, { phone: number, displayName: "Synthetic Rollback" });
        throw new Error("synthetic failure");
      }),
    ).rejects.toThrow("synthetic failure");
    expect(await findCustomerByPhone(db, number)).toBeNull();
  });
  it("stamps the first order time once", async () => {
    const number = phone();
    const stamped = await withTransaction(db, async (tx) => {
      const { customer } = await lockCustomerForOrder(tx, {
        phone: number,
        displayName: "Synthetic First",
      });
      return [
        await markCustomerFirstOrder(tx, customer.id),
        await markCustomerFirstOrder(tx, customer.id),
      ];
    });
    expect(stamped).toEqual([true, false]);
    const row = await findCustomerByPhone(db, number);
    expect(row?.firstOrderAt).toBeInstanceOf(Date);
    expect(row?.version).toBe(2);
  });
  it("saves addresses as immutable rows, reuses identical ones and survives a rename", async () => {
    const number = phone();
    const input = {
      areaId,
      type: "apartment" as const,
      building: "  Synthetic   Tower ",
      unit: "1204",
      street: " ",
      makani: "1234567890",
      notes: undefined,
    };
    const { customerId, first } = await withTransaction(db, async (tx) => {
      const { customer } = await lockCustomerForOrder(tx, {
        phone: number,
        displayName: "Synthetic Resident",
      });
      return { customerId: customer.id, first: await saveCustomerAddress(tx, customer.id, input) };
    });
    expect(first.created).toBe(true);
    expect(first.address).toMatchObject({
      customerId,
      areaId,
      type: "apartment",
      building: "Synthetic Tower",
      unit: "1204",
      street: null,
      makani: "1234567890",
      notes: null,
    });
    const again = await withTransaction(db, (tx) =>
      saveCustomerAddress(tx, customerId, { ...input, building: "Synthetic Tower", street: null }),
    );
    expect(again).toMatchObject({ created: false, address: { id: first.address.id } });
    // An inactive area is still a valid reference: deliverability is decided by the quote.
    const moved = await withTransaction(db, (tx) =>
      saveCustomerAddress(tx, customerId, { ...input, areaId: otherAreaId, unit: "1205" }),
    );
    expect(moved.created).toBe(true);
    expect(moved.address.id).not.toBe(first.address.id);
    await withTransaction(db, (tx) =>
      lockCustomerForOrder(tx, { phone: number, displayName: "Synthetic Renamed" }),
    );
    const rows = await db.customerAddress.findMany({
      where: { customerId },
      orderBy: { id: "asc" },
    });
    expect(rows).toEqual([first.address, moved.address]);
  });
  it("refuses an unknown customer, an unknown area and out-of-bounds fields", async () => {
    const number = phone();
    const { customer } = await withTransaction(db, (tx) =>
      lockCustomerForOrder(tx, { phone: number, displayName: "Synthetic Bounds" }),
    );
    const base = { areaId, type: "villa" as const, building: "Villa 24" };
    const save = (id: string, input: Parameters<typeof saveCustomerAddress>[2]) =>
      withTransaction(db, (tx) => saveCustomerAddress(tx, id, input));
    await expect(save(randomUUID(), base)).rejects.toBeInstanceOf(CustomerNotFoundError);
    await expect(save(customer.id, { ...base, areaId: randomUUID() })).rejects.toBeInstanceOf(
      CustomerAddressAreaError,
    );
    for (const bad of [
      { ...base, building: "  " },
      { ...base, building: "x".repeat(151) },
      { ...base, makani: "12345" },
      { ...base, notes: "x".repeat(501) },
      { ...base, type: "hotel" as never },
    ])
      await expect(save(customer.id, bad)).rejects.toThrow();
    await expect(saveCustomerAddress(db as never, customer.id, base)).rejects.toThrow(
      "unit of work",
    );
    expect(await db.customerAddress.count({ where: { customerId: customer.id } })).toBe(0);
  });
  it("gives the runtime role no way to delete customers or rewrite addresses", async () => {
    if (!runtimeRole) return;
    const privilege = async (table: string, name: string) =>
      (
        await pool.query<{ ok: boolean }>(
          `SELECT has_table_privilege('ih_app', $1 || '.${table}', '${name}') AS ok`,
          [namespace],
        )
      ).rows[0]!.ok;
    for (const table of ["customers", "customer_addresses"]) {
      expect(await privilege(table, "SELECT")).toBe(true);
      expect(await privilege(table, "INSERT")).toBe(true);
      expect(await privilege(table, "DELETE")).toBe(false);
      expect(await privilege(table, "TRUNCATE")).toBe(false);
    }
    expect(await privilege("customers", "UPDATE")).toBe(true);
    expect(await privilege("customer_addresses", "UPDATE")).toBe(false);
  });
});
