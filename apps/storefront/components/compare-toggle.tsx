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
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex w-fit cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={comparing}
          onChange={() => setFull(toggleCompareProduct(slug).full)}
        />
        Compare with other kits
      </label>
      <p role="status" aria-live="polite" className="text-ink-2">
        {full ? (
          `You can compare up to ${LIST_LIMITS.compare} kits. Remove one first.`
        ) : compare.length > 0 ? (
          <>
            {compare.length} {compare.length === 1 ? "kit" : "kits"} selected.{" "}
            <Link href="/compare" prefetch={false} className="font-medium text-ink underline">
              Compare
            </Link>
          </>
        ) : (
          ""
        )}
      </p>
    </div>
  );
}
