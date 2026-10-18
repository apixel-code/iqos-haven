"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { storeProductResponseSchema, type StoreProductResponse } from "@ih/contracts";
import { BuyBox } from "./buy-box";
import { Icon } from "@/components/icons";

/**
 * "Add" on a product card. It loads the product (the API checks the age ticket again) and opens
 * the same option chooser as the product page, so a variant is only ever added by an explicit
 * choice. If the product cannot be loaded here, the shopper is taken to its page instead.
 */
export function QuickAdd({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [product, setProduct] = useState<StoreProductResponse | null>(null);
  const [loading, setLoading] = useState(false);

  async function open() {
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
      dialog.current?.showModal();
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
        onClick={() => void open()}
        // The prototype's card button (`qadd`): a plus, and "Add" on wide screens.
        className="qadd"
      >
        <Icon name="plus" size="sm" />
        <span>{loading ? "…" : "Add"}</span>
      </button>
      <dialog
        ref={dialog}
        aria-label="Quick add"
        onClose={() => setProduct(null)}
        className="m-auto w-[min(92vw,28rem)] rounded-lg bg-surface p-5 text-ink shadow-3 backdrop:bg-ink/40"
      >
        {product && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.1em] text-ink-3">
                  {product.brand.name}
                </p>
                <h2 className="text-lg font-semibold">{product.name}</h2>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => dialog.current?.close()}
                className="size-10 rounded-pill text-xl hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
              >
                ×
              </button>
            </div>
            <BuyBox product={product} compact onAdded={() => dialog.current?.close()} />
            <a href={`/p/${product.slug}`} className="text-sm underline underline-offset-2">
              View full details
            </a>
          </div>
        )}
      </dialog>
    </>
  );
}
