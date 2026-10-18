"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/icons";
import { LIST_LIMITS } from "@/lib/device/lists";
import { toggleSavedProduct, useDeviceLists } from "@/lib/device/store";
import { toast } from "@/lib/ui/toast";

/**
 * Heart button: saves a product on this device (prototype wishlist). `variant="card"` is the
 * round button over a card image; `variant="page"` is the big heart beside Add to cart on the product page.
 */
export function SaveButton({
  slug,
  name,
  variant = "card",
  image = null,
}: {
  slug: string;
  name: string;
  variant?: "card" | "page";
  /** Thumbnail for the "Saved" toast. */
  image?: string | null;
}) {
  const router = useRouter();
  const saved = useDeviceLists().saved.includes(slug);
  const [full, setFull] = useState(false);
  const press = () => {
    const result = toggleSavedProduct(slug);
    setFull(result.full);
    // The prototype's confirmations (parity G-S10).
    if (result.full)
      toast({
        title: `You can save up to ${LIST_LIMITS.saved} items`,
        sub: "Remove one to save another",
      });
    else if (result.saved)
      toast({
        title: "Saved on this device",
        sub: "No account needed",
        image,
        action: { label: "View saved", run: () => router.push("/wishlist") },
      });
    else toast({ title: "Removed from saved items", sub: name });
  };
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
  // The product page's big heart beside Add to cart (prototype `wishbig`).
  return (
    <>
      <button
        type="button"
        className="ibtn wishbig wish"
        aria-pressed={saved}
        aria-label={saved ? "Remove from saved items" : "Save to saved items"}
        title={full ? `You can save up to ${LIST_LIMITS.saved} items` : undefined}
        onClick={press}
      >
        <Icon name="heart" />
      </button>
      <span role="status" aria-live="polite" className="sr">
        {full ? `You can save up to ${LIST_LIMITS.saved} items. Remove one to save another.` : ""}
      </span>
    </>
  );
}
