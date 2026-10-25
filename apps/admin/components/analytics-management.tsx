"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { analyticsSchema, ORDER_STATUSES_FOR_MIX, type Analytics } from "@ih/contracts";
import { ordersHref } from "../lib/links";
import { money, ORDER_STATUS_LABELS } from "../lib/orders";
import { analyticsRange, changeBps, percent, rangeDays } from "../lib/analytics";
import { Icon, type IconName } from "./icons";
import { PageHead } from "./page-head";

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

const STATUS_CSS: Record<(typeof ORDER_STATUSES_FOR_MIX)[number], string> = {
  pending: "pending",
  confirmed: "confirmed",
  processing: "processing",
  out_for_delivery: "ofd",
  delivered: "delivered",
  cancelled: "cancelled",
};
const count = (n: number) => n.toLocaleString("en-AE");

/**
 * The Owner's analytics (roadmap step 109, ADR 0075) in the prototype's layout
 * (`VIEWS.analytics`, ADR 0097 V-A10). Every figure comes from `GET /v1/admin/analytics`; days
 * not computed are named, never drawn as zero, and there are no sample values. Charts are
 * single-series with every value also in a table or list.
 */
export function AnalyticsManagement() {
  const [range, setRange] = useState(() => analyticsRange(30, new Date()));
  const [tab, setTab] = useState<Tab>("overview");
  const [custom, setCustom] = useState(false);
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
    <>
      <PageHead
        title="Analytics"
        sub={`${range.from} to ${range.to} · Asia/Dubai`}
        actions={
          <>
            <div className="seg" role="group" aria-label="Date range">
              {PRESETS.map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-pressed={range.preset === days}
                  onClick={() => {
                    setCustom(false);
                    choose(analyticsRange(days, new Date()));
                  }}
                >
                  Last {days} days
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-s"
              aria-expanded={custom}
              aria-pressed={range.preset === null}
              onClick={() => setCustom((open) => !open)}
            >
              <Icon name="cal" />
              Custom
            </button>
          </>
        }
      />
      {custom && (
        <form
          className="card pad an-custom"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const from = String(form.get("from"));
            const to = String(form.get("to"));
            if (from && to && from <= to) choose({ from, to, preset: null });
          }}
        >
          <div className="field">
            <label className="label" htmlFor="an-from">
              From
            </label>
            <input
              id="an-from"
              className="input"
              type="date"
              name="from"
              defaultValue={range.from}
              key={"f" + range.from}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="an-to">
              To
            </label>
            <input
              id="an-to"
              className="input"
              type="date"
              name="to"
              defaultValue={range.to}
              key={"t" + range.to}
            />
          </div>
          <button className="btn btn-p" type="submit">
            Apply
          </button>
        </form>
      )}
      <div className="tabs" role="tablist" aria-label="Analytics">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {load.state === "loading" && (
        <p className="small muted" role="status">
          Loading analytics…
        </p>
      )}
      {load.state === "failed" && (
        <div className="note err" role="alert">
          <Icon name="alert" />
          <p>
            {load.status === 403
              ? "Analytics are for the Owner."
              : load.status === 400
                ? "Choose a range of real dates, at most a year long."
                : "Analytics could not be loaded."}
          </p>
          <button className="btn btn-s btn-sm" type="button" onClick={refresh}>
            <Icon name="refresh" size="sm" />
            Try again
          </button>
        </div>
      )}
      {load.state === "ready" && <AnalyticsBody data={load.data} tab={tab} onTab={setTab} />}
    </>
  );
}

function AnalyticsBody({
  data,
  tab,
  onTab,
}: {
  data: Analytics;
  tab: Tab;
  onTab: (tab: Tab) => void;
}) {
  const { freshness } = data;
  return (
    <>
      {freshness.missing.length > 0 && (
        <div className="note warn">
          <Icon name="info" />
          <p>
            {freshness.missing.length} of {data.range.days} days are not computed yet and are left
            out (first: {freshness.missing[0]}). Run the backfill for older days.
          </p>
        </div>
      )}
      {tab === "overview" && <Overview data={data} onTab={onTab} />}
      {tab === "sales" && <Sales data={data} />}
      {tab === "products" && <Products data={data} />}
      {tab === "search" && <Search data={data} />}
      {tab === "wishlist" && <Wishlist data={data} />}
      <p className="help">
        {data.range.from} to {data.range.to} (Asia/Dubai), {data.currency}. {data.taxNote}{" "}
        {freshness.newestComputedAt
          ? `Figures computed up to ${dubaiTime(freshness.newestComputedAt)}.`
          : ""}
      </p>
    </>
  );
}

/** The prototype's KPI tile (`kpiTile`): label, value and the line under it. */
function Tile(props: { label: string; value: string; foot?: ReactNode }) {
  return (
    <div className="kpi">
      <span className="kpi-l">{props.label}</span>
      <span className="kpi-v">{props.value}</span>
      {props.foot && <span className="kpi-f">{props.foot}</span>}
    </div>
  );
}

/** The prototype's change against the previous period (`deltaHtml`), in integer basis points. */
function Delta({
  data,
  now,
  before,
  lowerIsBetter = false,
}: {
  data: Analytics;
  now: number | null;
  before: number | null;
  lowerIsBetter?: boolean;
}) {
  if (data.previous.missingDays === data.range.days)
    return <span className="delta-c">No earlier figures</span>;
  const bps = changeBps(now, before);
  if (bps === null) return <span className="delta-c">Nothing to compare with</span>;
  const flat = Math.abs(bps) < 50;
  const good = lowerIsBetter ? bps < 0 : bps > 0;
  return (
    <>
      <span className={`delta ${flat ? "flat" : good ? "up" : "down"}`}>
        {!flat && <Icon name={bps > 0 ? "up" : "down"} />}
        {flat ? "No change" : `${bps > 0 ? "+" : "−"}${percent(Math.abs(bps))}`}
      </span>
      <span className="delta-c">vs previous period</span>
    </>
  );
}

function CardHead({
  id,
  title,
  sub,
  action,
}: {
  id: string;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card-h">
      <div>
        <h2 id={id}>{title}</h2>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

function Empty({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="empty dash-empty">
      <div className="ic">
        <Icon name={icon} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function DailyChart({ data }: { data: Analytics }) {
  return (
    <section className="card" aria-labelledby="an-daily">
      <CardHead
        id="an-daily"
        title="Booked sales per day"
        sub="Orders placed and not cancelled, by order date"
      />
      <div className="card-b">
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
      </div>
    </section>
  );
}

function Overview({ data, onTab }: { data: Analytics; onTab: (tab: Tab) => void }) {
  const { totals, previous } = data;
  const placedTotal = ORDER_STATUSES_FOR_MIX.reduce((sum, key) => sum + data.statusMix[key], 0);
  const top = data.products.slice(0, 6);
  const topMax = Math.max(1, ...top.map((product) => product.deliveredNetFils));
  const more = (target: Tab, label: string) => (
    <button type="button" className="btn btn-g btn-sm" onClick={() => onTab(target)}>
      {label}
      <Icon name="arr-r" size="sm" />
    </button>
  );
  return (
    <>
      <div className="kpis an-kpis">
        <Tile
          label="Booked sales"
          value={money(totals.booked.totalFils)}
          foot={
            <Delta data={data} now={totals.booked.totalFils} before={previous.bookedTotalFils} />
          }
        />
        <Tile
          label="Booked orders"
          value={count(totals.booked.orders)}
          foot={<Delta data={data} now={totals.booked.orders} before={previous.bookedOrders} />}
        />
        <Tile
          label="Average order value"
          value={totals.booked.aovFils === null ? "—" : money(totals.booked.aovFils)}
          foot={<Delta data={data} now={totals.booked.aovFils} before={previous.aovFils} />}
        />
        <Tile
          label="Cancellation rate"
          value={percent(totals.cancelled.rateBps)}
          foot={
            <span className="delta-c">
              {totals.cancelled.orders} of {totals.placed} placed
            </span>
          }
        />
        <Tile
          label="Delivered sales"
          value={money(totals.delivered.totalFils)}
          foot={<span className="delta-c">{totals.delivered.orders} orders, by delivery date</span>}
        />
        <Tile
          label="Cash collected"
          value={money(totals.collected.amountFils)}
          foot={
            <span className="delta-c">{totals.collected.orders} orders, by collection date</span>
          }
        />
      </div>
      <DailyChart data={data} />
      <div className="grid g2">
        <section className="card" aria-labelledby="an-status">
          <CardHead
            id="an-status"
            title="Order status distribution"
            sub={`${placedTotal} orders placed in the range, by their status today`}
          />
          <div className="card-b">
            {placedTotal ? (
              <>
                <div className="sbar" role="img" aria-label="Order status distribution">
                  {ORDER_STATUSES_FOR_MIX.filter((key) => data.statusMix[key]).map((key) => (
                    <i
                      key={key}
                      style={{
                        width: `${(data.statusMix[key] / placedTotal) * 100}%`,
                        background: `var(--st-${STATUS_CSS[key]})`,
                      }}
                    />
                  ))}
                </div>
                <div className="sleg">
                  {ORDER_STATUSES_FOR_MIX.map((key) => (
                    <Link key={key} href={ordersHref({ status: key })}>
                      <span
                        className="dotc"
                        style={{ background: `var(--st-${STATUS_CSS[key]})` }}
                      />
                      <span>{ORDER_STATUS_LABELS[key]}</span>
                      <b>{data.statusMix[key]}</b>
                    </Link>
                  ))}
                </div>
              </>
            ) : (
              <Empty icon="orders" title="No orders" text="No orders were placed in this range." />
            )}
          </div>
        </section>
        <section className="card" aria-labelledby="an-top">
          <CardHead id="an-top" title="Top products" action={more("products", "Details")} />
          <div className="card-b">
            {top.length ? (
              <div className="rank">
                {top.map((product, index) => (
                  <div className="rank-i" key={product.productId}>
                    <span className="n">{index + 1}</span>
                    <span className="t">{product.name}</span>
                    <span className="v">{money(product.deliveredNetFils)}</span>
                    <span className="b">
                      <i style={{ width: `${(product.deliveredNetFils / topMax) * 100}%` }} />
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon="chart" title="No sales" text="Try a longer range." />
            )}
          </div>
        </section>
        <section className="card" aria-labelledby="an-zero-o">
          <CardHead
            id="an-zero-o"
            title="Searches with no results"
            action={more("search", "Search analytics")}
          />
          <TermList
            rows={data.search.zeroTerms.slice(0, 4).map((row) => [row.term, row.searches])}
            unit="searches"
            empty="None in this range."
          />
        </section>
        <section className="card" aria-labelledby="an-wish-o">
          <CardHead id="an-wish-o" title="Most wishlisted" action={more("wishlist", "Wishlist")} />
          {data.wishlist.products.length ? (
            <div className="list an-list">
              {data.wishlist.products.slice(0, 4).map((product) => (
                <div className="li" key={product.productId}>
                  <span className="li-b">
                    <b>{product.name}</b>
                    <small className={product.outOfStock ? "warn-t" : undefined}>
                      {product.outOfStock ? "Out of stock" : "In stock"}
                    </small>
                  </span>
                  <span className="li-r">
                    <b>{product.adds}</b>
                    <small className="muted">saves</small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="card-b">
              <p className="small muted">No saves in this range.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function Sales({ data }: { data: Analytics }) {
  const { totals, previous } = data;
  return (
    <>
      <div className="kpis">
        <Tile
          label="Booked sales"
          value={money(totals.booked.totalFils)}
          foot={
            <Delta data={data} now={totals.booked.totalFils} before={previous.bookedTotalFils} />
          }
        />
        <Tile
          label="Booked orders"
          value={count(totals.booked.orders)}
          foot={<Delta data={data} now={totals.booked.orders} before={previous.bookedOrders} />}
        />
        <Tile
          label="Average order value"
          value={totals.booked.aovFils === null ? "—" : money(totals.booked.aovFils)}
          foot={<Delta data={data} now={totals.booked.aovFils} before={previous.aovFils} />}
        />
        <Tile
          label="Cancelled orders"
          value={count(totals.cancelled.orders)}
          foot={<span className="delta-c">of {totals.placed} placed</span>}
        />
      </div>
      <DailyChart data={data} />
      <section className="tbl-wrap" aria-labelledby="an-sales">
        <div className="card-h an-tbl-h">
          <div>
            <h2 id="an-sales">Per day</h2>
            <p className="sub">
              Booked by order date, delivered by delivery date, cash by collection date: three
              different days for the same order.
            </p>
          </div>
        </div>
        {data.days.length ? (
          <div className="tbl-scroll an-tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Placed</th>
                  <th className="num">Cancelled</th>
                  <th className="num">Booked</th>
                  <th className="num">Booked sales</th>
                  <th className="num">Delivered</th>
                  <th className="num">Delivered sales</th>
                  <th className="num">Cash collected</th>
                </tr>
              </thead>
              <tbody>
                {[...data.days].reverse().map((day) => (
                  <tr key={day.day}>
                    <td className="mono small">{day.day}</td>
                    <td className="num">{day.placed}</td>
                    <td className="num">{day.cancelled}</td>
                    <td className="num">{day.bookedOrders}</td>
                    <td className="num">{money(day.bookedTotalFils)}</td>
                    <td className="num">{day.deliveredOrders}</td>
                    <td className="num">{money(day.deliveredTotalFils)}</td>
                    <td className="num">{money(day.collectedFils)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card-b">
            <p className="small muted">No computed days in this range.</p>
          </div>
        )}
      </section>
    </>
  );
}

function Products({ data }: { data: Analytics }) {
  const maxBrand = Math.max(1, ...data.brands.map((brand) => brand.deliveredNetFils));
  return (
    <div className="grid g2 an-split">
      <section className="tbl-wrap" aria-labelledby="an-products">
        <div className="card-h an-tbl-h">
          <div>
            <h2 id="an-products">Best-selling products</h2>
            <p className="sub">
              By delivered sales (merchandise after discounts, by delivery date); ordered units are
              orders placed in the range and not cancelled.
            </p>
          </div>
        </div>
        {data.products.length ? (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Ordered</th>
                  <th className="num">Delivered</th>
                  <th className="num">Delivered sales</th>
                  <th className="num">Share</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((product) => (
                  <tr key={product.productId}>
                    <td>
                      <b className="cust">{product.name}</b>
                    </td>
                    <td className="num">{product.orderedUnits}</td>
                    <td className="num">{product.deliveredUnits}</td>
                    <td className="num">{money(product.deliveredNetFils)}</td>
                    <td className="num">{percent(product.shareBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card-b">
            <p className="small muted">No sales in this range.</p>
          </div>
        )}
      </section>
      <section className="card" aria-labelledby="an-brands">
        <CardHead
          id="an-brands"
          title="Best-selling brands"
          sub="The brand each sale was made under, even if renamed since"
        />
        <div className="card-b">
          {data.brands.length ? (
            <div className="rank">
              {data.brands.map((brand, index) => (
                <div className="rank-i" key={brand.brandName}>
                  <span className="n">{index + 1}</span>
                  <span className="t">
                    {brand.brandName}{" "}
                    <span className="muted small">· {brand.deliveredUnits} delivered units</span>
                  </span>
                  <span className="v">{money(brand.deliveredNetFils)}</span>
                  <span className="b">
                    <i style={{ width: `${(brand.deliveredNetFils / maxBrand) * 100}%` }} />
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="small muted">No sales in this range.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Search({ data }: { data: Analytics }) {
  const { search } = data;
  return (
    <>
      <div className="kpis">
        <Tile label="Searches" value={count(search.searches)} />
        <Tile
          label="No-result rate"
          value={percent(search.zeroRateBps)}
          foot={<span className="delta-c">{search.zeroResults} searches found nothing</span>}
        />
        <Tile
          label="Terms not kept"
          value={count(search.notKept)}
          foot={<span className="delta-c">Looked personal, so only counted</span>}
        />
      </div>
      <div className="grid g2">
        <section className="card" aria-labelledby="an-zero">
          <CardHead
            id="an-zero"
            title="Searches with no results"
            sub="What shoppers wanted and did not find"
          />
          <TermList
            rows={search.zeroTerms.map((row) => [row.term, row.searches])}
            unit="searches"
            empty="None."
          />
        </section>
        <section className="card" aria-labelledby="an-terms">
          <CardHead id="an-terms" title="Most searched terms" />
          <TermList
            rows={search.terms.map((row) => [
              row.term,
              row.searches,
              row.zeroResults ? `${row.zeroResults} with no results` : undefined,
            ])}
            unit="searches"
            empty="No searches in this range."
          />
        </section>
      </div>
      <section className="card" aria-labelledby="an-search-days">
        <CardHead id="an-search-days" title="Searches per day" />
        <div className="card-b">
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
            format={count}
          />
        </div>
      </section>
    </>
  );
}

/** The prototype's term list (`li` rows with the count on the right). */
function TermList({
  rows,
  unit,
  empty,
}: {
  rows: Array<[string, number, string?]>;
  unit: string;
  empty: string;
}) {
  if (!rows.length)
    return (
      <div className="card-b">
        <p className="small muted">{empty}</p>
      </div>
    );
  return (
    <div className="list an-list">
      {rows.map(([term, searches, note]) => (
        <div className="li" key={term}>
          <span className="li-b">
            <b>“{term}”</b>
            {note && <small className="muted">{note}</small>}
          </span>
          <span className="li-r">
            <b>{count(searches)}</b>
            <small className="muted">{unit}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function Wishlist({ data }: { data: Analytics }) {
  const { wishlist } = data;
  const restock = wishlist.products.filter((product) => product.outOfStock && product.adds > 0);
  return (
    <>
      <div className="note">
        <Icon name="info" />
        <p>
          Saved lists stay on shoppers’ devices. Only totals per product reach the admin, never who
          saved what; counts are device activity, not customers.
        </p>
      </div>
      <div className="kpis">
        <Tile label="Saves" value={count(wishlist.adds)} />
        <Tile label="Removals" value={count(wishlist.removes)} />
      </div>
      {restock.length > 0 && (
        <div className="note warn">
          <Icon name="alert" />
          <p>
            <b>Saved but out of stock:</b>{" "}
            {restock.map((product) => `${product.name} (${product.adds} saves)`).join(", ")}.
          </p>
        </div>
      )}
      <section className="tbl-wrap" aria-labelledby="an-wish">
        <div className="card-h an-tbl-h">
          <h2 id="an-wish">Most saved products</h2>
        </div>
        {wishlist.products.length ? (
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Saves</th>
                  <th className="num">Removals</th>
                  <th>Stock</th>
                </tr>
              </thead>
              <tbody>
                {wishlist.products.map((product) => (
                  <tr key={product.productId}>
                    <td>
                      <b className="cust">{product.name}</b>
                    </td>
                    <td className="num">{product.adds}</td>
                    <td className="num">{product.removes}</td>
                    <td>
                      {product.outOfStock ? (
                        <span className="tag out">Out of stock</span>
                      ) : (
                        <span className="tag ok">In stock</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card-b">
            <p className="small muted">No saves in this range.</p>
          </div>
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
  const width = 960;
  const height = 200;
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
      <svg
        viewBox={`0 0 ${width} ${height + 1}`}
        // Fills the height the stylesheet gives it at every width; the axis keeps 1px.
        preserveAspectRatio="none"
        role="img"
        aria-label={props.label}
      >
        <line
          x1="0"
          x2={width}
          y1={height + 0.5}
          y2={height + 0.5}
          className="chart-axis"
          vectorEffect="non-scaling-stroke"
        />
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
