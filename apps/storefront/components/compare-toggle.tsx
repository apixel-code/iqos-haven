"use client";

import Link from "next/link";
import { useState } from "react";
import { LIST_LIMITS } from "@/lib/device/lists";
import { toggleCompareProduct, useDeviceLists } from "@/lib/device/store";

/** "Compare with other kits" on a kit's page (prototype); at most three kits. */
export function CompareToggle({ slug }: { slug: string }) {
  const compare = useDeviceLists().compare;
  const comparing = compare.includes(slug);
  const [full, setFull] = useState(false);
  return (
    <div className="cmp-row">
      <label className="cmp-toggle check">
        <input
          type="checkbox"
          checked={comparing}
          onChange={() => setFull(toggleCompareProduct(slug).full)}
        />
        <span className="ct">Compare with other kits</span>
      </label>
      {compare.length > 0 && (
        <Link href="/compare" prefetch={false} className="link small">
          ({compare.length} selected · view)
        </Link>
      )}
      <p role="status" aria-live="polite" className="cmp-full">
        {full ? `You can compare up to ${LIST_LIMITS.compare} kits. Remove one first.` : ""}
      </p>
    </div>
  );
}
