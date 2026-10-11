import Link from "next/link";
import type { ReactNode } from "react";
import { CartLink } from "@/components/cart-link";
import { SearchBox } from "@/components/search-box";
import { AGE_COPY } from "@/lib/age/copy";
import { SITE } from "@/lib/site";
import { PolicyLinks } from "../(policy)/policy-page";

const NAV = [
  { href: "/shop", label: "Shop" },
  { href: "/disposable-vapes", label: "Disposables" },
  { href: "/vape-kits", label: "Vape kits" },
  { href: "/brands", label: "Brands" },
] as const;

/**
 * Minimal frame for catalogue pages. The full header, search, cart and footer arrive with the
 * navigation shell (roadmap step 64); this keeps the listing pages reachable until then.
 * Every route under it is restricted by the routing gate.
 */
export default function ShopLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
          <Link href="/" prefetch={false} className="text-lg font-semibold tracking-tight">
            {SITE.name}
          </Link>
          <SearchBox />
          <nav aria-label="Catalogue">
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} prefetch={false} className="text-ink-2 hover:text-ink">
                    {item.label}
                  </Link>
                </li>
              ))}
              <li>
                <CartLink />
              </li>
            </ul>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-8">{children}</main>
      <footer className="flex flex-col items-center gap-2 border-t border-line px-4 py-6 text-xs text-ink-2">
        <PolicyLinks />
        <span>{AGE_COPY.footer}</span>
      </footer>
    </div>
  );
}
