"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { storeProductResponseSchema, type StoreProductResponse } from "@ih/contracts";
import { BuyBox } from "./buy-box";
import { Sheet } from "./sheet";
import { Icon } from "@/components/icons";

/**
 * "Add" on a product card. It loads the product (the API checks the age ticket again) and opens
 * the same option chooser as the product page, so a variant is only ever added by an explicit
 * choice. If the product cannot be loaded here, the shopper is taken to its page instead.
 */
export function QuickAdd({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [product, setProduct] = useState<StoreProductResponse | null>(null);
  const [loading, setLoading] = useState(false);

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
      setProduct(parsed.data);
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
        className="qadd"
      >
        <Icon name="plus" size="sm" />
        <span>{loading ? "…" : "Add"}</span>
      </button>
      {/* The prototype's `quickSheet`: a bottom sheet on a phone, a centred one from 720 px. */}
      <Sheet open={open} onClose={() => setOpen(false)} title="Quick add" side="bottom">
        {product && (
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
            <BuyBox key={product.slug} product={product} compact onAdded={() => setOpen(false)} />
            <Link href={`/p/${product.slug}`} prefetch={false} className="link small q-more">
              View full details
            </Link>
          </div>
        )}
      </Sheet>
    </>
  );
}
