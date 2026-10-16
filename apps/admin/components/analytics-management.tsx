"use client";
import { useCallback, useEffect, useState } from "react";
import { analyticsSchema, ORDER_STATUSES_FOR_MIX, type Analytics } from "@ih/contracts";
import { money, ORDER_STATUS_LABELS } from "../lib/orders";
import { analyticsRange, percent, rangeDays, signedChange } from "../lib/analytics";

type Tab = "overview" | "sales" | "products" | "search" | "wishlist";
const TABS: Array<[Tab, string]> = [
  ["overview", "Overview"],
  ["sales", "Sales"],
  ["products", "Products & brands"],
  ["search", "Search"],
  ["wishlist", "Wishlist"],
];
const PRESETS = [7, 30, 90] as const;
type Load =
  { state: "loading" } | { state: "failed"; status: number } | { state: "ready"; data: Analytics };

const dubaiTime = (iso: string) =>
  new Intl.DateTimeFormat("en-AE", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

/**
 * The Owner's analytics (roadmap step 109, ADR 0075). Every figure comes from
 * `GET /v1/admin/analytics`; days not computed are named, never drawn as zero, and there are no
 * sample values. Charts are single-series with every value also in a table.
 */
export function AnalyticsManagement() {
  const [range, setRange] = useState(() => analyticsRange(30, new Date()));
  const [tab, setTab] = useState<Tab>("overview");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const refresh = useCallback(() => {
    fetch(`/api/v1/admin/analytics?from=${range.from}&to=${range.to}`, {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) return setLoad({ state: "failed", status: response.status });
        setLoad({ state: "ready", data: analyticsSchema.parse(await response.json()) });
      })
      .catch(() => setLoad({ state: "failed", status: 0 }));
  }, [range]);
  useEffect(refresh, [refresh]);
  // A new range shows "loading" until its own answer arrives; a retry keeps the current view.
  const choose = (next: { from: string; to: string; preset: number | null }) => {
    setLoad({ state: "loading" });
    setRange(next);
  };

  return (
    <div className="dashboard">
      <div className="resource-toolbar">
        <div className="inline-row" role="group" aria-label="Date range">
          {PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              className="secondary-button"
              aria-pressed={range.preset === days}
              onClick={() => choose(analyticsRange(days, new Date()))}
            >
              Last {days} days
            </button>
          ))}
        </div>
        <form
          className="inline-row"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const from = String(form.get("from"));
            const to = String(form.get("to"));
            if (from && to && from <= to) choose({ from, to, preset: null });
          }}
        >
          <label>
            From <input type="date" name="from" defaultValue={range.from} key={"f" + range.from} />
          </label>
          <label>
            To <input type="date" name="to" defaultValue={range.to} key={"t" + range.to} />
          </label>
          <button className="secondary-button" type="submit">
            Apply
          </button>
        </form>
      </div>
      <div className="tab-list" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {load.state === "loading" && <p className="muted">Loading analytics…</p>}
      {load.state === "failed" && (
        <div className="notice" role="alert">
          {load.status === 403
            ? "Analytics are for the Owner."
            : load.status === 400
              ? "Choose a range of real dates, at most a year long."
              : "Analytics could not be loaded."}{" "}
          <button className="text-button" type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {load.state === "ready" && <AnalyticsBody data={load.data} tab={tab} />}
    </div>
  );
}

function AnalyticsBody({ data, tab }: { data: Analytics; tab: Tab }) {
  const { freshness } = data;
  return (
    <>
      <p className="muted small">
        {data.range.from} to {data.range.to} (Asia/Dubai), {data.currency}. {data.taxNote}{" "}
        {freshness.newestComputedAt
          ? `Figures computed up to ${dubaiTime(freshness.newestComputedAt)}.`
          : ""}
      </p>
      {freshness.missing.length > 0 && (
        <p className="notice">
          {freshness.missing.length} of {data.range.days} days are not computed yet and are left out
          (first: {freshness.missing[0]}). Run the backfill for older days.
        </p>
      )}
      {tab === "overview" && <Overview data={data} />}
      {tab === "sales" && <Sales data={data} />}
      {tab === "products" && <Products data={data} />}
      {tab === "search" && <Search data={data} />}
      {tab === "wishlist" && <Wishlist data={data} />}
    </>
  );
}

function Tile(props: { label: string; value: string; foot?: string }) {
  return (
    <div className="kpi">
      <span className="muted small">{props.label}</span>
      <span className="kpi-value">{props.value}</span>
      {props.foot && <span className="muted small">{props.foot}</span>}
    </div>
  );
}

function Overview({ data }: { data: Analytics }) {
  const { totals, previous } = data;
  const vs = (now: number | null, before: number | null, format: (n: number) => string) =>
    previous.missingDays === data.range.days
      ? "No earlier figures"
      : signedChange(now, before, format);
  const placedTotal = ORDER_STATUSES_FOR_MIX.reduce((sum, key) => sum + data.statusMix[key], 0);
  return (
    <>
      <div className="kpi-grid">
        <Tile
          label="Booked sales"
          value={money(totals.booked.totalFils)}
          foot={vs(totals.booked.totalFils, previous.bookedTotalFils, money)}
        />
        <Tile
          label="Booked orders"
          value={totals.booked.orders.toLocaleString("en-AE")}
          foot={vs(totals.booked.orders, previous.bookedOrders, (n) => n.toLocaleString("en-AE"))}
        />
        <Tile
          label="Average order value"
          value={totals.booked.aovFils === null ? "—" : money(totals.booked.aovFils)}
          foot={vs(totals.booked.aovFils, previous.aovFils, money)}
        />
        <Tile
          label="Cancellation rate"
          value={percent(totals.cancelled.rateBps)}
          foot={`${totals.cancelled.orders} of ${totals.placed} placed`}
        />
        <Tile
          label="Delivered sales"
          value={money(totals.delivered.totalFils)}
          foot={`${totals.delivered.orders} orders, by delivery date`}
        />
        <Tile
          label="Cash collected"
          value={money(totals.collected.amountFils)}
          foot={`${totals.collected.orders} orders, by collection date`}
        />
      </div>
      <section className="management-card" aria-labelledby="an-daily">
        <h2 id="an-daily">Booked sales per day</h2>
        <p className="muted small">Orders placed and not cancelled, by order date.</p>
        <ColumnChart
          label="Booked sales per day"
          points={rangeDays(data.range.from, data.range.to).map((key) => {
            const day = data.days.find((item) => item.day === key);
            return {
              key,
              value: day ? day.bookedTotalFils : null,
              text: day
                ? `${key}: ${money(day.bookedTotalFils)}, ${day.bookedOrders} orders`
                : `${key}: not computed`,
            };
          })}
          format={money}
        />
      </section>
      <section className="management-card" aria-labelledby="an-status">
        <h2 id="an-status">Order status now</h2>
        <p className="muted small">
          Orders placed in the range ({placedTotal}), by their status today.
        </p>
        {placedTotal ? (
          <>
            <div className="status-bar" role="img" aria-label="Order status distribution">
              {ORDER_STATUSES_FOR_MIX.filter((key) => data.statusMix[key]).map((key) => (
                <i
                  key={key}
                  className={`status-${key}`}
                  style={{ flexGrow: data.statusMix[key] }}
                  title={`${ORDER_STATUS_LABELS[key]}: ${data.statusMix[key]}`}
                />
              ))}
            </div>
            <ul className="status-legend">
              {ORDER_STATUSES_FOR_MIX.map((key) => (
                <li key={key}>
                  <span className={`status-dot status-${key}`} aria-hidden="true" />
                  {ORDER_STATUS_LABELS[key]} <b>{data.statusMix[key]}</b>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="muted">No orders were placed in this range.</p>
        )}
      </section>
    </>
  );
}

function Sales({ data }: { data: Analytics }) {
  return (
    <section className="management-card" aria-labelledby="an-sales">
      <h2 id="an-sales">Per day</h2>
      <p className="muted small">
        Booked by order date, delivered by delivery date, cash by collection date: three different
        days for the same order.
      </p>
      {data.days.length ? (
        <div className="order-table-wrap">
          <table className="order-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Placed</th>
                <th>Cancelled</th>
                <th>Booked</th>
                <th>Booked sales</th>
                <th>Delivered</th>
                <th>Delivered sales</th>
                <th>Cash collected</th>
              </tr>
            </thead>
            <tbody>
              {[...data.days].reverse().map((day) => (
                <tr key={day.day}>
                  <td>{day.day}</td>
                  <td>{day.placed}</td>
                  <td>{day.cancelled}</td>
                  <td>{day.bookedOrders}</td>
                  <td>{money(day.bookedTotalFils)}</td>
                  <td>{day.deliveredOrders}</td>
                  <td>{money(day.deliveredTotalFils)}</td>
                  <td>{money(day.collectedFils)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No computed days in this range.</p>
      )}
    </section>
  );
}

function Products({ data }: { data: Analytics }) {
  const maxBrand = Math.max(1, ...data.brands.map((brand) => brand.deliveredNetFils));
  return (
    <div className="dashboard-split">
      <section className="management-card" aria-labelledby="an-products">
        <h2 id="an-products">Best-selling products</h2>
        <p className="muted small">
          By delivered sales (merchandise after discounts, by delivery date); ordered units are
          orders placed in the range and not cancelled.
        </p>
        {data.products.length ? (
          <div className="order-table-wrap">
            <table className="order-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Ordered</th>
                  <th>Delivered</th>
                  <th>Delivered sales</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((product) => (
                  <tr key={product.productId}>
                    <td>{product.name}</td>
                    <td>{product.orderedUnits}</td>
                    <td>{product.deliveredUnits}</td>
                    <td>{money(product.deliveredNetFils)}</td>
                    <td>{percent(product.shareBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No sales in this range.</p>
        )}
      </section>
      <section className="management-card" aria-labelledby="an-brands">
        <h2 id="an-brands">Best-selling brands</h2>
        <p className="muted small">The brand each sale was made under, even if renamed since.</p>
        {data.brands.length ? (
          <ol className="rank-list">
            {data.brands.map((brand) => (
              <li key={brand.brandName}>
                <span>
                  <b>{brand.brandName}</b>{" "}
                  <span className="muted small">· {brand.deliveredUnits} delivered units</span>
                </span>
                <span>{money(brand.deliveredNetFils)}</span>
                <span className="rank-bar" aria-hidden="true">
                  <i style={{ width: `${(brand.deliveredNetFils / maxBrand) * 100}%` }} />
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No sales in this range.</p>
        )}
      </section>
    </div>
  );
}

function Search({ data }: { data: Analytics }) {
  const { search } = data;
  return (
    <>
      <div className="kpi-grid">
        <Tile label="Searches" value={search.searches.toLocaleString("en-AE")} />
        <Tile
          label="No-result rate"
          value={percent(search.zeroRateBps)}
          foot={`${search.zeroResults} searches found nothing`}
        />
        <Tile
          label="Terms not kept"
          value={search.notKept.toLocaleString("en-AE")}
          foot="Looked personal, so only counted"
        />
      </div>
      <div className="dashboard-split">
        <section className="management-card" aria-labelledby="an-zero">
          <h2 id="an-zero">Searches with no results</h2>
          <p className="muted small">What shoppers wanted and did not find.</p>
          <TermTable rows={search.zeroTerms.map((row) => [row.term, row.searches])} empty="None." />
        </section>
        <section className="management-card" aria-labelledby="an-terms">
          <h2 id="an-terms">Most searched terms</h2>
          <TermTable
            rows={search.terms.map((row) => [
              row.term + (row.zeroResults ? ` (${row.zeroResults} with no results)` : ""),
              row.searches,
            ])}
            empty="No searches in this range."
          />
        </section>
      </div>
      <section className="management-card" aria-labelledby="an-search-days">
        <h2 id="an-search-days">Searches per day</h2>
        <ColumnChart
          label="Searches per day"
          points={rangeDays(data.range.from, data.range.to).map((key) => {
            const day = search.days.find((item) => item.day === key);
            const missing = data.freshness.missing.includes(key);
            return {
              key,
              value: missing ? null : (day?.searches ?? 0),
              text: missing
                ? `${key}: not computed`
                : `${key}: ${day?.searches ?? 0} searches, ${day?.zeroResults ?? 0} with no results`,
            };
          })}
          format={(n) => n.toLocaleString("en-AE")}
        />
      </section>
    </>
  );
}

function TermTable({ rows, empty }: { rows: Array<[string, number]>; empty: string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <table className="order-table">
      <thead>
        <tr>
          <th>Term</th>
          <th>Searches</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([term, searches]) => (
          <tr key={term}>
            <td>“{term}”</td>
            <td>{searches}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Wishlist({ data }: { data: Analytics }) {
  const { wishlist } = data;
  const restock = wishlist.products.filter((product) => product.outOfStock && product.adds > 0);
  return (
    <>
      <p className="notice">
        Saved lists stay on shoppers’ devices. Only totals per product reach the admin, never who
        saved what; counts are device activity, not customers.
      </p>
      <div className="kpi-grid">
        <Tile label="Saves" value={wishlist.adds.toLocaleString("en-AE")} />
        <Tile label="Removals" value={wishlist.removes.toLocaleString("en-AE")} />
      </div>
      {restock.length > 0 && (
        <p className="notice">
          <b>Saved but out of stock:</b>{" "}
          {restock.map((product) => `${product.name} (${product.adds} saves)`).join(", ")}.
        </p>
      )}
      <section className="management-card" aria-labelledby="an-wish">
        <h2 id="an-wish">Most saved products</h2>
        {wishlist.products.length ? (
          <table className="order-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Saves</th>
                <th>Removals</th>
                <th>Stock</th>
              </tr>
            </thead>
            <tbody>
              {wishlist.products.map((product) => (
                <tr key={product.productId}>
                  <td>{product.name}</td>
                  <td>{product.adds}</td>
                  <td>{product.removes}</td>
                  <td>{product.outOfStock ? "Out of stock" : "In stock"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No saves in this range.</p>
        )}
      </section>
    </>
  );
}

/**
 * Single-series columns from a baseline, one slot per day of the range: one accent color, no
 * legend (the heading names it), the value of the focused or hovered column read out above the
 * plot. A day not computed (`null`) gets a short gray mark on the baseline, never a zero column.
 */
function ColumnChart(props: {
  label: string;
  points: Array<{ key: string; value: number | null; text: string }>;
  format: (value: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  if (props.points.every((point) => point.value === null))
    return <p className="muted">No computed days in this range.</p>;
  const max = Math.max(1, ...props.points.map((point) => point.value ?? 0));
  const width = 640;
  const height = 180;
  const slot = width / props.points.length;
  const bar = Math.max(2, Math.min(24, slot - 2));
  const current = active === null ? null : props.points[active];
  return (
    <figure className="column-chart">
      <figcaption className="muted small" aria-live="polite">
        {current
          ? current.text
          : `Highest: ${props.format(max)}. Hover or focus a day for its value; gray marks are days not computed.`}
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height + 1}`} role="img" aria-label={props.label}>
        <line x1="0" x2={width} y1={height + 0.5} y2={height + 0.5} className="chart-axis" />
        {props.points.map((point, index) => {
          const h = point.value ? Math.max(2, (point.value / max) * height) : 0;
          const x = index * slot + (slot - bar) / 2;
          const r = Math.min(4, bar / 2, h);
          return (
            <g
              key={point.key}
              tabIndex={0}
              role="img"
              aria-label={point.text}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            >
              <rect x={index * slot} y={0} width={slot} height={height} fill="transparent" />
              {point.value === null && (
                <rect className="chart-missing" x={x} y={height - 2} width={bar} height={2} />
              )}
              {h > 0 && (
                <path
                  className={active === index ? "chart-bar is-active" : "chart-bar"}
                  d={`M${x},${height} V${height - h + r} Q${x},${height - h} ${x + r},${height - h} H${x + bar - r} Q${x + bar},${height - h} ${x + bar},${height - h + r} V${height} Z`}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-range muted small">
        <span>{props.points[0]!.key}</span>
        <span>{props.points.at(-1)!.key}</span>
      </div>
    </figure>
  );
}
