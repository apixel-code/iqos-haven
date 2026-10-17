"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * A screen's view state in the page URL (parity G-A2): links open an exact view, and Back and
 * reload keep it. `push` adds a history entry (opening a record); filters replace the entry.
 */
export function useUrlQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams();
  const navigate = (changes: Record<string, string | null>, push = false) => {
    const next = new URLSearchParams(query.toString());
    for (const [key, value] of Object.entries(changes))
      if (value === null) next.delete(key);
      else next.set(key, value);
    const url = next.size ? `${pathname}?${next}` : pathname;
    if (push) router.push(url, { scroll: false });
    else router.replace(url, { scroll: false });
  };
  return { get: (key: string) => query.get(key), navigate };
}
