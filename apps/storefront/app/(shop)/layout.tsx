import Link from "next/link";
import type { ReactNode } from "react";
import { CartSheet } from "@/components/cart-sheet";
import { IconSprite } from "@/components/icons";
import { PromoTicker } from "@/components/promo-ticker";
import { SiteHeader } from "@/components/site-header";
import { StoreOverlays } from "@/components/store-overlays";
import { AGE_COPY } from "@/lib/age/copy";
import { POLICY_PAGES, SITE } from "@/lib/site";
import { shellBrands, storeHome, storeInfo } from "@/lib/store/server";

/**
 * Store shell (roadmap step 64; the prototype's look since ADR 0097): promotional bar, header,
 * the page, the footer, and the fixed overlays (phone bottom navigation, WhatsApp button, cart
 * sheet). Every route under it is restricted by the routing gate. Footer copy marked below awaits
 * the client's approved wording (BI-01, BI-04).
 */
export default async function ShopLayout({ children }: { children: ReactNode }) {
  const [{ whatsappNumber, social }, { ticker }, brands] = await Promise.all([
    storeInfo(),
    storeHome(),
    shellBrands(),
  ]);
  return (
    <>
      <IconSprite />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-pill focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-on-primary"
      >
        Skip to content
      </a>
      {ticker && <PromoTicker messages={ticker.messages} />}
      <SiteHeader whatsappNumber={whatsappNumber} belowPromo={Boolean(ticker)} />
      <main id="main" className="wrap">
        {children}
      </main>
      <footer className="foot foot-pad">
        <div className="wrap">
          <div className="foot-grid">
            <div className="foot-brand">
              <span className="wm" style={{ color: "#fff" }}>
                Iqos <span>Haven</span>
              </span>
              {/* Prototype wording adapted to UAE-wide delivery (BI-03); final copy is BI-01. */}
              <p>
                An online store for disposable vapes and pod kits from established brands,
                delivering across the UAE. Order online and pay cash on delivery.
              </p>
            </div>
            <nav aria-label="Shop">
              <h4>Shop</h4>
              <ul>
                <li>
                  <Link href="/shop" prefetch={false}>
                    All products
                  </Link>
                </li>
                <li>
                  <Link href="/disposable-vapes" prefetch={false}>
                    Disposable vapes
                  </Link>
                </li>
                <li>
                  <Link href="/vape-kits" prefetch={false}>
                    Vape kits &amp; devices
                  </Link>
                </li>
                <li>
                  <Link href="/offers" prefetch={false}>
                    Offers
                  </Link>
                </li>
                <li>
                  <Link href="/compare" prefetch={false}>
                    Compare kits
                  </Link>
                </li>
              </ul>
            </nav>
            {brands.length > 0 && (
              <nav aria-label="Brands">
                <h4>Brands</h4>
                <ul>
                  {brands.map((brand) => (
                    <li key={brand.slug}>
                      <Link href={`/brands/${brand.slug}`} prefetch={false}>
                        {brand.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            <nav aria-label="Help">
              <h4>Help</h4>
              <ul>
                <li>
                  <Link href="/help#help-delivery" prefetch={false}>
                    Delivery information
                  </Link>
                </li>
                <li>
                  <Link href="/help#help-faq" prefetch={false}>
                    FAQ
                  </Link>
                </li>
                <li>
                  <Link href="/help#help-contact" prefetch={false}>
                    Contact us
                  </Link>
                </li>
                <li>
                  <Link href="/wishlist" prefetch={false}>
                    Saved items
                  </Link>
                </li>
              </ul>
            </nav>
            <div>
              <nav aria-label="Legal">
                <h4>Legal</h4>
                <ul>
                  {POLICY_PAGES.map((page) => (
                    <li key={page.path}>
                      <a href={page.path}>{page.title}</a>
                    </li>
                  ))}
                </ul>
              </nav>
              {(social.facebook || social.instagram) && (
                <>
                  <h4 style={{ marginTop: 22 }}>Follow us</h4>
                  <div className="social">
                    {social.facebook && (
                      <a
                        href={social.facebook}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${SITE.name} on Facebook`}
                        className="so-fb"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="12" r="11.5" fill="#fff" />
                          <path
                            fill="#1877F2"
                            d="M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.7 4.53-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"
                          />
                        </svg>
                      </a>
                    )}
                    {social.instagram && (
                      <a
                        href={social.instagram}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${SITE.name} on Instagram`}
                        className="so-ig"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect
                            x="3.2"
                            y="3.2"
                            width="17.6"
                            height="17.6"
                            rx="5.2"
                            fill="none"
                            stroke="#fff"
                            strokeWidth="2"
                          />
                          <circle
                            cx="12"
                            cy="12"
                            r="4.1"
                            fill="none"
                            stroke="#fff"
                            strokeWidth="2"
                          />
                          <circle cx="17.3" cy="6.7" r="1.25" fill="#fff" />
                        </svg>
                      </a>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          {/* Prototype wording; the required health warning text is pending (BI-04). */}
          <p className="foot-warn">
            These products contain nicotine, which is addictive, and are not intended for
            non-smokers, pregnant or breastfeeding women.
          </p>
          <div className="foot-bottom">
            <span>
              © {new Date().getFullYear()} {SITE.name}. All rights reserved.
            </span>
            <span>{AGE_COPY.footer}</span>
            <span>Payment: Cash on delivery</span>
          </div>
        </div>
      </footer>
      <StoreOverlays whatsappNumber={whatsappNumber} />
      <CartSheet whatsappNumber={whatsappNumber} />
    </>
  );
}
