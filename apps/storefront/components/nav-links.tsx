"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRIMARY_NAV } from "@/lib/site";

/** Primary navigation; the current section is marked for assistive technology and sight. */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      {PRIMARY_NAV.map((item) => {
        const current = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              prefetch={false}
              aria-current={current ? "page" : undefined}
              className={`rounded-xs py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                current ? "font-semibold text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
