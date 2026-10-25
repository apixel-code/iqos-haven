"use client";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import {
  inventoryResponseSchema,
  stockAdjustmentResponseSchema,
  stockMovementsResponseSchema,
  stockSetResponseSchema,
  type InventoryItem,
} from "@ih/contracts";
import {
  addCommand,
  reasonLabel,
  removeCommand,
  setCommand,
  stockAfter,
  stockStateFor,
  type StockState,
} from "../lib/inventory";
import { managementRequest } from "../lib/management";
import { toast } from "../lib/ui/toast";
import { when } from "../lib/orders";
import { describeAttributes } from "../lib/variants";
import { isUuid } from "../lib/links";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { Drawer } from "./overlays";
import { PageHead } from "./page-head";
import { useUrlQuery } from "./use-url-query";

type State = "all" | StockState;
const STATE_LABEL: Record<StockState, string> = {
  in_stock: "In stock",
  low: "Low stock",
  out: "Out of stock",
};

/**
 * Inventory (steps 46–47) in the prototype's layout (`VIEWS.inventory`, ADR 0097 V-A5): stock
 * per option, with every change made through the ledger in the "Update stock" drawer. Each
 * opened change carries a command ID kept across retries, so a retried request can never
 * apply twice. Zero stock never unpublishes a product.
 */
export function InventoryManagement({ permissions }: { permissions: readonly string[] }) {
  const canAdjust = permissions.includes("inventory.adjust");
  // Filters and a single linked variant live in the URL (parity G-A2): a low-stock alert opens
  // its own stock line.
  const { get, navigate } = useUrlQuery();
  const urlState = get("state");
  const state: State = (["in_stock", "low", "out"] as const).find((v) => v === urlState) ?? "all";
  const setState = (value: State) => navigate({ state: value === "all" ? null : value });
  const urlVariant = get("variant");
  const variant = isUuid(urlVariant) ? urlVariant : null;
  // Search as you type, after a pause, like the prototype.
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = typed.trim().slice(0, 100);
      if (next !== q) {
        setQ(next);
        setCursors([]);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [typed, q]);
  // A link can change the filters while this list is open: start again from the first page.
  const filterScope = `${state}|${variant}`;
  const [pagedScope, setPagedScope] = useState(filterScope);
  if (pagedScope !== filterScope) {
    setPagedScope(filterScope);
    setCursors([]);
  }
  const params = new URLSearchParams({ limit: "50" });
  if (state !== "all") params.set("state", state);
  if (variant) params.set("variantId", variant);
  if (q) params.set("q", q);
  const cursor = cursors.at(-1);
  if (cursor) params.set("after", cursor);
  const inventory = useManagementResource(`/inventory?${params}`, inventoryResponseSchema);
  const [updating, setUpdating] = useState<InventoryItem | null>(null);
  const [history, setHistory] = useState<InventoryItem | null>(null);
  const replace = (item: InventoryItem) =>
    inventory.setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((row) => (row.variantId === item.variantId ? item : row)),
          }
        : current,
    );
  const items = inventory.data?.items ?? [];
  const actions = (item: InventoryItem) => (
    <>
      {canAdjust && (
        <button
          type="button"
          className="btn btn-s btn-sm"
          aria-label={`Update stock of ${item.sku}`}
          onClick={() => setUpdating(item)}
        >
          <Icon name="layers" size="sm" />
          Update stock
        </button>
      )}
      <button
        type="button"
        className="btn btn-g btn-sm"
        aria-label={`Stock history of ${item.sku}`}
        onClick={() => setHistory(item)}
      >
        <Icon name="clock" size="sm" />
        History
      </button>
    </>
  );
  const pager = inventory.data && (
    <div className="tbl-f">
      <span>
        {items.length} {items.length === 1 ? "stock line" : "stock lines"} on this page
      </span>
      <div className="pager">
        <button
          type="button"
          aria-label="Previous page"
          disabled={cursors.length === 0 || inventory.busy}
          onClick={() => setCursors((value) => value.slice(0, -1))}
        >
          <Icon name="cl" size="sm" />
        </button>
        <button type="button" aria-current="page" aria-label={`Page ${cursors.length + 1}`}>
          {cursors.length + 1}
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={!inventory.data.nextCursor || inventory.busy}
          onClick={() => setCursors((value) => [...value, inventory.data!.nextCursor!])}
        >
          <Icon name="cr" size="sm" />
        </button>
      </div>
    </div>
  );
  return (
    <>
      <PageHead
        title="Inventory"
        sub="Stock per option. Every change is recorded with a reason; at 0 a product stays published and shows Out of Stock."
      />
      <div className="stack orders-head">
        <div className="tabs" role="tablist" aria-label="Stock state">
          {(["all", "in_stock", "low", "out"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              className="tab"
              aria-selected={state === value}
              onClick={() => {
                setState(value);
                setCursors([]);
              }}
            >
              {value !== "all" && (
                <span
                  className={`dotc ${value === "in_stock" ? "ok" : value === "low" ? "warn" : "err"}`}
                  aria-hidden="true"
                />
              )}
              {value === "all" ? "All" : STATE_LABEL[value]}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <div className="search">
            <Icon name="search" />
            <label className="sr" htmlFor="inventory-q">
              Search product or SKU
            </label>
            <input
              id="inventory-q"
              name="q"
              type="search"
              maxLength={100}
              placeholder="Search product or SKU"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // Enter searches at once.
                setQ(typed.trim().slice(0, 100));
                setCursors([]);
              }}
            />
          </div>
        </div>
      </div>
      {variant && (
        <div className="note">
          <Icon name="info" />
          <p>Showing one stock line.</p>
          <button
            type="button"
            className="btn btn-s btn-sm"
            onClick={() => navigate({ variant: null })}
          >
            Show all stock
          </button>
        </div>
      )}
      <ResourceNotice resource={inventory} compact />
      {inventory.data &&
        (items.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="ic">
                <Icon name={state === "low" || state === "out" ? "check-c" : "search"} />
              </div>
              <h3>
                {state === "low"
                  ? "No low-stock options"
                  : state === "out"
                    ? "Nothing is out of stock"
                    : q
                      ? "No matching stock"
                      : "No stock lines yet"}
              </h3>
              <p>
                {state === "low" || state === "out"
                  ? "Options at or below their alert level appear here."
                  : q
                    ? "Try a different product name or SKU."
                    : "Add options to products first; each option gets its own stock line."}
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="tbl-wrap only-d">
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>SKU</th>
                      <th>Status</th>
                      <th className="num">In stock</th>
                      <th className="num">Alert at</th>
                      <th>Stock status</th>
                      <th className="w1">
                        <span className="sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.variantId} className="inv-row">
                        <td>
                          <div className="cellp">
                            <div>
                              <b>{item.productName}</b>
                              <small>{describeAttributes(item.attributes)}</small>
                            </div>
                          </div>
                        </td>
                        <td className="mono small">{item.sku}</td>
                        <td>
                          <PublishTags item={item} />
                        </td>
                        <td className="num">
                          <b className={`stock-n ${item.stockState}`}>{item.stockOnHand}</b>
                        </td>
                        <td className="num muted">{item.lowStockThreshold}</td>
                        <td>
                          <StockTag state={item.stockState} />
                        </td>
                        <td className="w1">
                          <div className="row nowrap-row">{actions(item)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pager}
            </div>
            {/* Phones: the prototype's stock rows in place of the table. */}
            <div className="only-m">
              <div className="mlist">
                {items.map((item) => (
                  <div key={item.variantId} className="mrow inv-row">
                    <div className="mrow-b">
                      <div className="mrow-t">
                        <b>{item.productName}</b>
                        <b className={`stock-n big ${item.stockState}`}>{item.stockOnHand}</b>
                      </div>
                      <div className="meta">
                        <span>{describeAttributes(item.attributes)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="mono">{item.sku}</span>
                        <span aria-hidden="true">·</span>
                        <span>Alert at {item.lowStockThreshold}</span>
                      </div>
                      <div className="row tag-gap">
                        <StockTag state={item.stockState} />
                        <PublishTags item={item} quiet />
                      </div>
                      <div className="mrow-a">{actions(item)}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="tbl-wrap orders-mpager">{pager}</div>
            </div>
          </>
        ))}
      {updating && (
        <UpdateStock
          key={updating.variantId}
          item={updating}
          resource={inventory}
          onClose={() => setUpdating(null)}
          onChanged={(item) => {
            toast(`${item.sku}: ${updating.stockOnHand} → ${item.stockOnHand}`);
            replace(item);
            setUpdating(null);
          }}
        />
      )}
      <Drawer
        open={history !== null}
        onClose={() => setHistory(null)}
        title="Stock history"
        sub={history ? `${history.productName} · ${history.sku}` : undefined}
      >
        {history && (
          <StockHistory key={`${history.variantId}-${history.stockOnHand}`} item={history} />
        )}
      </Drawer>
    </>
  );
}

function StockTag({ state }: { state: StockState }) {
  return (
    <span className={`tag ${state === "in_stock" ? "ok" : state === "low" ? "low" : "out"}`}>
      {STATE_LABEL[state]}
    </span>
  );
}

/** Published or draft, and an inactive option; `quiet` leaves out the usual "Published". */
function PublishTags({ item, quiet = false }: { item: InventoryItem; quiet?: boolean }) {
  return (
    <>
      {item.productStatus === "published" ? (
        !quiet && <span className="tag pub">Published</span>
      ) : (
        <span className="tag">Draft</span>
      )}
      {!item.active && <span className="tag">Inactive</span>}
    </>
  );
}

type Mode = "add" | "remove" | "set";
const MODES: ReadonlyArray<[Mode, string]> = [
  ["add", "Add stock"],
  ["remove", "Remove"],
  ["set", "Set exact count"],
];

/**
 * The prototype's "Update stock" drawer (`adjBody`): the kind of change, the quantity with a
 * stepper and quick amounts, the balance it leaves, and the reason. One command ID per opened
 * drawer; any change of the payload makes a new one, so only an unchanged retry replays.
 */
function UpdateStock({
  item,
  resource,
  onClose,
  onChanged,
}: {
  item: InventoryItem;
  /** The list's resource: the change runs through it, and its notice shows here too. */
  resource: Pick<
    ReturnType<typeof useManagementResource>,
    "run" | "disabled" | "message" | "busy" | "denied" | "reload"
  >;
  onClose: () => void;
  onChanged: (item: InventoryItem) => void;
}) {
  const form = useId();
  const [mode, setMode] = useState<Mode>("add");
  const [quantity, setQuantity] = useState(item.stockState === "in_stock" ? "" : "10");
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const [open, setOpen] = useState(true);
  const renew = () => setCommandId(crypto.randomUUID());
  const count = /^\d{1,9}$/.test(quantity) ? Number(quantity) : null;
  const after = count === null ? null : stockAfter(mode, item.stockOnHand, count);
  const close = () => {
    setOpen(false);
    onClose();
  };
  const step = (by: number) => {
    setQuantity(String(Math.max(0, (count ?? 0) + by)));
    renew();
  };
  return (
    <Drawer
      open={open}
      onClose={close}
      title="Update stock"
      sub="Changes apply to the store at once"
      foot={
        <>
          <button type="button" className="btn btn-s" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            form={form}
            className="btn btn-p"
            disabled={resource.disabled || after === null || after < 0}
          >
            <Icon name="check" />
            Save stock
          </button>
        </>
      }
    >
      <form
        id={form}
        className="form"
        data-unsaved="this stock change"
        // A changed payload is a different action: it gets a new command ID, so a retry of the
        // unchanged form replays while an edited one is never mistaken for a reuse.
        onChange={renew}
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const outcome = await resource.run((signal) =>
            mode === "set"
              ? managementRequest(
                  `/inventory/${item.variantId}/set`,
                  stockSetResponseSchema,
                  "POST",
                  setCommand(commandId, item.stockOnHand, data),
                  signal,
                )
              : managementRequest(
                  `/inventory/${item.variantId}/adjustments`,
                  stockAdjustmentResponseSchema,
                  "POST",
                  mode === "add" ? addCommand(commandId, data) : removeCommand(commandId, data),
                  signal,
                ),
          );
          if (outcome.ok) onChanged((outcome.value as { item: InventoryItem }).item);
        }}
      >
        <div className="row nowrap-row inv-head">
          <div className="inv-head-b">
            <b>{item.productName}</b>
            <span className="small muted">
              {describeAttributes(item.attributes)} · <span className="mono">{item.sku}</span>
            </span>
            <div className="row tag-gap">
              <StockTag state={item.stockState} />
              <PublishTags item={item} />
            </div>
          </div>
          <Link
            className="btn btn-g btn-sm"
            href={`/workspace/products?product=${item.productId}`}
            data-leave
          >
            Open
            <Icon name="arr-r" size="sm" />
          </Link>
        </div>
        <div className="seg seg-full" role="group" aria-label="Kind of change">
          {MODES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                renew();
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <fieldset className="plain-fs form" disabled={resource.disabled}>
          <div className="field inv-qty">
            <label className="label" htmlFor={`${form}-q`}>
              {mode === "set"
                ? `Counted units (now ${item.stockOnHand})`
                : mode === "add"
                  ? "Units received"
                  : "Units to remove"}
            </label>
            <div className="stepper">
              <button type="button" aria-label="Decrease" onClick={() => step(-1)}>
                <Icon name="minus" />
              </button>
              <input
                id={`${form}-q`}
                name={mode === "set" ? "target" : "quantity"}
                required
                inputMode="numeric"
                maxLength={9}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value.trim())}
              />
              <button type="button" aria-label="Increase" onClick={() => step(1)}>
                <Icon name="plus" />
              </button>
            </div>
            <div className="row inv-quick">
              {(mode === "set" ? [0, 10, 25, 50] : [5, 10, 20, 50]).map((n) => (
                <button
                  key={n}
                  type="button"
                  className="btn btn-s btn-sm"
                  onClick={() => {
                    setQuantity(String(n));
                    renew();
                  }}
                >
                  {mode === "set" ? n : `+${n}`}
                </button>
              ))}
            </div>
          </div>
          <div className="inv-prev" aria-live="polite">
            <span>
              <span className="small muted">Stock after saving</span>
              <br />
              <b className="num">
                {item.stockOnHand} → {after === null ? "…" : after}
              </b>
            </span>
            {after !== null && after >= 0 && (
              <StockTag state={stockStateFor(after, item.lowStockThreshold)} />
            )}
          </div>
          {after !== null && after < 0 && (
            <p className="errm" role="alert">
              <Icon name="alert" />
              You can&apos;t remove more than the {item.stockOnHand} units in stock.
            </p>
          )}
          {after === 0 && item.productStatus === "published" && (
            <div className="note warn">
              <Icon name="info" />
              <p>
                At 0 the product stays published and shows <b>Out of Stock</b>.
              </p>
            </div>
          )}
          {mode === "remove" && (
            <div className="field">
              <label className="label" htmlFor={`${form}-r`}>
                Reason
              </label>
              <select id={`${form}-r`} className="select" name="reason" defaultValue="MANUAL">
                <option value="MANUAL">Stock count correction</option>
                <option value="DAMAGE">Damaged or faulty</option>
              </select>
            </div>
          )}
          <div className="field">
            <label className="label" htmlFor={`${form}-n`}>
              <span>
                Note{" "}
                {mode === "add" ? (
                  <span className="opt">Optional</span>
                ) : (
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                )}
              </span>
            </label>
            <textarea
              id={`${form}-n`}
              className="textarea"
              name="note"
              rows={2}
              maxLength={500}
              required={mode !== "add"}
              placeholder={
                mode === "add" ? "e.g. Delivery from the supplier" : "Why the count changes"
              }
            />
          </div>
          <p className="help">
            The low-stock alert ({item.lowStockThreshold}) is set per option in the product editor.
          </p>
          <ResourceNotice resource={resource} compact />
        </fieldset>
      </form>
    </Drawer>
  );
}

function StockHistory({ item }: { item: InventoryItem }) {
  const history = useManagementResource(
    `/inventory/${item.variantId}/movements?limit=20`,
    stockMovementsResponseSchema,
  );
  const movements = history.data?.movements ?? [];
  return (
    <div className="stack">
      <ResourceNotice resource={history} compact />
      {history.data && movements.length === 0 && (
        <p className="small muted">No stock movements yet.</p>
      )}
      {movements.length > 0 && (
        <ul className="hist-list">
          {movements.map((m) => (
            <li key={m.id}>
              <b className={m.delta > 0 ? "delta up" : "delta down"}>
                {m.delta > 0 ? "+" : ""}
                {m.delta}
              </b>
              <span className="hist-b">
                <span>
                  {reasonLabel[m.reason] ?? m.reason}
                  {m.note ? ` · ${m.note}` : ""}
                </span>
                <small className="muted">
                  {m.actor?.name ?? "System"} · {when(m.createdAt)}
                </small>
              </span>
              <span className="num small">→ {m.balanceAfter}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
