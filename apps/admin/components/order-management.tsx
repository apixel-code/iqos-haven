"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { useEffect, useState } from "react";
import {
  EMIRATE_NAMES,
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
  ORDER_DATE_RANGES,
  ORDER_STATUS_LABELS,
  orderRangeStart,
  type OrderDateRange,
  when,
} from "../lib/orders";
import { Icon, type IconName } from "./icons";
import { Drawer } from "./overlays";
import { toast } from "../lib/ui/toast";
import { PageHead } from "./page-head";
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
  const [cursors, setCursors] = useState<string[]>([]);
  // The prototype's toolbar: search as you type (after a pause) and a date choice in Dubai days.
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [range, setRange] = useState<OrderDateRange>("all");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = typed.trim().slice(0, 100);
      if (next !== search) {
        setSearch(next);
        setCursors([]);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [typed, search]);
  // The start of the chosen range, fixed when it is chosen (not moving with every render).
  const [from, setFrom] = useState<string | null>(null);
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
  if (from) shared.set("from", from);
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
      <>
        <ManualOrderPanel
          canConfirm={canTransition}
          canLookUp={canReadContact}
          onCancel={() => setCreating(false)}
          onCreated={(orderId) => {
            setCreating(false);
            setSelected(orderId);
          }}
        />
      </>
    );
  if (selected)
    return (
      <>
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
      </>
    );
  const items = orders.data?.items ?? [];
  const shownTotal = counts.data ? counts.data[status] : null;
  const firstShown = cursors.length * PAGE_SIZE + 1;
  const filtered = Boolean(search || from || delayed);
  const clearFilters = () => {
    setTyped("");
    setSearch("");
    setRange("all");
    setFrom(null);
    navigate({ status: null, delayed: null });
    resetPage();
  };
  return (
    <>
      <PageHead
        title="Orders"
        sub={
          counts.data && !filtered
            ? `${counts.data.all.toLocaleString("en-AE")} ${counts.data.all === 1 ? "order" : "orders"} · ${counts.data.pending} waiting for confirmation`
            : counts.data
              ? `${counts.data.pending} waiting for confirmation`
              : undefined
        }
        actions={
          canCreate && (
            <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              Create order
            </button>
          )
        }
      />
      <div className="stack orders-head">
        <div className="tabs" role="tablist" aria-label="Order status">
          {STATUSES.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              className="tab"
              aria-selected={status === value}
              onClick={() => {
                setStatus(value);
                resetPage();
              }}
            >
              {value === "all" ? "All" : ORDER_STATUS_LABELS[value]}
              {counts.data && <span className="c">{counts.data[value]}</span>}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <div className="search">
            <Icon name="search" />
            <label className="sr" htmlFor="orders-q">
              Search orders
            </label>
            <input
              id="orders-q"
              type="search"
              maxLength={100}
              placeholder={canReadContact ? "Order number, customer name or phone" : "Order number"}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <select
            className="fsel"
            aria-label="Date"
            value={range}
            onChange={(event) => {
              const next = event.target.value as OrderDateRange;
              setRange(next);
              setFrom(orderRangeStart(next, new Date()));
              resetPage();
            }}
          >
            {Object.entries(ORDER_DATE_RANGES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="fsel"
            aria-label="Sort"
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
          <button
            type="button"
            className={delayed ? "chipf chipf-on" : "chipf"}
            aria-pressed={delayed}
            onClick={() => {
              navigate({ delayed: delayed ? null : "1" });
              resetPage();
            }}
          >
            Delayed only
            {delayed && <Icon name="x" size="sm" />}
          </button>
        </div>
      </div>
      <ResourceNotice resource={orders} compact />
      {canTransition && (chosen.size > 0 || bulkResults.length > 0 || bulkMessage) && (
        <div className="bulk-area">
          {chosen.size > 0 && (
            <div className="bulk" role="region" aria-label="Selected orders">
              <span>{chosen.size} selected</span>
              <button
                type="button"
                className="btn btn-sm bulk-go"
                disabled={confirming}
                onClick={() => void confirmChosen()}
              >
                <Icon name="check" size="sm" />
                {unclear ? `Retry confirming ${chosen.size}` : `Confirm ${chosen.size} pending`}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-s bulk-clear"
                disabled={confirming}
                onClick={() => {
                  // Safe after an unclear answer too: a fresh selection re-checks each order's
                  // version, so nothing can be confirmed twice.
                  setChosen(new Map());
                  setUnclear(false);
                  if (unclear) orders.reload();
                }}
              >
                {unclear ? "Discard and reload" : "Clear"}
              </button>
            </div>
          )}
          {chosen.size > 0 && (
            <p className="small muted">At most 50 at a time; each order is confirmed on its own.</p>
          )}
          {bulkMessage && (
            <div className="note err" role="alert">
              <Icon name="alert" />
              <p>{bulkMessage}</p>
            </div>
          )}
          {bulkResults.length > 0 && (
            <ul className="bulk-results" aria-label="Bulk confirm results">
              {bulkResults.map((result) => (
                <li key={result.orderId}>
                  <span className="mono">{result.orderNumber}</span>:{" "}
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
      {orders.data &&
        (items.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="ic">
                <Icon name="search" />
              </div>
              <h3>No orders match</h3>
              <p>
                {search
                  ? `Nothing found for “${search}”. Check the order number or phone number.`
                  : "Try another status or date range."}
              </p>
              {filtered || status !== "all" ? (
                <div className="row">
                  <button type="button" className="btn btn-s" onClick={clearFilters}>
                    Clear filters
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            <div className="tbl-wrap only-d">
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      {canTransition && (
                        <th className="w1">
                          <input
                            type="checkbox"
                            className="cb"
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
                      <th>Phone</th>
                      <th className="num">Amount</th>
                      <th>Payment</th>
                      <th>Status</th>
                      <th>Placed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((order) => (
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
              <Pager
                first={firstShown}
                count={items.length}
                total={shownTotal}
                page={cursors.length + 1}
                busy={orders.busy}
                hasPrevious={cursors.length > 0}
                hasNext={Boolean(orders.data.nextCursor)}
                previous={() => setCursors((value) => value.slice(0, -1))}
                next={() => setCursors((value) => [...value, orders.data!.nextCursor!])}
              />
            </div>
            {/* Phones: the prototype's order rows (`orderRowM`) in place of the table. */}
            <div className="only-m">
              <div className="mlist">
                {items.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    className="mrow"
                    onClick={() => setSelected(order.id)}
                  >
                    <span className="mrow-b">
                      <span className="mrow-t">
                        <span className="lnk-id">{order.orderNumber}</span>
                        <StatusBadge status={order.status} />
                      </span>
                      <span className="mrow-t">
                        <b>{order.customer?.name ?? "Contact hidden"}</b>
                        <span className="amt">{money(order.totalFils)}</span>
                      </span>
                      <span className="meta">
                        <span>{when(order.createdAt)}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{order.areaName}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="tbl-wrap orders-mpager">
                <Pager
                  first={firstShown}
                  count={items.length}
                  total={shownTotal}
                  page={cursors.length + 1}
                  busy={orders.busy}
                  hasPrevious={cursors.length > 0}
                  hasNext={Boolean(orders.data.nextCursor)}
                  previous={() => setCursors((value) => value.slice(0, -1))}
                  next={() => setCursors((value) => [...value, orders.data!.nextCursor!])}
                />
              </div>
            </div>
          </>
        ))}
    </>
  );
}

const PAGE_SIZE = 25;

/** The prototype's status badge (`stBadge`). */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`st st-${status === "out_for_delivery" ? "ofd" : status}`}>
      {ORDER_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/**
 * The prototype's table foot (`pager`). The list pages by position (keyset), so it steps back
 * and forward; the range shown comes from the tab's count.
 */
function Pager(props: {
  first: number;
  count: number;
  total: number | null;
  page: number;
  busy: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  previous: () => void;
  next: () => void;
}) {
  const last = props.first + props.count - 1;
  return (
    <div className="tbl-f">
      <span>
        {props.count
          ? `Showing ${props.first.toLocaleString("en-AE")}–${last.toLocaleString("en-AE")}${props.total !== null ? ` of ${props.total.toLocaleString("en-AE")}` : ""}`
          : "No results"}
      </span>
      <div className="pager">
        <button
          type="button"
          aria-label="Previous page"
          disabled={!props.hasPrevious || props.busy}
          onClick={props.previous}
        >
          <Icon name="cl" size="sm" />
        </button>
        <button type="button" aria-current="page" aria-label={`Page ${props.page}`}>
          {props.page}
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={!props.hasNext || props.busy}
          onClick={props.next}
        >
          <Icon name="cr" size="sm" />
        </button>
      </div>
    </div>
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
  // The prototype's clickable row; the order number is the keyboard way in.
  return (
    <tr className={checked ? "click sel" : "click"} onClick={open}>
      {selectable && (
        <td className="w1" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            className="cb"
            aria-label={`Select ${order.orderNumber}`}
            checked={checked}
            disabled={disabled && !checked}
            onChange={(event) => toggle(event.target.checked)}
          />
        </td>
      )}
      <td>
        <button
          type="button"
          className="lnk-id"
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
        >
          {order.orderNumber}
        </button>
        {order.source !== "storefront" && (
          <div className="xs muted">{SOURCE_LABELS[order.source] ?? order.source}</div>
        )}
      </td>
      <td>
        {order.customer ? (
          <b className="cust">{order.customer.name}</b>
        ) : (
          <span className="muted">Contact hidden</span>
        )}
      </td>
      <td className="mono muted nowrap">{order.customer?.phone ?? "—"}</td>
      <td className="num">
        {money(order.totalFils)}
        <div className="xs muted">
          {order.itemCount} {order.itemCount === 1 ? "item" : "items"}
        </div>
      </td>
      <td>
        <span className="small">COD</span>
        <div className="xs muted">{COD_STATUS_LABELS[order.codStatus]}</div>
      </td>
      <td>
        <StatusBadge status={order.status} />
      </td>
      <td className="small nowrap">
        {when(order.createdAt)}
        <div className="xs muted">{order.areaName}</div>
      </td>
    </tr>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  storefront: "Storefront",
  manual: "Created in admin",
};

type TransitionTarget = "confirmed" | "processing" | "out_for_delivery" | "delivered";
const NEXT: Partial<
  Record<AdminOrderResponse["status"], { to: TransitionTarget; label: string; icon: IconName }>
> = {
  pending: { to: "confirmed", label: "Confirm order", icon: "check" },
  confirmed: { to: "processing", label: "Start processing", icon: "pkg" },
  processing: { to: "out_for_delivery", label: "Mark out for delivery", icon: "truck" },
  out_for_delivery: { to: "delivered", label: "Mark delivered", icon: "check-c" },
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
  // The prototype opens these in a drawer from the head or the cards.
  const [panel, setPanel] = useState<"whatsapp" | "edit" | "cancel" | "collection" | null>(null);
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
      toast(`${order.data.orderNumber}: ${ORDER_STATUS_LABELS[command.to]}`);
    }
  }
  const data = order.data;
  const status = data?.status;
  const editable =
    canEdit && status !== undefined && ["pending", "confirmed", "processing"].includes(status);
  const cancellable =
    status !== undefined &&
    ((canCancel && ["pending", "confirmed", "processing"].includes(status)) ||
      (canCancel && canReturn && status === "out_for_delivery"));
  const collectable =
    data !== null &&
    ((canCollect && data.status === "delivered" && data.codStatus === "pending") ||
      (canCorrect && data.codStatus === "collected"));
  const whatsapp = canReadContact && status !== undefined && status !== "cancelled";
  const close = () => setPanel(null);
  const advance =
    canTransition && action ? (
      <button
        type="button"
        className="btn btn-p"
        disabled={order.disabled}
        onClick={() => void submitTransition()}
      >
        <Icon name={action.icon} />
        {activePending ? `Retry: ${action.label}` : action.label}
      </button>
    ) : null;
  return (
    <div className="stack order-detail">
      <button data-leave type="button" className="backlink" onClick={onBack}>
        <Icon name="arr-l" size="sm" />
        Orders
      </button>
      <ResourceNotice resource={order} compact />
      {data && (
        <>
          <PageHead
            title={
              <>
                <span className="mono order-no">{data.orderNumber}</span>{" "}
                <StatusBadge status={data.status} />
              </>
            }
            sub={`Placed ${when(data.createdAt)} · via ${SOURCE_LABELS[data.source] ?? data.source}`}
            actions={
              <>
                {whatsapp && (
                  <button
                    type="button"
                    className="btn btn-wa hide-m"
                    onClick={() => setPanel("whatsapp")}
                  >
                    <Icon name="wa" />
                    WhatsApp customer
                  </button>
                )}
                {editable && (
                  <button
                    type="button"
                    className="btn btn-s hide-m"
                    onClick={() => setPanel("edit")}
                  >
                    <Icon name="edit" />
                    Edit
                  </button>
                )}
                {/* The slip shows where to deliver, so it needs the contact (customers.read). */}
                {data.customer && <PackingSlip order={{ ...data, customer: data.customer }} />}
                {cancellable && (
                  <button
                    type="button"
                    className="btn btn-s danger-t"
                    onClick={() => setPanel("cancel")}
                  >
                    <Icon name="x-c" />
                    {data.status === "out_for_delivery" ? "Cancel after return" : "Cancel order"}
                  </button>
                )}
              </>
            }
          />
          <div className="card">
            <div className="card-b order-progress">
              {data.status === "cancelled" ? (
                <div className="note">
                  <Icon name="x-c" />
                  <p>
                    <b>This order was cancelled</b>
                    {cancelEntry(data)}. Items were returned to stock.
                  </p>
                </div>
              ) : (
                <>
                  <div className="prog" aria-label="Order progress">
                    {PROGRESS.map((step, index) => {
                      const at = PROGRESS.indexOf(data.status as (typeof PROGRESS)[number]);
                      return (
                        <div
                          key={step}
                          className={`prog-s ${index < at ? "done" : index === at ? "now" : ""}`}
                          aria-current={index === at ? "step" : undefined}
                        >
                          <i />
                          <span>{ORDER_STATUS_LABELS[step]}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="row between order-next">
                    <div>
                      {action ? (
                        <>
                          <b>Next: {ORDER_STATUS_LABELS[action.to]}</b>
                          <p className="small muted">{NEXT_HINT[data.status]}</p>
                        </>
                      ) : (
                        <>
                          <b>Order complete</b>
                          <p className="small muted">
                            {data.codStatus === "collected"
                              ? "Delivered and cash collected."
                              : "Delivered. Record the cash once it is in hand."}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="row hide-m">{advance}</div>
                  </div>
                  {activePending && (
                    <p className="small muted">
                      The same command is retried safely (version {activePending.expectedVersion}).
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
          <OrderDetailBody
            order={data}
            collect={collectable ? () => setPanel("collection") : null}
            reviewLink={canReadContact && data.status === "delivered"}
          />
          {(advance || whatsapp || editable) && (
            <div className="savebar only-m-f">
              {advance}
              {whatsapp && (
                <button
                  type="button"
                  className="btn btn-wa btn-icon"
                  aria-label="WhatsApp customer"
                  onClick={() => setPanel("whatsapp")}
                >
                  <Icon name="wa" />
                </button>
              )}
              {editable && (
                <button
                  type="button"
                  className="btn btn-s btn-icon"
                  aria-label="Edit order"
                  onClick={() => setPanel("edit")}
                >
                  <Icon name="edit" />
                </button>
              )}
            </div>
          )}
          <Drawer open={panel === "whatsapp" && whatsapp} onClose={close} title="WhatsApp customer">
            <div className="management-card in-drawer">
              <OrderWhatsappPanel id={id} version={data.version} />
            </div>
          </Drawer>
          <Drawer open={panel === "edit" && editable} onClose={close} title="Edit order" wide>
            <div className="management-card in-drawer">
              <OrderEditPanel
                key={`${data.id}:${data.version}`}
                order={data}
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
                done={() => {
                  close();
                  order.reload();
                  toast("Order updated");
                }}
              />
            </div>
          </Drawer>
          <Drawer
            open={panel === "cancel" && cancellable}
            onClose={close}
            title={data.status === "out_for_delivery" ? "Cancel after return" : "Cancel order"}
            wide={data.status === "out_for_delivery"}
          >
            <div className="management-card in-drawer">
              <OrderCancelPanel
                key={`cancel:${data.id}:${data.version}`}
                order={data}
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
                done={() => {
                  close();
                  order.reload();
                  toast(`${data.orderNumber} cancelled`);
                }}
              />
            </div>
          </Drawer>
          <Drawer
            open={panel === "collection" && collectable}
            onClose={close}
            title={data.codStatus === "collected" ? "Correct cash record" : "Record cash collected"}
          >
            <div className="management-card in-drawer">
              <OrderCollectionPanel
                key={`collection:${data.id}:${data.version}`}
                order={data}
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
                done={() => {
                  close();
                  order.reload();
                  toast("Cash record saved");
                }}
              />
            </div>
          </Drawer>
        </>
      )}
    </div>
  );
}

/** The prototype's progress steps (`prog`); Cancelled is not a step. */
const PROGRESS = ["pending", "confirmed", "processing", "out_for_delivery", "delivered"] as const;
const NEXT_HINT: Partial<Record<AdminOrderResponse["status"], string>> = {
  pending: "Check the order, then confirm it with the customer.",
  confirmed: "Pick and pack the items.",
  processing: "Hand the parcel to the courier.",
  out_for_delivery: "Mark it delivered when the customer has it. Cash is recorded separately.",
};
/** " on 18 Oct 2026, 4:21 PM by Owner · Reason: …" from the history entry that cancelled it. */
function cancelEntry(order: AdminOrderResponse) {
  const entry = [...order.history].reverse().find((item) => item.toStatus === "cancelled");
  if (!entry) return "";
  const who = entry.actorName ?? (entry.actorKind === "customer" ? "the customer" : "the system");
  return ` on ${when(entry.createdAt)} by ${who}${entry.reason ? ` · Reason: ${entry.reason}` : ""}`;
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
  const field = (
    name: string,
    label: string,
    value: string,
    options: { max: number; required?: boolean; mono?: boolean } = { max: 150 },
  ) => (
    <div className="field">
      <label className="label" htmlFor={`e-${name}`}>
        {label}
        {options.required ? (
          <>
            {" "}
            <span className="req" aria-hidden="true">
              *
            </span>
          </>
        ) : (
          <>
            {" "}
            <span className="opt">Optional</span>
          </>
        )}
      </label>
      <input
        id={`e-${name}`}
        name={name}
        className={options.mono ? "input mono" : "input"}
        maxLength={options.max}
        required={options.required}
        defaultValue={value}
      />
    </div>
  );
  return (
    // The prototype's edit form (`order-edit`) in the drawer: the drawer carries the title.
    <article className="record-card edit-form">
      <h3>Edit order</h3>
      <div className={commerce ? "note info" : "note"}>
        <Icon name="info" />
        <p>
          {commerce
            ? "Quantities, items, coupon, delivery address and the operational note can be changed before processing. Set a quantity to zero to remove an item."
            : "Only the operational note can change while this order is processing."}
        </p>
      </div>
      <form
        data-unsaved={`order ${order.orderNumber}`}
        className="stack edit-stack"
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
          <section aria-labelledby="e-items-h">
            <span className="sect-t" id="e-items-h">
              Items
            </span>
            <div className="items edit-items">
              {order.items.map((item) => (
                <div className="it" key={item.id}>
                  <div>
                    <b>{item.productName}</b>
                    <small className="mono">{item.sku}</small>
                    <small>{money(item.unitPriceFils)} each</small>
                  </div>
                  <div className="r">
                    <input
                      className="input qty-input"
                      name={`quantity.${item.variantId}`}
                      type="number"
                      min={0}
                      max={10}
                      step={1}
                      defaultValue={item.quantity}
                      required
                      aria-label={`Quantity of ${item.productName} · ${item.sku}`}
                    />
                  </div>
                </div>
              ))}
              {added.map((choice) => (
                <div className="it" key={choice.variantId}>
                  <div>
                    <b>
                      {choice.productName} <span className="tag info">Added</span>
                    </b>
                    <small>
                      {choice.brandName} · {choiceLabel(choice)} · {money(choice.unitPriceFils)}
                    </small>
                  </div>
                  <div className="r no-line-r">
                    <input
                      className="input qty-input"
                      name={`added.${choice.variantId}`}
                      type="number"
                      min={1}
                      max={10}
                      step={1}
                      defaultValue={1}
                      required
                      aria-label={`Quantity of ${choice.productName}`}
                    />
                    <button
                      type="button"
                      className="ibtn"
                      aria-label={`Remove ${choice.productName}`}
                      onClick={() => setAdded(added.filter((entry) => entry !== choice))}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="edit-picker">
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
            </div>
            <div className="fgrid c2">
              {field("couponCode", "Coupon code", order.coupon?.code ?? "", {
                max: 32,
                mono: true,
              })}
            </div>
          </section>
        )}
        {commerce && canReadContact && order.customer && order.area.id && (
          <section aria-labelledby="e-delivery-h">
            <span className="sect-t" id="e-delivery-h">
              Delivery address
            </span>
            <div className="fgrid c2">
              <div className="field">
                <label className="label" htmlFor="e-type">
                  Address type
                </label>
                <select
                  id="e-type"
                  className="select"
                  name="address.type"
                  defaultValue={order.customer.address.type}
                >
                  <option value="apartment">Apartment</option>
                  <option value="villa">Villa</option>
                  <option value="office">Office</option>
                </select>
              </div>
              {field("address.building", "Building", order.customer.address.building, {
                max: 150,
                required: true,
              })}
              {field("address.unit", "Unit", order.customer.address.unit ?? "", { max: 50 })}
              {field("address.street", "Street", order.customer.address.street ?? "", { max: 150 })}
              {field("address.makani", "Makani", order.customer.address.makani ?? "", {
                max: 10,
                mono: true,
              })}
              <div className="field span2">
                <label className="label" htmlFor="e-notes">
                  Delivery notes <span className="opt">Optional</span>
                </label>
                <textarea
                  id="e-notes"
                  className="textarea"
                  name="address.notes"
                  maxLength={500}
                  rows={2}
                  defaultValue={order.customer.address.notes ?? ""}
                />
              </div>
            </div>
          </section>
        )}
        <div className="field">
          <label className="label" htmlFor="e-op">
            Operational note <span className="opt">Optional</span>
          </label>
          <textarea
            id="e-op"
            className="textarea"
            name="operationalNote"
            maxLength={500}
            rows={3}
            defaultValue={order.operationalNote ?? ""}
          />
          <p className="help">For the team only; the customer never sees it.</p>
        </div>
        {validationMessage && (
          <div className="note err" role="alert">
            <Icon name="alert" />
            <p>{validationMessage}</p>
          </div>
        )}
        <div className="row edit-actions">
          <button type="submit" className="btn btn-p" disabled={disabled}>
            <Icon name="check" />
            Save order edit
          </button>
          <span className="small muted">
            Uses order version {order.version}; changes made meanwhile are refused.
          </span>
        </div>
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

function OrderDetailBody({
  order,
  collect,
  reviewLink,
}: {
  order: AdminOrderResponse;
  /** Opens the cash record (null when this user may not record or correct it now). */
  collect: (() => void) | null;
  reviewLink: boolean;
}) {
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const address = order.customer?.address;
  const at = PROGRESS.indexOf(order.status as (typeof PROGRESS)[number]);
  return (
    <div className="split">
      <div className="stack">
        <section className="card" aria-labelledby="items-h">
          <div className="card-h">
            <h2 id="items-h">
              Items{" "}
              <span className="sub">
                · {units} {units === 1 ? "unit" : "units"}
              </span>
            </h2>
          </div>
          <div className="card-b">
            <div className="items">
              {order.items.map((item) => (
                <div className="it" key={item.id}>
                  <div className="it-t">
                    <b>{item.productName}</b>
                    <small className="mono">{item.sku}</small>
                    <small>
                      {[item.brandName, Object.values(item.attributes).join(" · ") || null]
                        .filter(Boolean)
                        .join(" · ")}{" "}
                      · {item.quantity} × {money(item.unitPriceFils)}
                    </small>
                  </div>
                  <div className="r">
                    <b>{money(item.totalFils)}</b>
                  </div>
                </div>
              ))}
            </div>
            <hr className="hr sum-hr" />
            <div className="sum">
              <div>
                <span className="muted">Subtotal</span>
                <span>{money(order.merchandiseSubtotalFils)}</span>
              </div>
              <div>
                <span className="muted">
                  Discount
                  {order.coupon && (
                    <>
                      {" "}
                      <span className="coupon">{order.coupon.code}</span>{" "}
                      {order.coupon.percentBps / 100}%
                    </>
                  )}
                </span>
                <span className={order.discountFils ? "neg" : undefined}>
                  {order.discountFils ? `− ${money(order.discountFils)}` : "—"}
                </span>
              </div>
              <div>
                <span className="muted">Delivery</span>
                <span>{money(order.deliveryFeeFils)}</span>
              </div>
              <div className="tot">
                <span>
                  {order.status === "cancelled" ? "Total (cancelled)" : "Total to collect"}
                </span>
                <span>{money(order.totalFils)}</span>
              </div>
            </div>
          </div>
        </section>
        {order.returnItems.length > 0 && (
          <section className="card" aria-labelledby="return-h">
            <div className="card-h">
              <h2 id="return-h">Return</h2>
            </div>
            <div className="card-b">
              <ul className="plain-list">
                {order.returnItems.map((item) => (
                  <li key={item.sku}>
                    <span className="mono">{item.sku}</span>: {item.quantity} sent ·{" "}
                    {item.resellableQuantity} back in stock · {item.damagedQuantity} damaged
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
        <section className="card" aria-labelledby="timeline-h">
          <div className="card-h">
            <h2 id="timeline-h">Timeline</h2>
          </div>
          <div className="card-b">
            <div className="tl">
              {order.history.map((entry) => (
                <div className="tl-i" key={entry.id}>
                  <span
                    className={`tl-d st-${entry.toStatus === "out_for_delivery" ? "ofd" : entry.toStatus}`}
                  >
                    <Icon name={STATUS_ICON[entry.toStatus] ?? "info"} />
                  </span>
                  <div>
                    <b>{ORDER_STATUS_LABELS[entry.toStatus]}</b>
                    <small>
                      {when(entry.createdAt)} ·{" "}
                      {entry.actorName ??
                        (entry.actorKind === "customer" ? "Customer checkout" : "System")}
                      {entry.reason ? ` · ${entry.reason}` : ""}
                    </small>
                  </div>
                </div>
              ))}
              {order.status !== "cancelled" &&
                PROGRESS.slice(at + 1).map((step) => (
                  <div className="tl-i future" key={step}>
                    <span className="tl-d">
                      <Icon name={STATUS_ICON[step] ?? "info"} />
                    </span>
                    <div>
                      <b>{ORDER_STATUS_LABELS[step]}</b>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </section>
        {order.edits.length > 0 && (
          <section className="card" aria-labelledby="edits-h">
            <div className="card-h">
              <h2 id="edits-h">Edit history</h2>
            </div>
            <div className="card-b">
              <div className="tl">
                {order.edits.map((edit) => (
                  <div className="tl-i" key={edit.id}>
                    <span className="tl-d">
                      <Icon name="edit" />
                    </span>
                    <div>
                      <b>
                        {edit.actor.name} · v{edit.orderVersion}
                      </b>
                      <small>{when(edit.editedAt)}</small>
                      {editDiffLines(edit.diff).map((line) => (
                        <small key={line}>{line}</small>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
      <div className="stack">
        <section className="card" aria-labelledby="customer-h">
          <div className="card-h">
            <h2 id="customer-h">Customer</h2>
            {/* The order read carries no customer ID, so there is no profile link here yet. */}
          </div>
          <div className="card-b cust-b">
            {order.customer ? (
              <>
                <div className="row cust-row">
                  <span className="av" aria-hidden="true">
                    {order.customer.name
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((part) => part[0]?.toUpperCase())
                      .join("")}
                  </span>
                  <div className="cust-n">
                    <b>{order.customer.name}</b>
                    <span className="mono small muted">{order.customer.phone}</span>
                  </div>
                  <CopyPhone phone={order.customer.phone} />
                </div>
                <div className="row">
                  <a className="btn btn-s cust-call" href={`tel:${order.customer.phone}`}>
                    <Icon name="phone" />
                    Call
                  </a>
                </div>
              </>
            ) : (
              <div className="note">
                <Icon name="lock" />
                <p>Customer contact needs the Customers permission.</p>
              </div>
            )}
          </div>
        </section>
        <section className="card" aria-labelledby="delivery-h">
          <div className="card-h">
            <h2 id="delivery-h">Delivery</h2>
          </div>
          <div className="card-b">
            <dl className="kv kv-flat">
              <dt>Area</dt>
              <dd>
                {order.area.name},{" "}
                {EMIRATE_NAMES[order.area.emirate as keyof typeof EMIRATE_NAMES] ??
                  order.area.emirate}
              </dd>
              {address && (
                <>
                  <dt>Address</dt>
                  <dd>{addressLine(order)}</dd>
                  {address.makani && (
                    <>
                      <dt>Makani</dt>
                      <dd className="mono">{address.makani}</dd>
                    </>
                  )}
                  <dt>Notes</dt>
                  <dd>{address.notes ? address.notes : <span className="muted">None</span>}</dd>
                </>
              )}
              <dt>Promise</dt>
              <dd>{order.deliveryEtaText}</dd>
              <dt>Charge</dt>
              <dd>{money(order.deliveryFeeFils)}</dd>
            </dl>
          </div>
        </section>
        <section className="card" aria-labelledby="payment-h">
          <div className="card-h">
            <h2 id="payment-h">Payment</h2>
          </div>
          <div className="card-b">
            <dl className="kv kv-flat">
              <dt>Method</dt>
              <dd>
                <Icon name="cash" size="sm" /> Cash on delivery
              </dd>
              <dt>Status</dt>
              <dd>
                <span
                  className={`tag ${order.codStatus === "collected" ? "ok" : order.codStatus === "not_collected" ? "muted" : "low"}`}
                >
                  {COD_STATUS_LABELS[order.codStatus]}
                </span>
              </dd>
              <dt>Amount</dt>
              <dd>{money(order.totalFils)}</dd>
            </dl>
            {order.collectionRecords.length > 0 && (
              <div className="tl cash-tl">
                {order.collectionRecords.map((entry, index) => (
                  <div className="tl-i" key={entry.id}>
                    <span className="tl-d st-delivered">
                      <Icon name="cash" />
                    </span>
                    <div>
                      <b>
                        {entry.kind === "recorded" ? "Recorded" : "Corrected"}{" "}
                        {money(entry.amountFils)}
                        {index === order.collectionRecords.length - 1 ? " · in effect" : ""}
                      </b>
                      <small>
                        Received {when(entry.collectedAt)} · {entry.actor.name}
                        {entry.reference ? ` · ${entry.reference}` : ""}
                      </small>
                      {entry.reason && <small>{entry.reason}</small>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {collect && (
              <button type="button" className="btn btn-p pay-btn" onClick={collect}>
                {order.codStatus === "collected" ? "Correct cash record" : "Record COD collection"}
              </button>
            )}
          </div>
        </section>
        {reviewLink && <ReviewLinkPanel id={order.id} />}
      </div>
    </div>
  );
}

/** Status icons of the prototype's timeline (`ST[s].i`). */
const STATUS_ICON: Record<string, IconName> = {
  pending: "clock",
  confirmed: "check",
  processing: "pkg",
  out_for_delivery: "truck",
  delivered: "check-c",
  cancelled: "x-c",
};

function CopyPhone({ phone }: { phone: string }) {
  return (
    <button
      type="button"
      className="ibtn cust-copy"
      aria-label="Copy phone number"
      onClick={() => {
        const done = () => toast("Phone number copied");
        try {
          navigator.clipboard
            .writeText(phone)
            .then(done, () => toast("Copy the number by hand", { kind: "info" }));
        } catch {
          toast("Copy the number by hand", { kind: "info" });
        }
      }}
    >
      <Icon name="copy" />
    </button>
  );
}
