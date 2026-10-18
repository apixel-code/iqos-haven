"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  storeProductResponseSchema,
  storeProductsResponseSchema,
  type StoreProductCard,
  type StoreProductResponse,
} from "@ih/contracts";
import { LIST_LIMITS } from "@/lib/device/lists";
import {
  applyRenames,
  removeFromList,
  toggleCompareProduct,
  useDeviceLists,
} from "@/lib/device/store";
import { toast } from "@/lib/ui/toast";
import { ProductCard } from "./product-card";
import { QuickAdd } from "./quick-add";
import { Icon } from "@/components/icons";
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
      <p role="status" className="small muted list-wait">
        Loading your comparison…
      </p>
    );
  if (current?.failed)
    return (
      <p role="alert" className="muted list-wait">
        We couldn&apos;t load the comparison just now. Please try again in a moment.
      </p>
    );
  const products = current?.products ?? [];
  return (
    <div className="list-page">
      {current && current.missing.length > 0 && (
        <div className="notice">
          <p>
            {current.missing.length} selected {current.missing.length === 1 ? "kit is" : "kits are"}{" "}
            no longer available.
          </p>
          <button
            type="button"
            className="link"
            onClick={() => current.missing.forEach((slug) => removeFromList("compare", slug))}
          >
            Remove from the comparison
          </button>
        </div>
      )}
      {products.length >= 2 ? (
        // The prototype's comparison table: best value in a row highlighted.
        <div className="cmp-wrap">
          <table className="cmp">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr">Specification</span>
                </th>
                {products.map((product) => (
                  <th key={product.slug} scope="col" className="ch-col">
                    <div className="ch">
                      <span className="th">
                        {product.images[0] && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={product.images[0].urls.thumb} alt="" width={150} height={150} />
                        )}
                      </span>
                      <span className="eyebrow">{product.brand.name}</span>
                      <Link href={`/p/${product.slug}`} prefetch={false} className="link">
                        {product.name}
                      </Link>
                      <button
                        type="button"
                        className="rm small muted"
                        aria-label={`Remove ${product.name} from the comparison`}
                        onClick={() => removeFromList("compare", product.slug)}
                      >
                        Remove
                      </button>
                    </div>
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
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {products.map((product, index) => {
                      const top = best !== null && scores[index] === best;
                      return (
                        <td key={product.slug} className={top ? "best" : undefined}>
                          {row.text(product)}
                          {top && <span className="sr"> (best)</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr>
                <th scope="row">
                  <span className="sr">Add to cart</span>
                </th>
                {products.map((product) => (
                  <td key={product.slug} className="cmp-add">
                    {product.soldOut ? (
                      <span className="badge badge-oos">Sold out</span>
                    ) : (
                      <QuickAdd slug={product.slug} name={product.name} variant="button" />
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <span className="ic">
            <Icon name="compare" size="lg" />
          </span>
          <h2 className="h3">{products.length ? "Add one more kit" : "Choose kits to compare"}</h2>
          <p>
            Compare is available for vape kits, where battery, output and pod size differ.
            Disposables are compared by puff count in the shop filters instead.
          </p>
        </div>
      )}
      {products.length < 3 && <AddKits exclude={compare} />}
    </div>
  );
}

/** The prototype's "Add a kit": kits not yet compared, each with "Add to compare". */
function AddKits({ exclude }: { exclude: readonly string[] }) {
  const [kits, setKits] = useState<StoreProductCard[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/store/products?type=kit&limit=12", {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("kits"))))
      .then((body: unknown) => {
        const parsed = storeProductsResponseSchema.safeParse(body);
        setKits(parsed.success ? parsed.data.items : []);
      })
      // Optional: without it the page still compares.
      .catch(() => {
        if (!controller.signal.aborted) setKits([]);
      });
    return () => controller.abort();
  }, []);
  const offered = (kits ?? []).filter((kit) => !exclude.includes(kit.slug)).slice(0, 4);
  if (offered.length === 0) return null;
  return (
    <section aria-labelledby="add-kit-h" className="add-kits">
      <h2 className="h3" id="add-kit-h">
        Add a kit
      </h2>
      <ul className="pgrid">
        {offered.map((kit) => (
          <li key={kit.slug} className="add-kit">
            <ProductCard product={kit} />
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                const result = toggleCompareProduct(kit.slug);
                if (result.full)
                  toast({
                    title: `Compare holds up to ${LIST_LIMITS.compare} kits`,
                    sub: "Remove one to add another",
                  });
              }}
            >
              <Icon name="plus" size="sm" /> Add to compare
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
