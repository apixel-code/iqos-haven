import Link from "next/link";
import type { ReactNode } from "react";
import { CartLink } from "@/components/cart-link";
import { NavLinks } from "@/components/nav-links";
import { SearchBox } from "@/components/search-box";
import { WhatsAppLink } from "@/components/whatsapp-link";
import { AGE_COPY } from "@/lib/age/copy";
import { POLICY_PAGES, PRIMARY_NAV, SITE } from "@/lib/site";
import { PromoTicker } from "@/components/promo-ticker";
import { storeHome, storeInfo } from "@/lib/store/server";
import { WHATSAPP_MESSAGES } from "@/lib/whatsapp";

const footerLink = "text-ink-2 hover:text-ink hover:underline";

/**
 * Store shell (roadmap step 64): the published promotional bar (step 99), header with navigation,
 * search, saved items and cart, and the footer. Every route under it is restricted by the
 * routing gate. The footer copy marked below awaits the client's approved wording (BI-01, BI-04).
 */
export default async function ShopLayout({ children }: { children: ReactNode }) {
  const [{ whatsappNumber }, { ticker }] = await Promise.all([storeInfo(), storeHome()]);
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-20 focus:rounded-pill focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-on-primary"
      >
        Skip to content
      </a>
      {ticker && <PromoTicker messages={ticker.messages} />}
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-8">
          <Link href="/" prefetch={false} className="text-lg font-semibold tracking-tight">
            {SITE.name}
          </Link>
          <SearchBox />
          <nav aria-label="Main" className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <NavLinks />
            <ul className="flex items-center gap-x-3 text-sm">
              <li>
                <Link href="/wishlist" prefetch={false} className="text-ink-2 hover:text-ink">
                  Saved
                </Link>
              </li>
              <li>
                <CartLink />
              </li>
            </ul>
          </nav>
        </div>
      </header>
      <main id="content" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-8">
        {children}
      </main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-10 text-sm sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
          <div className="flex flex-col gap-2">
            <p className="text-lg font-semibold tracking-tight">{SITE.name}</p>
            <p className="text-ink-2">{SITE.description}</p>
            <span className="w-fit rounded-pill bg-accent-soft px-3 py-1 text-xs font-medium">
              {AGE_COPY.badge}
            </span>
          </div>
          <nav aria-label="Shop" className="flex flex-col gap-2">
            <h2 className="font-semibold">Shop</h2>
            <ul className="flex flex-col gap-1.5">
              {PRIMARY_NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} prefetch={false} className={footerLink}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <nav aria-label="Help and legal" className="flex flex-col gap-2">
            <h2 className="font-semibold">Help &amp; legal</h2>
            <ul className="flex flex-col gap-1.5">
              <li>
                <Link href="/help" prefetch={false} className={footerLink}>
                  Help &amp; delivery
                </Link>
              </li>
              {POLICY_PAGES.map((page) => (
                <li key={page.path}>
                  <a href={page.path} className={footerLink}>
                    {page.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex flex-col gap-2">
            <h2 className="font-semibold">Payment</h2>
            <p className="text-ink-2">Cash on delivery. No account needed.</p>
            <WhatsAppLink number={whatsappNumber} message={WHATSAPP_MESSAGES.general(SITE.name)}>
              Chat on WhatsApp
            </WhatsAppLink>
          </div>
        </div>
        <div className="border-t border-line">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-5 text-xs text-ink-2 sm:px-8">
            {/* Prototype wording; the required health warning text is pending (BI-04). */}
            <p>
              These products contain nicotine, which is addictive, and are not intended for
              non-smokers, pregnant or breastfeeding women.
            </p>
            <p>{AGE_COPY.footer}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
