"use client";

import { useState } from "react";
import { Icon } from "@/components/icons";
import { LIST_LIMITS } from "@/lib/device/lists";
import { toggleSavedProduct, useDeviceLists } from "@/lib/device/store";

/**
 * Heart button: saves a product on this device (prototype wishlist). `variant="card"` is the
 * round button over a card image; `variant="page"` is the labelled button on the product page.
 */
export function SaveButton({
  slug,
  name,
  variant = "card",
}: {
  slug: string;
  name: string;
  variant?: "card" | "page";
}) {
  const saved = useDeviceLists().saved.includes(slug);
  const [full, setFull] = useState(false);
  const heart = (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
      <path
        d="M12 20.5s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7.6a4.5 4.5 0 0 1 7.5 2.9c0 5.4-7.5 10-7.5 10Z"
        fill={saved ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
  const press = () => setFull(toggleSavedProduct(slug).full);
  if (variant === "card")
    return (
      // The prototype's card heart (`wish`); a saved item fills it.
      <button
        type="button"
        className="wish"
        aria-pressed={saved}
        aria-label={saved ? `Remove ${name} from saved items` : `Save ${name}`}
        title={full ? `You can save up to ${LIST_LIMITS.saved} items` : undefined}
        onClick={press}
      >
        <Icon name="heart" />
      </button>
    );
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-pressed={saved}
        onClick={press}
        className={`inline-flex h-10 w-fit items-center gap-2 rounded-pill border border-line-2 bg-surface px-4 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
          saved ? "text-coral" : "text-ink"
        }`}
      >
        {heart}
        {saved ? "Saved" : "Save to saved items"}
      </button>
      <p role="status" aria-live="polite" className="text-xs text-error">
        {full ? `You can save up to ${LIST_LIMITS.saved} items. Remove one to save another.` : ""}
      </p>
    </div>
  );
}
