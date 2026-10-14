"use client";
import { useState } from "react";
import {
  adminOrderResponseSchema,
  adminOrdersResponseSchema,
  orderCancelRequestSchema,
  orderCancelResponseSchema,
  orderCollectionCorrectionRequestSchema,
  orderCollectionRequestSchema,
  orderCollectionResponseSchema,
  orderEditRequestSchema,
  orderEditResponseSchema,
  orderTransitionResponseSchema,
  type AdminOrderResponse,
  type AdminOrderSummary,
  type OrderCancelRequest,
  type OrderCollectionCorrectionRequest,
  type OrderCollectionRequest,
  type OrderEditDiff,
  type OrderEditRequest,
} from "@ih/contracts";
import { managementRequest, validate } from "../lib/management";
import {
  addressLine,
  aedToFils,
  COD_STATUS_LABELS,
  inputInstant,
  localInstant,
  money,
  ORDER_STATUS_LABELS,
  when,
} from "../lib/orders";
import { ResourceNotice, useManagementResource } from "./management-resource";

const STATUSES = [
  "all",
  "pending",
  "confirmed",
  "processing",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;

/** Read-only order operations for step 83. Commands are added by the following roadmap steps. */
export function OrderManagement({
  canReadContact,
  canTransition,
  canEdit,
  canCancel,
  canReturn,
  canCollect,
  canCorrect,
}: {
  canReadContact: boolean;
  canTransition: boolean;
  canEdit: boolean;
  canCancel: boolean;
  canReturn: boolean;
  canCollect: boolean;
  canCorrect: boolean;
}) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: "25" });
  if (status !== "all") params.set("status", status);
  if (search) params.set("q", search);
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(to).toISOString());
  const cursor = cursors.at(-1);
  if (cursor) params.set("after", cursor);
  const orders = useManagementResource(`/orders?${params}`, adminOrdersResponseSchema);
  const resetPage = () => setCursors([]);
  if (selected)
    return (
      <OrderDetail
        id={selected}
        canReadContact={canReadContact}
        canTransition={canTransition}
        canEdit={canEdit}
        canCancel={canCancel}
        canReturn={canReturn}
        canCollect={canCollect}
        canCorrect={canCorrect}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <section className="management-card order-management">
      <header className="card-heading">
        <div>
          <h2>Orders</h2>
          <p className="muted">Newest first · immutable order snapshots</p>
        </div>
        <span className="badge">Live order operations</span>
      </header>
      <div className="tab-list" role="tablist" aria-label="Order status">
        {STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            className="secondary-button"
            aria-selected={status === value}
            onClick={() => {
              setStatus(value);
              resetPage();
            }}
          >
            {value === "all" ? "All" : ORDER_STATUS_LABELS[value]}
          </button>
        ))}
      </div>
      <form
        key={`${search}|${from}|${to}`}
        className="order-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setSearch(String(data.get("q") ?? "").trim());
          setFrom(String(data.get("from") ?? ""));
          setTo(String(data.get("to") ?? ""));
          resetPage();
        }}
      >
        <label className="wide-field">
          <span>Search {canReadContact ? "order number, customer or phone" : "order number"}</span>
          <input name="q" type="search" maxLength={100} defaultValue={search} />
        </label>
        <label>
          <span>Placed from</span>
          <input name="from" type="datetime-local" defaultValue={from} />
        </label>
        <label>
          <span>Placed before</span>
          <input name="to" type="datetime-local" defaultValue={to} />
        </label>
        <div className="form-actions wide-field">
          <button type="submit" className="primary-button">
            Apply filters
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSearch("");
              setFrom("");
              setTo("");
              setStatus("all");
              resetPage();
            }}
          >
            Clear filters
          </button>
        </div>
      </form>
      <ResourceNotice resource={orders} />
      {orders.data && (
        <>
          {orders.data.items.length === 0 ? (
            <p className="muted">No orders match these filters.</p>
          ) : (
            <div className="order-table-wrap">
              <table className="order-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Customer</th>
                    <th>Items</th>
                    <th>Amount</th>
                    <th>Payment</th>
                    <th>Status</th>
                    <th>Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.items.map((order) => (
                    <OrderRow key={order.id} order={order} open={() => setSelected(order.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={cursors.length === 0 || orders.busy}
              onClick={() => setCursors((value) => value.slice(0, -1))}
            >
              Previous page
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={!orders.data.nextCursor || orders.busy}
              onClick={() => setCursors((value) => [...value, orders.data!.nextCursor!])}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function OrderRow({ order, open }: { order: AdminOrderSummary; open: () => void }) {
  return (
    <tr tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
      <td>
        <button type="button" className="order-link" onClick={open}>
          {order.orderNumber}
        </button>
        <small>{order.source}</small>
      </td>
      <td>
        {order.customer ? (
          <>
            <strong>{order.customer.name}</strong>
            <small>{order.customer.phone}</small>
          </>
        ) : (
          <span className="muted">Contact hidden</span>
        )}
      </td>
      <td>{order.itemCount}</td>
      <td>{money(order.totalFils)}</td>
      <td>{COD_STATUS_LABELS[order.codStatus]}</td>
      <td>
        <span className={`order-status status-${order.status}`}>
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </td>
      <td>
        {when(order.createdAt)}
        <small>{order.areaName}</small>
      </td>
    </tr>
  );
}

type TransitionTarget = "confirmed" | "processing" | "out_for_delivery" | "delivered";
const NEXT: Partial<Record<AdminOrderResponse["status"], { to: TransitionTarget; label: string }>> =
  {
    pending: { to: "confirmed", label: "Confirm order" },
    confirmed: { to: "processing", label: "Start processing" },
    processing: { to: "out_for_delivery", label: "Mark out for delivery" },
    out_for_delivery: { to: "delivered", label: "Mark delivered" },
  };

function OrderDetail({
  id,
  canReadContact,
  canTransition,
  canEdit,
  canCancel,
  canReturn,
  canCollect,
  canCorrect,
  onBack,
}: {
  id: string;
  canReadContact: boolean;
  canTransition: boolean;
  canEdit: boolean;
  canCancel: boolean;
  canReturn: boolean;
  canCollect: boolean;
  canCorrect: boolean;
  onBack: () => void;
}) {
  const order = useManagementResource(`/orders/${id}`, adminOrderResponseSchema);
  const [pending, setPending] = useState<{
    commandId: string;
    expectedVersion: number;
    to: TransitionTarget;
  } | null>(null);
  const activePending = pending && order.data?.version === pending.expectedVersion ? pending : null;
  const action = order.data ? NEXT[order.data.status] : undefined;
  async function submitTransition() {
    if (!order.data || !action) return;
    const command = activePending ?? {
      commandId: crypto.randomUUID(),
      expectedVersion: order.data.version,
      to: action.to,
    };
    if (!activePending && !window.confirm(`${action.label} for ${order.data.orderNumber}?`)) return;
    setPending(command);
    const result = await order.run((signal) =>
      managementRequest(
        `/orders/${id}/transitions`,
        orderTransitionResponseSchema,
        "POST",
        command,
        signal,
      ),
    );
    if (result.ok) {
      setPending(null);
      order.reload();
    }
  }
  return (
    <section className="management-card order-detail">
      <div>
        <button type="button" className="secondary-button" onClick={onBack}>
          ← Back to orders
        </button>
      </div>
      <ResourceNotice resource={order} />
      {order.data && (
        <>
          {canTransition && action && (
            <div className="form-actions">
              <button
                type="button"
                className="primary-button"
                disabled={order.disabled}
                onClick={() => void submitTransition()}
              >
                {activePending ? `Retry: ${action.label}` : action.label}
              </button>
              <small className="muted">
                Uses version {activePending?.expectedVersion ?? order.data.version}; the same
                command is retried safely.
              </small>
            </div>
          )}
          {canEdit && ["pending", "confirmed", "processing"].includes(order.data.status) && (
            <OrderEditPanel
              key={`${order.data.id}:${order.data.version}`}
              order={order.data}
              canReadContact={canReadContact}
              disabled={order.disabled}
              save={(request) =>
                order.run((signal) =>
                  managementRequest(
                    `/orders/${id}`,
                    orderEditResponseSchema,
                    "PATCH",
                    request,
                    signal,
                  ),
                )
              }
              done={order.reload}
            />
          )}
          {((canCancel && ["pending", "confirmed", "processing"].includes(order.data.status)) ||
            (canCancel && canReturn && order.data.status === "out_for_delivery")) && (
            <OrderCancelPanel
              key={`cancel:${order.data.id}:${order.data.version}`}
              order={order.data}
              disabled={order.disabled}
              save={(request) =>
                order.run((signal) =>
                  managementRequest(
                    `/orders/${id}/cancel`,
                    orderCancelResponseSchema,
                    "POST",
                    request,
                    signal,
                  ),
                )
              }
              done={order.reload}
            />
          )}
          {((canCollect &&
            order.data.status === "delivered" &&
            order.data.codStatus === "pending") ||
            (canCorrect && order.data.codStatus === "collected")) && (
            <OrderCollectionPanel
              key={`collection:${order.data.id}:${order.data.version}`}
              order={order.data}
              disabled={order.disabled}
              record={(request) =>
                order.run((signal) =>
                  managementRequest(
                    `/orders/${id}/collection`,
                    orderCollectionResponseSchema,
                    "POST",
                    request,
                    signal,
                  ),
                )
              }
              correct={(request) =>
                order.run((signal) =>
                  managementRequest(
                    `/orders/${id}/collection/corrections`,
                    orderCollectionResponseSchema,
                    "POST",
                    request,
                    signal,
                  ),
                )
              }
              done={order.reload}
            />
          )}
          <OrderDetailBody order={order.data} />
        </>
      )}
    </section>
  );
}

function sameAddress(order: AdminOrderResponse, data: FormData) {
  const address = order.customer?.address;
  if (!address) return true;
  const value = (name: string) => String(data.get(name) ?? "").trim() || null;
  return (
    value("address.type") === address.type &&
    value("address.building") === address.building &&
    value("address.unit") === address.unit &&
    value("address.street") === address.street &&
    value("address.makani") === address.makani &&
    value("address.notes") === address.notes
  );
}

function editCommand(order: AdminOrderResponse, data: FormData): OrderEditRequest {
  const command: Record<string, unknown> = {
    expectedVersion: order.version,
    commandId: crypto.randomUUID(),
  };
  if (order.status !== "processing") {
    const lines = order.items
      .filter((item) => item.variantId)
      .map((item) => ({
        variantId: item.variantId!,
        quantity: Number(data.get(`quantity.${item.variantId}`)),
      }))
      .filter((line) => line.quantity > 0);
    const addedId = String(data.get("addedVariantId") ?? "").trim();
    const addedQuantity = Number(data.get("addedQuantity") ?? 1);
    if (addedId) lines.push({ variantId: addedId, quantity: addedQuantity });
    const quantitiesChanged =
      Boolean(addedId) ||
      lines.length !== order.items.length ||
      order.items.some(
        (item) =>
          !item.variantId ||
          lines.find((line) => line.variantId === item.variantId)?.quantity !== item.quantity,
      );
    if (quantitiesChanged) command.lines = lines;
    const coupon = String(data.get("couponCode") ?? "").trim() || null;
    if (coupon !== (order.coupon?.code ?? null)) command.couponCode = coupon;
    if (order.customer && order.area.id && !sameAddress(order, data))
      command.address = {
        areaId: order.area.id,
        type: String(data.get("address.type")),
        building: String(data.get("address.building") ?? "").trim(),
        unit: String(data.get("address.unit") ?? "").trim() || null,
        street: String(data.get("address.street") ?? "").trim() || null,
        makani: String(data.get("address.makani") ?? "").trim() || null,
        notes: String(data.get("address.notes") ?? "").trim() || null,
      };
  }
  const note = String(data.get("operationalNote") ?? "").trim() || null;
  if (note !== order.operationalNote) command.operationalNote = note;
  return validate(orderEditRequestSchema, command);
}

/**
 * Cash on delivery (step 87). Delivered never records cash: staff record what was received.
 * Once recorded, only the Owner corrects it, with a reason; the original record stays. The
 * command ID is kept while the order version is unchanged, so pressing again is safe.
 */
function OrderCollectionPanel({
  order,
  disabled,
  record,
  correct,
  done,
}: {
  order: AdminOrderResponse;
  disabled: boolean;
  record: (request: OrderCollectionRequest) => Promise<{ ok: boolean }>;
  correct: (request: OrderCollectionCorrectionRequest) => Promise<{ ok: boolean }>;
  done: () => void;
}) {
  const correcting = order.codStatus === "collected";
  const current = order.collectionRecords.at(-1);
  const [commandId] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  return (
    <article className="record-card">
      <h3>{correcting ? "Correct cash record" : "Record cash collected"}</h3>
      <p className="muted">
        {correcting
          ? "Owner only. The original record stays; the correction is added with its reason."
          : `Record the cash actually received for this delivered order (order total ${money(order.totalFils)}).`}
      </p>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const amountFils = aedToFils(String(data.get("amount") ?? ""));
          const reference = String(data.get("reference") ?? "").trim() || null;
          const typed = String(data.get("collectedAt") ?? "");
          // The input shows minutes only: an untouched field keeps the exact recorded time.
          const at =
            current && typed === inputInstant(current.collectedAt)
              ? current.collectedAt
              : localInstant(typed);
          if (amountFils === null) {
            setMessage("Enter the amount in AED, for example 65 or 65.50.");
            return;
          }
          try {
            if (correcting) {
              const request = validate(orderCollectionCorrectionRequestSchema, {
                expectedVersion: order.version,
                commandId,
                reason: String(data.get("reason") ?? ""),
                amountFils,
                reference,
                collectedAt: at,
              });
              if (!window.confirm(`Correct the cash record of ${order.orderNumber}?`)) return;
              setMessage("");
              void correct(request).then((result) => result.ok && done());
            } else {
              const request = validate(orderCollectionRequestSchema, {
                expectedVersion: order.version,
                commandId,
                amountFils,
                ...(reference ? { reference } : {}),
                ...(at ? { collectedAt: at } : {}),
              });
              const differs =
                amountFils !== order.totalFils
                  ? ` This differs from the order total of ${money(order.totalFils)}.`
                  : "";
              if (
                !window.confirm(
                  `Record ${money(amountFils)} collected for ${order.orderNumber}?${differs}`,
                )
              )
                return;
              setMessage("");
              void record(request).then((result) => result.ok && done());
            }
          } catch {
            setMessage(
              correcting
                ? "Enter a reason, the amount and the time the cash was received."
                : "Check the amount, reference and time.",
            );
          }
        }}
      >
        <label>
          <span>Amount received (AED)</span>
          <input
            name="amount"
            inputMode="decimal"
            required
            defaultValue={((current?.amountFils ?? order.totalFils) / 100).toFixed(2)}
          />
        </label>
        <label>
          <span>Reference (optional)</span>
          <input name="reference" maxLength={100} defaultValue={current?.reference ?? ""} />
        </label>
        <label>
          <span>{correcting ? "Received at" : "Received at (leave empty for now)"}</span>
          <input
            name="collectedAt"
            type="datetime-local"
            required={correcting}
            defaultValue={current ? inputInstant(current.collectedAt) : ""}
          />
        </label>
        {correcting && (
          <label className="wide-field">
            <span>Reason for the correction</span>
            <textarea name="reason" maxLength={500} required rows={2} />
          </label>
        )}
        {message && (
          <p role="alert" className="wide-field">
            {message}
          </p>
        )}
        <div className="form-actions wide-field">
          <button type="submit" className="primary-button" disabled={disabled}>
            {correcting ? "Save correction" : "Record cash collected"}
          </button>
          <small className="muted">
            Uses version {order.version}; the same command is retried safely.
          </small>
        </div>
      </form>
    </article>
  );
}

/**
 * Cancellation (step 86). Before handoff a reason is enough and every unit goes back to stock.
 * Out for Delivery is the Owner's return: each line is split into resellable and damaged units,
 * and only resellable units go back. The command ID is kept while the order version is
 * unchanged, so pressing again after an unclear answer is safe.
 */
function OrderCancelPanel({
  order,
  disabled,
  save,
  done,
}: {
  order: AdminOrderResponse;
  disabled: boolean;
  save: (request: OrderCancelRequest) => Promise<{ ok: boolean }>;
  done: () => void;
}) {
  const returned = order.status === "out_for_delivery";
  const [commandId] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const missingIds = returned && order.items.some((item) => !item.variantId);
  return (
    <article className="record-card">
      <h3>{returned ? "Cancel after return" : "Cancel order"}</h3>
      <p className="muted">
        {returned
          ? "Only after the goods have come back. Split every item into resellable and damaged units: resellable units go back to stock, damaged units are recorded."
          : "Every unit goes back to stock and any coupon use is released. This cannot be undone."}
      </p>
      {missingIds ? (
        <p className="muted">Item details for a return need the order edit permission.</p>
      ) : (
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const count = (name: string) => Number(data.get(name) ?? "");
            let request: OrderCancelRequest;
            try {
              request = validate(orderCancelRequestSchema, {
                expectedVersion: order.version,
                commandId,
                reason: String(data.get("reason") ?? ""),
                ...(returned
                  ? {
                      returnItems: order.items.map((item) => ({
                        variantId: item.variantId,
                        resellableQuantity: count(`resellable.${item.id}`),
                        damagedQuantity: count(`damaged.${item.id}`),
                      })),
                    }
                  : {}),
              });
            } catch {
              setMessage("Enter a reason and whole numbers for every item.");
              return;
            }
            const split = request.returnItems ?? [];
            if (
              order.items.some((item) => {
                const line = split.find((entry) => entry.variantId === item.variantId);
                return (
                  returned &&
                  (!line || line.resellableQuantity + line.damagedQuantity !== item.quantity)
                );
              })
            ) {
              setMessage(
                "For every item, resellable and damaged units must add up to the quantity sent.",
              );
              return;
            }
            if (!window.confirm(`Cancel ${order.orderNumber}? This cannot be undone.`)) return;
            setMessage("");
            void save(request).then((result) => result.ok && done());
          }}
        >
          {returned &&
            order.items.map((item) => (
              <fieldset key={item.id} className="wide-field">
                <legend>
                  {item.productName} · {item.sku} · {item.quantity} sent
                </legend>
                <label>
                  <span>Resellable</span>
                  <input
                    name={`resellable.${item.id}`}
                    type="number"
                    min={0}
                    max={item.quantity}
                    step={1}
                    defaultValue={item.quantity}
                    required
                  />
                </label>
                <label>
                  <span>Damaged</span>
                  <input
                    name={`damaged.${item.id}`}
                    type="number"
                    min={0}
                    max={item.quantity}
                    step={1}
                    defaultValue={0}
                    required
                  />
                </label>
              </fieldset>
            ))}
          <label className="wide-field">
            <span>Reason</span>
            <textarea name="reason" maxLength={500} required rows={2} />
          </label>
          {message && (
            <p role="alert" className="wide-field">
              {message}
            </p>
          )}
          <div className="form-actions wide-field">
            <button type="submit" className="danger-button" disabled={disabled}>
              {returned ? "Cancel and record return" : "Cancel order"}
            </button>
            <small className="muted">
              Uses version {order.version}; the same command is retried safely.
            </small>
          </div>
        </form>
      )}
    </article>
  );
}

function OrderEditPanel({
  order,
  canReadContact,
  disabled,
  save,
  done,
}: {
  order: AdminOrderResponse;
  canReadContact: boolean;
  disabled: boolean;
  save: (request: OrderEditRequest) => Promise<{ ok: boolean }>;
  done: () => void;
}) {
  const commerce = order.status === "pending" || order.status === "confirmed";
  const [validationMessage, setValidationMessage] = useState("");
  return (
    <article className="record-card">
      <h3>Edit order</h3>
      <p className="muted">
        {commerce
          ? "Quantities, coupon, delivery address and the operational note can be changed before processing. Set a quantity to zero to remove that item."
          : "Only the operational note can change while this order is processing."}
      </p>
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          let request: OrderEditRequest;
          try {
            request = editCommand(order, new FormData(event.currentTarget));
            setValidationMessage("");
          } catch {
            setValidationMessage("Change at least one valid field before saving.");
            return;
          }
          void save(request).then((result) => result.ok && done());
        }}
      >
        {commerce && (
          <>
            {order.items.map((item) => (
              <label key={item.id}>
                <span>
                  {item.productName} · {item.sku}
                </span>
                <input
                  name={`quantity.${item.variantId}`}
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  defaultValue={item.quantity}
                  required
                />
              </label>
            ))}
            <label>
              <span>Add variant ID</span>
              <input name="addedVariantId" type="text" placeholder="UUID" />
            </label>
            <label>
              <span>Added quantity</span>
              <input name="addedQuantity" type="number" min={1} max={10} defaultValue={1} />
            </label>
            <label>
              <span>Coupon code</span>
              <input
                name="couponCode"
                type="text"
                maxLength={32}
                defaultValue={order.coupon?.code ?? ""}
              />
            </label>
            {canReadContact && order.customer && order.area.id && (
              <>
                <label>
                  <span>Address type</span>
                  <select name="address.type" defaultValue={order.customer.address.type}>
                    <option value="apartment">Apartment</option>
                    <option value="villa">Villa</option>
                    <option value="office">Office</option>
                  </select>
                </label>
                <label>
                  <span>Building</span>
                  <input
                    name="address.building"
                    maxLength={150}
                    defaultValue={order.customer.address.building}
                    required
                  />
                </label>
                <label>
                  <span>Unit</span>
                  <input
                    name="address.unit"
                    maxLength={50}
                    defaultValue={order.customer.address.unit ?? ""}
                  />
                </label>
                <label>
                  <span>Street</span>
                  <input
                    name="address.street"
                    maxLength={150}
                    defaultValue={order.customer.address.street ?? ""}
                  />
                </label>
                <label>
                  <span>Makani</span>
                  <input
                    name="address.makani"
                    maxLength={10}
                    defaultValue={order.customer.address.makani ?? ""}
                  />
                </label>
                <label className="wide-field">
                  <span>Delivery notes</span>
                  <textarea
                    name="address.notes"
                    maxLength={500}
                    rows={2}
                    defaultValue={order.customer.address.notes ?? ""}
                  />
                </label>
              </>
            )}
          </>
        )}
        <label className="wide-field">
          <span>Operational note</span>
          <textarea
            name="operationalNote"
            maxLength={500}
            rows={3}
            defaultValue={order.operationalNote ?? ""}
          />
        </label>
        <div className="form-actions wide-field">
          <button type="submit" className="primary-button" disabled={disabled}>
            Save order edit
          </button>
          <small className="muted">
            Uses order version {order.version}; concurrent changes are refused.
          </small>
        </div>
        {validationMessage && <p className="form-error wide-field">{validationMessage}</p>}
      </form>
    </article>
  );
}

function editDiffLines(diff: OrderEditDiff) {
  const lines: string[] = [];
  if (diff.items) {
    const show = (items: typeof diff.items.before) =>
      items.map((item) => `${item.sku} × ${item.quantity}`).join(", ") || "none";
    lines.push(`Items: ${show(diff.items.before)} → ${show(diff.items.after)}`);
  }
  if (diff.coupon)
    lines.push(`Coupon: ${diff.coupon.before ?? "none"} → ${diff.coupon.after ?? "none"}`);
  if (diff.delivery)
    lines.push(
      `Delivery address updated: ${diff.delivery.beforeArea} → ${diff.delivery.afterArea}`,
    );
  if (diff.operationalNote)
    lines.push(`Operational note: ${diff.operationalNote.after ?? "cleared"}`);
  if (diff.total)
    lines.push(`Total: ${money(diff.total.beforeFils)} → ${money(diff.total.afterFils)}`);
  return lines;
}

function OrderDetailBody({ order }: { order: AdminOrderResponse }) {
  return (
    <>
      <header className="card-heading">
        <div>
          <h2>{order.orderNumber}</h2>
          <p className="muted">
            Placed {when(order.createdAt)} · {order.source} · version {order.version}
          </p>
        </div>
        <span className={`order-status status-${order.status}`}>
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </header>
      <div className="order-detail-grid">
        <article className="record-card">
          <h3>Customer & delivery</h3>
          {order.customer ? (
            <>
              <strong>{order.customer.name}</strong>
              <a href={`tel:${order.customer.phone}`}>{order.customer.phone}</a>
              <p>{addressLine(order)}</p>
              {order.customer.address.makani && <p>Makani: {order.customer.address.makani}</p>}
              {order.customer.address.notes && (
                <p className="muted">{order.customer.address.notes}</p>
              )}
            </>
          ) : (
            <p className="muted">Customer contact requires Customers permission.</p>
          )}
          <p className="muted">{order.deliveryEtaText}</p>
        </article>
        <article className="record-card">
          <h3>Payment</h3>
          <p>{COD_STATUS_LABELS[order.codStatus]}</p>
          <dl className="order-totals">
            <div>
              <dt>Merchandise</dt>
              <dd>{money(order.merchandiseSubtotalFils)}</dd>
            </div>
            <div>
              <dt>Discount</dt>
              <dd>−{money(order.discountFils)}</dd>
            </div>
            <div>
              <dt>Delivery</dt>
              <dd>{money(order.deliveryFeeFils)}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>
                <strong>{money(order.totalFils)}</strong>
              </dd>
            </div>
          </dl>
          {order.coupon && (
            <p className="muted">
              Coupon {order.coupon.code} · {order.coupon.percentBps / 100}%
            </p>
          )}
          {order.collectionRecords.length > 0 && (
            <ol className="order-history">
              {order.collectionRecords.map((entry, index) => (
                <li key={entry.id}>
                  <span className="badge">
                    {entry.kind === "recorded" ? "Recorded" : "Corrected"}
                    {index === order.collectionRecords.length - 1 ? " · in effect" : ""}
                  </span>
                  <div>
                    <strong>
                      {money(entry.amountFils)} · received {when(entry.collectedAt)}
                    </strong>
                    <small>
                      {entry.actor.name} · {when(entry.recordedAt)}
                      {entry.reference ? ` · ${entry.reference}` : ""}
                    </small>
                    {entry.reason && <p>{entry.reason}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </article>
      </div>
      <article className="record-card">
        <h3>Items</h3>
        <div className="record-list">
          {order.items.map((item) => (
            <div className="order-item" key={item.id}>
              <div>
                <strong>{item.productName}</strong>
                <small>
                  {item.brandName} · {item.categoryName} · {item.sku}
                </small>
                <small>{Object.values(item.attributes).join(" · ") || "Standard"}</small>
              </div>
              <div>
                {item.quantity} × {money(item.unitPriceFils)}
                <strong>{money(item.totalFils)}</strong>
              </div>
            </div>
          ))}
        </div>
      </article>
      {order.returnItems.length > 0 && (
        <article className="record-card">
          <h3>Return</h3>
          <ul className="record-list">
            {order.returnItems.map((item) => (
              <li key={item.sku}>
                {item.sku}: {item.quantity} sent · {item.resellableQuantity} back in stock ·{" "}
                {item.damagedQuantity} damaged
              </li>
            ))}
          </ul>
        </article>
      )}
      {order.edits.length > 0 && (
        <article className="record-card">
          <h3>Edit history</h3>
          <ol className="order-history">
            {order.edits.map((edit) => (
              <li key={edit.id}>
                <span className="badge">v{edit.orderVersion}</span>
                <div>
                  <strong>{edit.actor.name}</strong>
                  <small>{when(edit.editedAt)}</small>
                  {editDiffLines(edit.diff).map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </article>
      )}
      <article className="record-card">
        <h3>History</h3>
        <ol className="order-history">
          {order.history.map((entry) => (
            <li key={entry.id}>
              <span className={`order-status status-${entry.toStatus}`}>
                {ORDER_STATUS_LABELS[entry.toStatus]}
              </span>
              <div>
                <strong>
                  {entry.actorName ??
                    (entry.actorKind === "customer" ? "Customer checkout" : "System")}
                </strong>
                <small>
                  {when(entry.createdAt)} · version {entry.orderVersion}
                </small>
                {entry.reason && <p>{entry.reason}</p>}
              </div>
            </li>
          ))}
        </ol>
      </article>
    </>
  );
}
