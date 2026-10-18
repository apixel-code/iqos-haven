"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { storeProductResponseSchema, type StoreProductResponse } from "@ih/contracts";
import { applyRenames, removeFromList, useDeviceLists } from "@/lib/device/store";
import { Money } from "@/components/money";

type Loaded = { key: string; products: StoreProductResponse[]; missing: string[]; failed: boolean };

const lowestPrice = (product: StoreProductResponse) =>
  Math.min(...product.variants.map((variant) => variant.priceFils));
const spec = (product: StoreProductResponse, key: string) =>
  (product.specs as Record<string, unknown>)[key];

/** Rows of the comparison; `score` marks the best value in a row (higher is better). */
const ROWS: Array<{
  label: string;
  text: (product: StoreProductResponse) => ReactNode;
  score?: (product: StoreProductResponse) => number | null;
}> = [
  {
    label: "Price",
    text: (product) => (
      <>
        {product.variants.length > 1 &&
        new Set(product.variants.map((variant) => variant.priceFils)).size > 1
          ? "From "
          : ""}
        <Money fils={lowestPrice(product)} />
      </>
    ),
    score: (product) => -lowestPrice(product),
  },
  {
    label: "Battery",
    text: (product) =>
      typeof spec(product, "batteryMah") === "number" ? `${spec(product, "batteryMah")} mAh` : "—",
    score: (product) =>
      typeof spec(product, "batteryMah") === "number"
        ? (spec(product, "batteryMah") as number)
        : null,
  },
  {
    label: "Max output",
    text: (product) =>
      typeof spec(product, "maxOutputW") === "number" ? `${spec(product, "maxOutputW")}W` : "—",
    score: (product) =>
      typeof spec(product, "maxOutputW") === "number"
        ? (spec(product, "maxOutputW") as number)
        : null,
  },
  {
    label: "Pod capacity",
    text: (product) =>
      typeof spec(product, "podCapacityMl") === "string"
        ? `${spec(product, "podCapacityMl")} ml`
        : "—",
  },
  {
    label: "Coil",
    text: (product) =>
      typeof spec(product, "coilOhm") === "string" ? `${spec(product, "coilOhm")} Ω` : "—",
  },
  {
    label: "Charging",
    text: (product) =>
      typeof spec(product, "charging") === "string" ? String(spec(product, "charging")) : "—",
  },
  {
    label: "Display",
    text: (product) =>
      typeof spec(product, "display") === "string" ? String(spec(product, "display")) : "—",
  },
  { label: "Availability", text: (product) => (product.soldOut ? "Sold out" : "In stock") },
];

/** Compare kits (prototype): up to three kits side by side, with current data from the API. */
export function CompareView() {
  const compare = useDeviceLists().compare;
  const key = compare.join(",");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (!key) return;
    const slugs = key.split(",");
    let cancelled = false;
    Promise.all(
      slugs.map(async (slug) => {
        const response = await fetch(`/api/v1/store/products/${encodeURIComponent(slug)}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status === 404) return { slug, product: null };
        if (!response.ok) throw new Error("compare");
        const parsed = storeProductResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("contract");
        return { slug, product: parsed.data };
      }),
    )
      .then((results) => {
        if (cancelled) return;
        // Only kits are compared; anything else that slipped in is treated as missing. A kit
        // reached through two slugs (old and current) is one column.
        const seen = new Set<string>();
        const kits = results.flatMap((result) =>
          result.product?.type === "kit" && !seen.has(result.product.slug)
            ? [seen.add(result.product.slug) && result.product]
            : [],
        );
        setLoaded({
          key,
          failed: false,
          products: kits,
          missing: results
            .filter((result) => result.product?.type !== "kit")
            .map((result) => result.slug),
        });
        // After a rename the list keeps the current slug, so "Remove" and later reads match.
        applyRenames(
          new Map(
            results.flatMap((result) =>
              result.product ? [[result.slug, result.product.slug] as const] : [],
            ),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, failed: true, products: [], missing: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  const current = loaded?.key === key ? loaded : null;
  if (!mounted || (key && !current))
    return (
      <p role="status" className="py-9 text-sm text-ink-2">
        Loading your comparison…
      </p>
    );
  if (current?.failed)
    return (
      <p role="alert" className="py-9 text-sm text-ink-2">
        We couldn&apos;t load the comparison just now. Please try again in a moment.
      </p>
    );
  const products = current?.products ?? [];
  return (
    <div className="flex flex-col gap-6 pb-12">
      {current && current.missing.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md bg-accent-soft px-4 py-3 text-sm">
          <p>
            {current.missing.length} selected {current.missing.length === 1 ? "kit is" : "kits are"}{" "}
            no longer available.
          </p>
          <button
            type="button"
            onClick={() => current.missing.forEach((slug) => removeFromList("compare", slug))}
            className="w-fit font-medium underline underline-offset-2"
          >
            Remove from the comparison
          </button>
        </div>
      )}
      {products.length < 2 ? (
        <div className="flex flex-col items-center gap-3.5 rounded-lg border border-dashed border-line-2 bg-surface px-5 py-14 text-center">
          <h2 className="text-lg font-semibold">
            {products.length ? "Add one more kit" : "Choose kits to compare"}
          </h2>
          <p className="max-w-md text-sm text-ink-2">
            Compare is available for vape kits, where battery, output and pod size differ. Tick
            &ldquo;Compare with other kits&rdquo; on a kit&apos;s page.
          </p>
          <Link
            href="/vape-kits"
            prefetch={false}
            className="inline-flex h-10 items-center rounded-pill bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Browse vape kits
          </Link>
        </div>
      ) : null}
      {products.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className="w-32 text-left">
                  <span className="sr-only">Specification</span>
                </th>
                {products.map((product) => (
                  <th
                    key={product.slug}
                    scope="col"
                    className="p-3 text-left align-top font-normal"
                  >
                    <span className="block text-[11px] uppercase tracking-[0.1em] text-ink-3">
                      {product.brand.name}
                    </span>
                    <Link
                      href={`/p/${product.slug}`}
                      prefetch={false}
                      className="font-medium hover:underline"
                    >
                      {product.name}
                    </Link>
                    <button
                      type="button"
                      aria-label={`Remove ${product.name} from the comparison`}
                      onClick={() => removeFromList("compare", product.slug)}
                      className="mt-1 block text-xs text-ink-2 underline underline-offset-2"
                    >
                      Remove
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const scores = row.score ? products.map(row.score) : [];
                const numbers = scores.filter((value): value is number => value !== null);
                // Highlight only a single clear best among at least two known values.
                const best =
                  numbers.length >= 2 && new Set(numbers).size > 1 ? Math.max(...numbers) : null;
                return (
                  <tr key={row.label} className="border-t border-line">
                    <th scope="row" className="py-2.5 pr-3 text-left font-normal text-ink-2">
                      {row.label}
                    </th>
                    {products.map((product, index) => (
                      <td
                        key={product.slug}
                        className={`p-3 ${best !== null && scores[index] === best ? "bg-accent-soft font-semibold" : ""}`}
                      >
                        {row.text(product)}
                        {best !== null && scores[index] === best && (
                          <span className="sr-only"> (best)</span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
