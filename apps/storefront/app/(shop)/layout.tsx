import Link from "next/link";
import type { ReactNode } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { CartSheet } from "@/components/cart-sheet";
import { IconSprite } from "@/components/icons";
import { PromoTicker } from "@/components/promo-ticker";
import { SiteHeader } from "@/components/site-header";
import { StoreOverlays } from "@/components/store-overlays";
import { Toasts } from "@/components/toasts";
import { AGE_COPY } from "@/lib/age/copy";
import { businessLine, readBusiness } from "@/lib/business";
import { POLICY_PAGES, SITE } from "@/lib/site";
import { shellBrands, storeHome, storeInfo } from "@/lib/store/server";

/**
 * Store shell (roadmap step 64; the prototype's look since ADR 0097): promotional bar, header,
 * the page, the footer, and the fixed overlays (phone bottom navigation, WhatsApp button, cart
 * sheet). Every route under it is restricted by the routing gate. Footer copy marked below awaits
 * the client's approved wording (BI-01, BI-04).
 */
/** TikTok's note glyph (Simple Icons, CC0 1.0), drawn on a 24 × 24 grid. */
const TIKTOK_MARK =
  "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z";

export default async function ShopLayout({ children }: { children: ReactNode }) {
  const [{ whatsappNumber, social }, { ticker }, brands, business] = await Promise.all([
    storeInfo(),
    storeHome(),
    shellBrands(),
    readBusiness(),
  ]);
  // The shop name is already on the location line; the bottom row adds only a different legal
  // name and the trade licence (Marina 2026-11-08: one line fewer, location centred).
  const operator = businessLine({
    ...business,
    legalName: business.legalName === SITE.name ? null : business.legalName,
  });
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
              <BrandLogo tone="light" className="foot-logo" />
              {/* Prototype wording adapted to UAE-wide delivery (BI-03); final copy is BI-01. */}
              <p>
                An online store for IQOS devices and TEREA sticks, delivering across the UAE. Order
                online and pay cash on delivery.
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
                  <Link href="/devices" prefetch={false}>
                    IQOS devices
                  </Link>
                </li>
                <li>
                  <Link href="/sticks" prefetch={false}>
                    TEREA sticks
                  </Link>
                </li>
                <li>
                  <Link href="/offers" prefetch={false}>
                    Offers
                  </Link>
                </li>
                <li>
                  <Link href="/compare" prefetch={false}>
                    Compare devices
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
                  <Link href="/track" prefetch={false}>
                    Track your order
                  </Link>
                </li>
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
              {(social.facebook || social.instagram || social.tiktok) && (
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
                    {social.tiktok && (
                      <a
                        href={social.tiktok}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${SITE.name} on TikTok`}
                        className="so-tt"
                      >
                        {/* TikTok's note mark (Simple Icons, CC0) with its cyan and red offsets, on white like Facebook. */}
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="12" r="11.5" fill="#fff" />
                          <g transform="translate(6.2 5.6) scale(0.52)">
                            <path fill="#25F4EE" transform="translate(-0.9 -0.6)" d={TIKTOK_MARK} />
                            <path fill="#FE2C55" transform="translate(0.9 0.6)" d={TIKTOK_MARK} />
                            <path fill="#000" d={TIKTOK_MARK} />
                          </g>
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
          {/* Independent-retailer disclosure (client blueprint, ADR 0103). */}
          <p className="foot-warn">
            {SITE.name} is an independent retailer and is not affiliated with, endorsed by or
            sponsored by Philip Morris International. IQOS, ILUMA and TEREA are trademarks of their
            respective owners.
          </p>
          <div className="foot-bottom">
            <span>
              © {new Date().getFullYear()} {SITE.name}. All rights reserved.
            </span>
            <span>{operator ? `${AGE_COPY.footer} · ${operator}` : AGE_COPY.footer}</span>
            <span>Payment: Cash on delivery</span>
          </div>
        </div>
      </footer>
      <StoreOverlays whatsappNumber={whatsappNumber} />
      <CartSheet whatsappNumber={whatsappNumber} />
      <Toasts />
    </>
  );
}
