"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { storeProductResponseSchema, type StoreProductResponse } from "@ih/contracts";
import { addVariant, BuyBox, type AddedItem } from "./buy-box";
import { Sheet } from "./sheet";
import { Icon } from "@/components/icons";
import { impliedChoices, offeredOptions, resolveSelection } from "@/lib/store/selection";
import { toast } from "@/lib/ui/toast";

/**
 * "Add" on a product card. It loads the product (the API checks the age ticket again). When there
 * is nothing to choose (one option on offer, in stock), it is added at once with the usual toast
 * (ADR 0105, client feedback 2026-11-03). Otherwise it opens the product page's option chooser,
 * so a variant is only ever added by an explicit choice, and after adding, the same sheet shows
 * "Added" with Checkout: no second popup. If the product cannot be loaded here, the shopper is
 * taken to its page instead.
 */
export function QuickAdd({
  slug,
  name,
  variant = "card",
}: {
  slug: string;
  name: string;
  /** `card`: the card's round plus; `button`: a small "Add to cart" button (compare table). */
  variant?: "card" | "button";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [product, setProduct] = useState<StoreProductResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<AddedItem | null>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/store/products/${encodeURIComponent(slug)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const parsed = storeProductResponseSchema.safeParse(
        response.ok ? await response.json() : null,
      );
      if (!parsed.success) throw new Error("unavailable");
      const loaded = parsed.data;
      const only = resolveSelection(loaded, impliedChoices(offeredOptions(loaded)));
      if (only.status === "ready") {
        const { result, item } = addVariant(loaded, only.variant, 1);
        if (!result.full) {
          toast({ ...item, action: { label: "Checkout", run: () => router.push("/checkout") } });
          return;
        }
      }
      setProduct(loaded);
      setAdded(null);
      setOpen(true);
    } catch {
      router.push(`/p/${slug}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={`Quick add ${name}`}
        aria-busy={loading || undefined}
        disabled={loading}
        onClick={() => void load()}
        // The prototype's card button (`qadd`): a plus, and "Add" on wide screens.
        className={variant === "card" ? "qadd" : "btn btn-primary btn-sm"}
      >
        {variant === "card" ? (
          <>
            <Icon name="plus" size="sm" />
            <span>{loading ? "…" : "Add"}</span>
          </>
        ) : loading ? (
          "Loading…"
        ) : (
          "Add to cart"
        )}
      </button>
      {/* The prototype's `quickSheet`: a bottom sheet on a phone, a centred one from 720 px. */}
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={added ? "Added to cart" : "Quick add"}
        side="bottom"
      >
        {product && added && (
          <div className="q-body q-added" role="status">
            <div className="q-head">
              <span className="q-thumb">
                {added.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={added.image} alt="" width={72} height={84} />
                )}
              </span>
              <div>
                <span className="q-ok">
                  <Icon name="check" size="sm" /> In your cart
                </span>
                <h3 className="h3">{added.sub}</h3>
              </div>
            </div>
            <div className="q-next">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => {
                  setOpen(false);
                  router.push("/checkout");
                }}
              >
                Checkout
              </button>
              <button type="button" className="btn btn-lg" onClick={() => setOpen(false)}>
                Continue shopping
              </button>
            </div>
          </div>
        )}
        {product && !added && (
          <div className="q-body">
            <div className="q-head">
              <span className="q-thumb">
                {product.images[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={product.images[0].urls.thumb} alt="" width={72} height={84} />
                )}
              </span>
              <div>
                <span className="eyebrow">{product.brand.name}</span>
                <h3 className="h3">{product.name}</h3>
              </div>
            </div>
            {/* Keyed by product so choices never carry over to another product. */}
            <BuyBox key={product.slug} product={product} compact onAdded={setAdded} />
            <Link href={`/p/${product.slug}`} prefetch={false} className="link small q-more">
              View full details
            </Link>
          </div>
        )}
      </Sheet>
    </>
  );
}
