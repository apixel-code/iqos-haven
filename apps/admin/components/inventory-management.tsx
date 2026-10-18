"use client";
import { useState } from "react";
import {
  inventoryResponseSchema,
  stockAdjustmentResponseSchema,
  stockMovementsResponseSchema,
  stockSetResponseSchema,
  type InventoryItem,
} from "@ih/contracts";
import { addCommand, reasonLabel, removeCommand, setCommand } from "../lib/inventory";
import { managementRequest } from "../lib/management";
import { describeAttributes } from "../lib/variants";
import { isUuid } from "../lib/links";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { useUrlQuery } from "./use-url-query";

type State = "all" | "in_stock" | "low" | "out";
const STATE_LABEL: Record<InventoryItem["stockState"], string> = {
  in_stock: "In stock",
  low: "Low stock",
  out: "Out of stock",
};

/**
 * Inventory (steps 46–47): stock states, history and ledger adjustments. Every action carries a
 * command ID generated when its form opens and kept across retries, so a retried request can
 * never apply twice. Zero stock never unpublishes a product.
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
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  // A link can change the filters while this list is open: start again from the first page.
  const filterScope = `${state}|${variant}`;
  const [pagedScope, setPagedScope] = useState(filterScope);
  if (pagedScope !== filterScope) {
    setPagedScope(filterScope);
    setCursor(null);
  }
  const params = new URLSearchParams({ limit: "50" });
  if (state !== "all") params.set("state", state);
  if (variant) params.set("variantId", variant);
  if (q) params.set("q", q);
  if (cursor) params.set("after", cursor);
  const inventory = useManagementResource(`/inventory?${params}`, inventoryResponseSchema);
  const replace = (item: InventoryItem) =>
    inventory.setData((current) =>
      current
        ? {
            ...current,
            items: current.items.map((row) => (row.variantId === item.variantId ? item : row)),
          }
        : current,
    );
  return (
    <section className="management-card">
      <header className="card-heading">
        <h2>Stock</h2>
        <span className="badge">Every change is recorded with a reason</span>
      </header>
      <p className="muted">
        When stock reaches 0 the product stays published and shows Out of Stock in the store.
      </p>
      <div className="tab-list" role="tablist" aria-label="Stock state">
        {(["all", "in_stock", "low", "out"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            className="secondary-button"
            aria-selected={state === value}
            onClick={() => {
              setState(value);
              setCursor(null);
            }}
          >
            {value === "all" ? "All" : STATE_LABEL[value]}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(String(new FormData(e.currentTarget).get("q") ?? "").trim());
          setCursor(null);
        }}
      >
        <label>
          <span>Search SKU or product</span>
          <input name="q" type="search" maxLength={100} defaultValue={q} />
        </label>
      </form>
      {variant && (
        <p className="notice">
          Showing one stock line.{" "}
          <button type="button" className="text-button" onClick={() => navigate({ variant: null })}>
            Show all stock
          </button>
        </p>
      )}
      <ResourceNotice resource={inventory} />
      {inventory.data && (
        <>
          {inventory.data.items.length === 0 && (
            <p className="muted">No variants match. Add variants to products first.</p>
          )}
          <div className="record-list">
            {inventory.data.items.map((item) => (
              <StockCard
                key={item.variantId}
                item={item}
                canAdjust={canAdjust}
                run={inventory.run}
                disabled={inventory.disabled}
                onChanged={replace}
              />
            ))}
          </div>
          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!cursor || inventory.busy}
              onClick={() => setCursor(null)}
            >
              First page
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!inventory.data.nextCursor || inventory.busy}
              onClick={() => setCursor(inventory.data!.nextCursor)}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}

type Run = ReturnType<typeof useManagementResource>["run"];
type Action = "add" | "remove" | "set";

function StockCard({
  item,
  canAdjust,
  run,
  disabled,
  onChanged,
}: {
  item: InventoryItem;
  canAdjust: boolean;
  run: Run;
  disabled: boolean;
  onChanged: (item: InventoryItem) => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  // One command ID per opened action, reused for retries of that same action.
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const [history, setHistory] = useState(false);
  const open = (next: Action) => {
    setAction(next);
    setCommandId(crypto.randomUUID());
  };
  const submit = async (data: FormData) => {
    const outcome = await run((signal) =>
      action === "set"
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
            action === "add" ? addCommand(commandId, data) : removeCommand(commandId, data),
            signal,
          ),
    );
    if (outcome.ok) {
      setAction(null);
      onChanged((outcome.value as { item: InventoryItem }).item);
    }
  };
  return (
    <article className="record-card">
      <header className="card-heading">
        <strong>
          {item.productName} · {item.sku}
        </strong>
        <span className="badge">
          {STATE_LABEL[item.stockState]} · {item.stockOnHand} in stock
          {item.active ? "" : " · Inactive"}
        </span>
      </header>
      <p className="muted">
        {describeAttributes(item.attributes)} · Low-stock alert at {item.lowStockThreshold}
      </p>
      <div className="form-actions">
        {canAdjust && (
          <>
            <button type="button" className="secondary-button" onClick={() => open("add")}>
              Add stock
            </button>
            <button type="button" className="secondary-button" onClick={() => open("remove")}>
              Remove stock
            </button>
            <button type="button" className="secondary-button" onClick={() => open("set")}>
              Set count
            </button>
          </>
        )}
        <button type="button" className="secondary-button" onClick={() => setHistory(!history)}>
          {history ? "Hide history" : "History"}
        </button>
      </div>
      {action && (
        <form
          data-unsaved="this stock change"
          // A changed payload is a different action: it gets a new command ID, so a retry of
          // the unchanged form replays while an edited one is never mistaken for a reuse.
          onChange={() => setCommandId(crypto.randomUUID())}
          onSubmit={(e) => {
            e.preventDefault();
            void submit(new FormData(e.currentTarget));
          }}
        >
          <fieldset disabled={disabled}>
            <div className="form-grid">
              {action === "set" ? (
                <label>
                  <span>Counted units * (currently {item.stockOnHand})</span>
                  <input name="target" required inputMode="numeric" maxLength={9} />
                </label>
              ) : (
                <label>
                  <span>{action === "add" ? "Units received *" : "Units to remove *"}</span>
                  <input name="quantity" required inputMode="numeric" maxLength={9} />
                </label>
              )}
              {action === "remove" && (
                <label>
                  <span>Reason *</span>
                  <select name="reason" defaultValue="MANUAL">
                    <option value="MANUAL">Correction</option>
                    <option value="DAMAGE">Damaged</option>
                  </select>
                </label>
              )}
              <label className="wide-field">
                <span>{action === "add" ? "Note (optional)" : "Note *"}</span>
                <textarea name="note" rows={2} maxLength={500} required={action !== "add"} />
              </label>
            </div>
            <div className="form-actions">
              <button type="submit" className="primary-button">
                {action === "add"
                  ? "Add stock"
                  : action === "remove"
                    ? "Remove stock"
                    : "Set count"}
              </button>
              <button type="button" className="secondary-button" onClick={() => setAction(null)}>
                Cancel
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {history && (
        <StockHistory key={`${item.variantId}-${item.stockOnHand}`} variantId={item.variantId} />
      )}
    </article>
  );
}

function StockHistory({ variantId }: { variantId: string }) {
  const history = useManagementResource(
    `/inventory/${variantId}/movements?limit=20`,
    stockMovementsResponseSchema,
  );
  return (
    <div>
      <ResourceNotice resource={history} />
      {history.data && history.data.movements.length === 0 && (
        <p className="muted">No stock movements yet.</p>
      )}
      <ul className="record-list">
        {history.data?.movements.map((m) => (
          <li key={m.id}>
            <strong>
              {m.delta > 0 ? "+" : ""}
              {m.delta}
            </strong>{" "}
            → {m.balanceAfter} · {reasonLabel[m.reason] ?? m.reason}
            {m.note ? ` · ${m.note}` : ""} · {m.actor?.name ?? "System"} ·{" "}
            {new Date(m.createdAt).toLocaleString("en-AE", { timeZone: "Asia/Dubai" })}
          </li>
        ))}
      </ul>
    </div>
  );
}
