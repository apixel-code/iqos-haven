"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { useState } from "react";
import {
  adminOrderResponseSchema,
  adminOrderCountsResponseSchema,
  adminOrdersResponseSchema,
  ADMIN_ORDER_SORTS,
  type AdminOrderSort,
  orderBulkConfirmResponseSchema,
  orderCancelRequestSchema,
  orderCancelResponseSchema,
  orderCollectionCorrectionRequestSchema,
  orderCollectionRequestSchema,
  orderCollectionResponseSchema,
  orderEditRequestSchema,
  orderEditResponseSchema,
  orderTransitionResponseSchema,
  orderWhatsappResponseSchema,
  reviewLinkResponseSchema,
  type AdminOrderResponse,
  type AdminOrderSummary,
  type OrderBulkConfirmResponse,
  type OrderCancelRequest,
  type OrderCollectionCorrectionRequest,
  type OrderCollectionRequest,
  type OrderEditDiff,
  type OrderEditRequest,
  type OrderItemChoice,
  type ReviewLinkResponse,
} from "@ih/contracts";
import { ApiError } from "../lib/auth";
import { isUuid } from "../lib/links";
import { managementError, managementRequest, validate } from "../lib/management";
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
import { ManualOrderPanel } from "./manual-order";
import { choiceLabel, OrderItemPicker } from "./order-item-picker";
import { PackingSlip } from "./packing-slip";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { useUrlQuery } from "./use-url-query";

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
  canCreate,
}: {
  canCreate: boolean;
  canReadContact: boolean;
  canTransition: boolean;
  canEdit: boolean;
  canCancel: boolean;
  canReturn: boolean;
  canCollect: boolean;
  canCorrect: boolean;
}) {
  // The open order and the status/delayed filters live in the URL (parity G-A2), so a link from
  // the bell, the dashboard, a customer or a review opens exactly that view, and Back works.
  const { get: query, navigate } = useUrlQuery();
  const urlStatus = query("status");
  const status = STATUSES.find((value) => value === urlStatus) ?? "all";
  const setStatus = (value: (typeof STATUSES)[number]) =>
    navigate({ status: value === "all" ? null : value });
  const delayed = query("delayed") === "1";
  const urlSort = query("sort");
  const sort: AdminOrderSort = ADMIN_ORDER_SORTS.find((value) => value === urlSort) ?? "newest";
  const urlOrder = query("order");
  const selected = isUuid(urlOrder) ? urlOrder : null;
  const setSelected = (id: string | null) => navigate({ order: id }, true);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  // `?new=1` (the dashboard's "Create order") opens the manual order form.
  const [creating, setCreatingState] = useState(() => canCreate && query("new") === "1");
  const setCreating = (on: boolean) => {
    setCreatingState(on);
    if (!on && query("new")) navigate({ new: null });
  };
  // Bulk confirm (step 89): chosen Pending orders with the version seen and one command ID each.
  // An unclear answer keeps the same batch, so "Retry" replays instead of confirming twice.
  const [chosen, setChosen] = useState<
    Map<string, { orderNumber: string; expectedVersion: number; commandId: string }>
  >(new Map());
  const [confirming, setConfirming] = useState(false);
  const [bulkMessage, setBulkMessage] = useState("");
  const [bulkResults, setBulkResults] = useState<
    Array<OrderBulkConfirmResponse["results"][number] & { orderNumber: string }>
  >([]);
  const [unclear, setUnclear] = useState(false);
  async function confirmChosen() {
    const batch = [...chosen.entries()];
    if (
      !unclear &&
      !(await confirmDialog({
        title: `Confirm ${batch.length} ${batch.length === 1 ? "order" : "orders"}?`,
        ok: "Confirm orders",
      }))
    )
      return;
    setConfirming(true);
    setBulkMessage("");
    try {
      const response = await managementRequest(
        "/orders/bulk-confirm",
        orderBulkConfirmResponseSchema,
        "POST",
        {
          orders: batch.map(([orderId, item]) => ({
            orderId,
            expectedVersion: item.expectedVersion,
            commandId: item.commandId,
          })),
        },
      );
      setBulkResults(
        response.results.map((result) => ({
          ...result,
          orderNumber: chosen.get(result.orderId)?.orderNumber ?? result.orderId,
        })),
      );
      setChosen(new Map());
      setUnclear(false);
      orders.reload();
      counts.reload();
    } catch (error) {
      // No answer or a server error: some orders may be confirmed. Keep the batch to retry.
      // A refusal of the whole request (4xx other than "too many") applied nothing.
      const settled =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429;
      setUnclear(!settled);
      if (settled) setChosen(new Map());
      setBulkMessage(managementError(error, true));
    } finally {
      setConfirming(false);
    }
  }
  // The filters every tab shares; the tab counts are taken under them (parity G-A5).
  const shared = new URLSearchParams();
  if (delayed) shared.set("delayed", "true");
  if (search) shared.set("q", search);
  if (from) shared.set("from", new Date(from).toISOString());
  if (to) shared.set("to", new Date(to).toISOString());
  const counts = useManagementResource(
    `/orders/counts${shared.size ? `?${shared}` : ""}`,
    adminOrderCountsResponseSchema,
  );
  const params = new URLSearchParams(shared);
  params.set("limit", "25");
  if (status !== "all") params.set("status", status);
  if (sort !== "newest") params.set("sort", sort);
  // A link can change the filters while this list is open: start again from the first page.
  const filterScope = `${status}|${delayed}|${sort}`;
  const [pagedScope, setPagedScope] = useState(filterScope);
  if (pagedScope !== filterScope) {
    setPagedScope(filterScope);
    setCursors([]);
  }
  const cursor = cursors.at(-1);
  if (cursor) params.set("after", cursor);
  const orders = useManagementResource(`/orders?${params}`, adminOrdersResponseSchema);
  // Select-all on this page (parity G-A5): the pending orders shown, within the batch limit.
  const pageItems = orders.data?.items ?? [];
  const selectablePending = pageItems.filter((order) => order.status === "pending");
  const allPendingChosen =
    selectablePending.length > 0 && selectablePending.every((order) => chosen.has(order.id));
  const somePendingChosen = selectablePending.some((order) => chosen.has(order.id));
  const choose = (order: (typeof pageItems)[number], on: boolean) =>
    setChosen((current) => {
      const next = new Map(current);
      if (on && next.size < 50)
        next.set(order.id, {
          orderNumber: order.orderNumber,
          expectedVersion: order.version,
          commandId: crypto.randomUUID(),
        });
      if (!on) next.delete(order.id);
      return next;
    });
  const chooseAllPending = (on: boolean) => {
    for (const order of selectablePending) if (on !== chosen.has(order.id)) choose(order, on);
  };
  const resetPage = () => {
    setCursors([]);
    // A selection belongs to the list it was made in.
    if (!unclear) setChosen(new Map());
  };
  if (creating)
    return (
      <ManualOrderPanel
        canConfirm={canTransition}
        canLookUp={canReadContact}
        onCancel={() => setCreating(false)}
        onCreated={(orderId) => {
          setCreating(false);
          setSelected(orderId);
        }}
      />
    );
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
          <p className="muted">
            {counts.data
              ? `${counts.data.all} ${counts.data.all === 1 ? "order" : "orders"} · ${counts.data.pending} waiting for confirmation`
              : "Immutable order snapshots"}
          </p>
        </div>
        {canCreate ? (
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            New order
          </button>
        ) : (
          <span className="badge">Live order operations</span>
        )}
      </header>
      {/* The status tabs are a tablist; the delayed filter is a separate toggle beside it. */}
      <div className="order-filter-row">
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
              {counts.data && <span className="tab-count">{counts.data[value]}</span>}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="secondary-button"
          aria-pressed={delayed}
          onClick={() => {
            navigate({ delayed: delayed ? null : "1" });
            resetPage();
          }}
        >
          Delayed only
        </button>
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
        <label>
          <span>Sort</span>
          <select
            value={sort}
            onChange={(event) => {
              navigate({ sort: event.target.value === "newest" ? null : event.target.value });
              resetPage();
            }}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="total_desc">Highest amount</option>
            <option value="total_asc">Lowest amount</option>
          </select>
        </label>
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
              navigate({ status: null, delayed: null });
              resetPage();
            }}
          >
            Clear filters
          </button>
        </div>
      </form>
      <ResourceNotice resource={orders} />
      {canTransition && (chosen.size > 0 || bulkResults.length > 0 || bulkMessage) && (
        <div className="record-card">
          {chosen.size > 0 && (
            <div className="form-actions">
              <button
                type="button"
                className="primary-button"
                disabled={confirming}
                onClick={() => void confirmChosen()}
              >
                {unclear ? `Retry confirming ${chosen.size}` : `Confirm selected (${chosen.size})`}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={confirming}
                onClick={() => {
                  // Safe after an unclear answer too: a fresh selection re-checks each order's
                  // version, so nothing can be confirmed twice.
                  setChosen(new Map());
                  setUnclear(false);
                  if (unclear) orders.reload();
                }}
              >
                {unclear ? "Discard and reload" : "Clear selection"}
              </button>
              <small className="muted">
                At most 50 at a time; each order is confirmed on its own.
              </small>
            </div>
          )}
          {bulkMessage && <p role="alert">{bulkMessage}</p>}
          {bulkResults.length > 0 && (
            <ul className="record-list" aria-label="Bulk confirm results">
              {bulkResults.map((result) => (
                <li key={result.orderId}>
                  {result.orderNumber}:{" "}
                  {result.outcome === "confirmed"
                    ? result.replayed
                      ? "already confirmed by this action"
                      : "confirmed"
                    : `not confirmed (${BULK_REASONS[result.code ?? ""] ?? "refused"})`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {orders.data && (
        <>
          {orders.data.items.length === 0 ? (
            <p className="muted">No orders match these filters.</p>
          ) : (
            <div className="order-table-wrap">
              <table className="order-table">
                <thead>
                  <tr>
                    {canTransition && (
                      <th>
                        <input
                          type="checkbox"
                          aria-label="Select all pending orders on this page"
                          checked={allPendingChosen}
                          ref={(box) => {
                            if (box) box.indeterminate = somePendingChosen && !allPendingChosen;
                          }}
                          disabled={selectablePending.length === 0 || unclear}
                          onChange={(event) => chooseAllPending(event.target.checked)}
                        />
                      </th>
                    )}
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
                    <OrderRow
                      key={order.id}
                      order={order}
                      open={() => setSelected(order.id)}
                      selectable={canTransition}
                      checked={chosen.has(order.id)}
                      disabled={
                        order.status !== "pending" ||
                        unclear ||
                        (!chosen.has(order.id) && chosen.size >= 50)
                      }
                      toggle={(on) => choose(order, on)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* Phones (parity G-A5): each order as a card; the table above is for wider screens. */}
          {orders.data.items.length > 0 && (
            <ul className="order-cards" aria-label="Orders">
              {orders.data.items.map((order) => (
                <li key={order.id}>
                  <button
                    type="button"
                    className="order-card"
                    onClick={() => setSelected(order.id)}
                  >
                    <span className="order-card-line">
                      <strong>{order.orderNumber}</strong>
                      <span className={`order-status status-${order.status}`}>
                        {ORDER_STATUS_LABELS[order.status]}
                      </span>
                    </span>
                    <span className="order-card-line">
                      <span>{order.customer?.name ?? "Contact hidden"}</span>
                      <strong>{money(order.totalFils)}</strong>
                    </span>
                    <small className="muted">
                      {when(order.createdAt)} · {order.itemCount}{" "}
                      {order.itemCount === 1 ? "item" : "items"} · {order.areaName}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
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

const BULK_REASONS: Record<string, string> = {
  VERSION_CONFLICT: "it changed meanwhile; reload",
  INVALID_TRANSITION: "it is no longer pending",
  NOT_FOUND: "not found",
  FORBIDDEN: "no permission",
  COMMAND_REUSED: "this action was used for something else",
  TRANSACTION_RETRY_EXHAUSTED: "busy; try again",
};

function OrderRow({
  order,
  open,
  selectable,
  checked,
  disabled,
  toggle,
}: {
  order: AdminOrderSummary;
  open: () => void;
  selectable: boolean;
  checked: boolean;
  disabled: boolean;
  toggle: (on: boolean) => void;
}) {
  return (
    <tr tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
      {selectable && (
        <td onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Select ${order.orderNumber}`}
            checked={checked}
            disabled={disabled && !checked}
            onChange={(event) => toggle(event.target.checked)}
          />
        </td>
      )}
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
    if (
      !activePending &&
      !(await confirmDialog({
        title: `${action.label} for ${order.data.orderNumber}?`,
        ok: action.label,
      }))
    )
      return;
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
      <div className="form-actions">
        <button data-leave type="button" className="secondary-button" onClick={onBack}>
          ← Back to orders
        </button>
        {/* The slip shows where to deliver, so it needs the contact (customers.read). */}
        {order.data?.customer && (
          <PackingSlip order={{ ...order.data, customer: order.data.customer }} />
        )}
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
          {canReadContact && order.data.status !== "cancelled" && (
            <OrderWhatsappPanel id={id} version={order.data.version} />
          )}
          {canReadContact && order.data.status === "delivered" && <ReviewLinkPanel id={id} />}
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
    // Items added with the picker, as `added.<variantId>` = quantity.
    const added = [...data.keys()]
      .filter((name) => name.startsWith("added."))
      .map((name) => ({ variantId: name.slice(6), quantity: Number(data.get(name)) }));
    lines.push(...added);
    const quantitiesChanged =
      added.length > 0 ||
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
 * WhatsApp messages for the order (step 90). Opening WhatsApp sends nothing and records
 * nothing: the staff member reviews the text and sends it in WhatsApp themselves.
 */
function OrderWhatsappPanel({ id, version }: { id: string; version: number }) {
  // The version in the path re-reads the message after the order changes (status, total).
  const links = useManagementResource(
    `/orders/${id}/whatsapp?v=${version}`,
    orderWhatsappResponseSchema,
  );
  const [kind, setKind] = useState<"orderConfirmation" | "statusUpdate">("orderConfirmation");
  const [edited, setEdited] = useState<Record<string, string>>({});
  const link = links.data?.links.find((entry) => entry.kind === kind);
  const text = edited[kind] ?? link?.text ?? "";
  return (
    <article className="record-card">
      <h3>WhatsApp customer</h3>
      <ResourceNotice resource={links} />
      {links.data && link && (
        <>
          <div className="tab-list" role="tablist" aria-label="Message">
            {links.data.links.map((entry) => (
              <button
                key={entry.kind}
                type="button"
                role="tab"
                className="secondary-button"
                aria-selected={kind === entry.kind}
                onClick={() => setKind(entry.kind)}
              >
                {entry.kind === "orderConfirmation" ? "Order confirmation" : "Status update"}
              </button>
            ))}
          </div>
          <label className="wide-field">
            <span>Message (editable in WhatsApp too)</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={text}
              onChange={(event) =>
                setEdited((current) => ({ ...current, [kind]: event.target.value }))
              }
            />
          </label>
          {link.placeholder && (
            <p className="muted">Placeholder wording: the Owner can set the message in Settings.</p>
          )}
          <div className="form-actions">
            <a
              className="primary-button"
              target="_blank"
              rel="noopener noreferrer"
              href={`https://wa.me/${links.data.phone.slice(1)}?text=${encodeURIComponent(text)}`}
            >
              Open WhatsApp
            </a>
            <small className="muted">
              Opens WhatsApp with this message ready. Nothing is sent or recorded until you send it
              there.
            </small>
          </div>
        </>
      )}
    </article>
  );
}

/**
 * Verified-purchase review link (step 93). The link is shown once: the server keeps only a hash
 * of it. Creating another replaces the previous link. Nothing is sent from here.
 */
function ReviewLinkPanel({ id }: { id: string }) {
  const [link, setLink] = useState<ReviewLinkResponse | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function create() {
    if (
      link &&
      !(await confirmDialog({
        title: "Create a new link?",
        body: "The previous link stops working.",
        ok: "Create new link",
      }))
    )
      return;
    setBusy(true);
    setMessage("");
    try {
      setLink(
        await managementRequest(`/orders/${id}/review-link`, reviewLinkResponseSchema, "POST", {}),
      );
    } catch (error) {
      setMessage(managementError(error, true));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="record-card">
      <h3>Review link</h3>
      <p className="muted">
        Lets this customer review the products of this order. Reviews stay hidden until approved.
      </p>
      {message && <p role="alert">{message}</p>}
      {link && (
        <>
          <label className="wide-field">
            <span>Link (shown once, valid until {when(link.expiresAt)})</span>
            <input readOnly value={link.link} onFocus={(event) => event.target.select()} />
          </label>
          {link.whatsapp && (
            <div className="form-actions">
              <a
                className="primary-button"
                target="_blank"
                rel="noopener noreferrer"
                href={link.whatsapp.href}
              >
                Open WhatsApp
              </a>
              <small className="muted">
                {link.whatsapp.placeholder ? "Placeholder wording. " : ""}Nothing is sent or
                recorded until you send it there.
              </small>
            </div>
          )}
        </>
      )}
      <div className="form-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={create}>
          {link ? "Create a new link" : "Create review link"}
        </button>
      </div>
    </article>
  );
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
        data-unsaved="this cash record"
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
              void confirmDialog({
                title: `Correct the cash record of ${order.orderNumber}?`,
                ok: "Correct record",
              }).then((ok) => {
                if (!ok) return;
                setMessage("");
                void correct(request).then((result) => result.ok && done());
              });
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
              void confirmDialog({
                title: `Record ${money(amountFils)} collected for ${order.orderNumber}?`,
                ...(differs ? { body: differs.trim() } : {}),
                ok: "Record cash",
              }).then((ok) => {
                if (!ok) return;
                setMessage("");
                void record(request).then((result) => result.ok && done());
              });
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
          data-unsaved="this cancellation"
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
            void confirmDialog({
              title: `Cancel ${order.orderNumber}?`,
              body: "This cannot be undone.",
              ok: "Cancel order",
              cancel: "Keep order",
              danger: true,
            }).then((ok) => {
              if (!ok) return;
              setMessage("");
              void save(request).then((result) => result.ok && done());
            });
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
  const [added, setAdded] = useState<OrderItemChoice[]>([]);
  return (
    <article className="record-card">
      <h3>Edit order</h3>
      <p className="muted">
        {commerce
          ? "Quantities, items, coupon, delivery address and the operational note can be changed before processing. Set a quantity to zero to remove an item; add one from the product search."
          : "Only the operational note can change while this order is processing."}
      </p>
      <form
        data-unsaved={`order ${order.orderNumber}`}
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
            {added.map((choice) => (
              <div key={choice.variantId} className="order-line wide-field">
                <label>
                  <span>
                    Added: {choice.brandName} {choice.productName} · {choiceLabel(choice)} ·{" "}
                    {money(choice.unitPriceFils)}
                  </span>
                  <input
                    name={`added.${choice.variantId}`}
                    type="number"
                    min={1}
                    max={10}
                    step={1}
                    defaultValue={1}
                    required
                    aria-label={`Quantity of ${choice.productName}`}
                  />
                </label>
                <span />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setAdded(added.filter((entry) => entry !== choice))}
                >
                  Remove
                </button>
              </div>
            ))}
            <OrderItemPicker
              disabled={disabled}
              taken={
                new Set([
                  ...order.items.flatMap((item) => (item.variantId ? [item.variantId] : [])),
                  ...added.map((choice) => choice.variantId),
                ])
              }
              onPick={(choice) => setAdded([...added, choice])}
            />
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
