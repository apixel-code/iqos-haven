"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import {
  adminCustomersResponseSchema,
  adminOrdersResponseSchema,
  productsResponseSchema,
} from "@ih/contracts";
import { orderHref, productHref } from "../lib/links";
import { Icon } from "./icons";
import { Modal } from "./overlays";
import { Pop } from "./pop";

type Results = {
  term: string;
  orders: Array<{ id: string; orderNumber: string; name: string | null; status: string }>;
  products: Array<{ id: string; name: string; brand: string }>;
  customers: Array<{ id: string; name: string; phone: string }>;
  failed: boolean;
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  processing: "Processing",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/**
 * The prototype's global search (`searchHtml`, parity G-A12): orders, products and customers,
 * looked up on the server in the lists the signed-in user may read (the API checks each one),
 * after a short pause. Two characters at least; nothing typed is kept anywhere.
 */
function useSearch(value: string, permissions: readonly string[]): Results | null {
  const [results, setResults] = useState<Results | null>(null);
  const can = (permission: string) => permissions.includes(permission);
  const canOrders = can("orders.read");
  const canProducts = can("catalog.read");
  const canCustomers = can("customers.read");
  useEffect(() => {
    const term = value.trim();
    if (term.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const get = async <T,>(path: string, schema: { parse: (body: unknown) => T }) => {
        const response = await fetch(`/api/v1/admin${path}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        return schema.parse(await response.json());
      };
      const q = encodeURIComponent(term.slice(0, 100));
      Promise.allSettled([
        canOrders ? get(`/orders?q=${q}&limit=4`, adminOrdersResponseSchema) : null,
        canProducts ? get(`/products?q=${q}&limit=4`, productsResponseSchema) : null,
        canCustomers ? get(`/customers?q=${q}&limit=3`, adminCustomersResponseSchema) : null,
      ]).then(([orders, products, customers]) => {
        if (controller.signal.aborted) return;
        const value = <T,>(result: PromiseSettledResult<T | null>) =>
          result.status === "fulfilled" ? result.value : null;
        setResults({
          term,
          orders:
            value(orders)?.items.map((order) => ({
              id: order.id,
              orderNumber: order.orderNumber,
              name: order.customer?.name ?? null,
              status: order.status,
            })) ?? [],
          products:
            value(products)?.items.map((product) => ({
              id: product.id,
              name: product.name,
              brand: product.brand.name,
            })) ?? [],
          customers:
            value(customers)?.items.map((customer) => ({
              id: customer.id,
              name: customer.name,
              phone: customer.phone,
            })) ?? [],
          failed: [orders, products, customers].some((result) => result.status === "rejected"),
        });
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value, canOrders, canProducts, canCustomers]);
  return results && results.term === value.trim() ? results : null;
}

function ResultList({
  value,
  results,
  go,
}: {
  value: string;
  results: Results | null;
  go: (href: string) => void;
}) {
  if (value.trim().length < 2)
    return (
      <p className="gs-hint">
        Type at least 2 characters. Search by order number, product, SKU, customer or phone.
      </p>
    );
  if (!results)
    return (
      <p className="gs-hint" role="status">
        Searching…
      </p>
    );
  const none =
    results.orders.length === 0 && results.products.length === 0 && results.customers.length === 0;
  if (none)
    return (
      <div className="empty gs-empty">
        <div className="ic">
          <Icon name="search" />
        </div>
        <h3>No results</h3>
        <p>
          {results.failed
            ? "Search is not available right now. Try again shortly."
            : `Nothing matches “${results.term}”.`}
        </p>
      </div>
    );
  return (
    <div className="menu gs-menu">
      {results.orders.length > 0 && (
        <>
          <div className="nav-g">Orders</div>
          {results.orders.map((order) => (
            <button key={order.id} type="button" onClick={() => go(orderHref(order.id))}>
              <span className="mono">{order.orderNumber}</span>
              <span className="gs-name">{order.name ?? ""}</span>
              <span
                className={`st st-${order.status === "out_for_delivery" ? "ofd" : order.status}`}
              >
                {STATUS_LABEL[order.status]}
              </span>
            </button>
          ))}
        </>
      )}
      {results.products.length > 0 && (
        <>
          <div className="nav-g">Products</div>
          {results.products.map((product) => (
            <button key={product.id} type="button" onClick={() => go(productHref(product.id))}>
              <Icon name="box" />
              <span className="gs-name">{product.name}</span>
              <span className="small muted">{product.brand}</span>
            </button>
          ))}
        </>
      )}
      {results.customers.length > 0 && (
        <>
          <div className="nav-g">Customers</div>
          {results.customers.map((customer) => (
            <button
              key={customer.id}
              type="button"
              onClick={() => go(`/workspace/customers?customer=${customer.id}`)}
            >
              <span className="av gs-av" aria-hidden="true">
                {customer.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="gs-name">{customer.name}</span>
              <span className="small muted mono">{customer.phone}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/** The topbar field (from 720 px), focused with "/" like the prototype. */
export function GlobalSearch({ permissions }: { permissions: readonly string[] }) {
  const router = useRouter();
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const results = useSearch(value, permissions);
  useEffect(() => {
    const slash = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], dialog")) return;
      if (!field.current || field.current.offsetParent === null) return;
      event.preventDefault();
      field.current.focus();
    };
    document.addEventListener("keydown", slash);
    return () => document.removeEventListener("keydown", slash);
  }, []);
  const go = (href: string) => {
    setOpen(false);
    setValue("");
    router.push(href);
  };
  return (
    <>
      <div className="gsearch" role="search" ref={box}>
        <label className="sr" htmlFor={`${id}-gs`}>
          Search orders, products, customers
        </label>
        <Icon name="search" />
        <input
          ref={field}
          id={`${id}-gs`}
          type="search"
          autoComplete="off"
          placeholder="Search orders, products, customers or phone"
          value={value}
          maxLength={100}
          onChange={(event) => {
            setValue(event.target.value);
            setOpen(true);
          }}
          onFocus={() => value && setOpen(true)}
        />
        <kbd aria-hidden="true">/</kbd>
      </div>
      {/* Outside the field's box, so the field's own rules do not reach the results. */}
      <Pop
        anchor={box}
        open={open && value.length > 0}
        onClose={() => setOpen(false)}
        align="left"
        label="Search results"
        minWidth={360}
        className="gs-pop"
      >
        <div id={`${id}-gs-results`}>
          <ResultList value={value} results={results} go={go} />
        </div>
      </Pop>
    </>
  );
}

/** Phones: the search button opens the prototype's search modal. */
export function MobileSearch({ permissions }: { permissions: readonly string[] }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const results = useSearch(value, permissions);
  return (
    <>
      <button
        type="button"
        className="ibtn only-m-f"
        aria-label="Search"
        onClick={() => setOpen(true)}
      >
        <Icon name="search" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Search">
        <div className="search">
          <Icon name="search" />
          <label className="sr" htmlFor={`${id}-ms`}>
            Search orders, products, customers
          </label>
          <input
            id={`${id}-ms`}
            type="search"
            autoComplete="off"
            data-autofocus=""
            placeholder="Order number, product, customer or phone"
            value={value}
            maxLength={100}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <div className="ms-r">
          <ResultList
            value={value}
            results={results}
            go={(href) => {
              setOpen(false);
              setValue("");
              router.push(href);
            }}
          />
        </div>
      </Modal>
    </>
  );
}
