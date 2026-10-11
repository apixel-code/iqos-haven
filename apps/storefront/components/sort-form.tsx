"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { STORE_PRODUCT_SORTS, type StoreProductSort } from "@ih/contracts";
import { listingHref, parseListing, SORT_LABELS, type ProductType } from "@/lib/store/listing";

/**
 * Listing controls as a plain GET form: it works without JavaScript (the Apply button). With
 * JavaScript a change navigates at once and shows "Updating…" until the new list arrives.
 * Changing a control restarts at the first page.
 */
export function ListingControls({
  action,
  sort,
  type,
  brand,
  brands,
  showType,
}: {
  action: string;
  sort: StoreProductSort;
  type?: ProductType;
  brand?: string;
  /** Brand choices; omit on pages that are already about one brand. */
  brands?: ReadonlyArray<{ slug: string; name: string }>;
  showType: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /** Navigates to the list the form describes; only known controls reach the address bar. */
  const apply = (form: HTMLFormElement) => {
    const values = Object.fromEntries(
      [...new FormData(form)].map(([key, value]) => [key, String(value)]),
    );
    const next = parseListing(values);
    startTransition(() => router.push(listingHref(action, { ...next, cursor: undefined })));
  };
  const select =
    "h-10 max-w-full rounded-pill border-[1.5px] border-line bg-surface px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return (
    <form
      method="get"
      action={action}
      className="flex flex-wrap items-end gap-3"
      aria-busy={pending || undefined}
      onChange={(event) => apply(event.currentTarget)}
      onSubmit={(event) => {
        event.preventDefault();
        apply(event.currentTarget);
      }}
    >
      {showType && (
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          Type
          <select name="type" defaultValue={type ?? ""} className={select}>
            <option value="">All types</option>
            <option value="disposable">Disposable vapes</option>
            <option value="kit">Vape kits & devices</option>
          </select>
        </label>
      )}
      {brands && (
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          Brand
          <select name="brand" defaultValue={brand ?? ""} className={select}>
            <option value="">All brands</option>
            {brands.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-ink-2">
        Sort by
        <select name="sort" defaultValue={sort} className={select}>
          {STORE_PRODUCT_SORTS.map((value) => (
            <option key={value} value={value}>
              {SORT_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="h-10 rounded-pill border border-line-2 bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Apply
      </button>
      <span role="status" aria-live="polite" className="pb-2.5 text-sm text-ink-2">
        {pending ? "Updating…" : ""}
      </span>
    </form>
  );
}
