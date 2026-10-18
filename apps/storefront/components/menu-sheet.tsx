"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useDeviceLists } from "@/lib/device/store";
import { useStoreBrands } from "@/lib/store/client-hooks";
import { POLICY_PAGES, PRIMARY_NAV, SITE } from "@/lib/site";
import { WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { openSearchSheet } from "./search-sheet";
import { Sheet } from "./sheet";
import { WhatsAppLink } from "./whatsapp-link";
import { Icon } from "@/components/icons";

const HELP_LINKS = [
  { href: "/help#help-delivery", label: "Delivery information" },
  { href: "/help#help-faq", label: "FAQ" },
  { href: "/help#help-contact", label: "Contact" },
  ...POLICY_PAGES.map((page) => ({ href: page.path, label: page.title })),
];

/**
 * Mobile menu (parity G-S4, ADR 0083) as the prototype's `menuSheet` (V-S6): a sheet from the
 * left with search, the shop sections, brands, saved items, compare, help and WhatsApp. Shown
 * below 720 px, where the header keeps only the logo, this button, search and the cart. Brands
 * are read when the menu first opens (the API checks the age ticket), not on every page.
 */
export function MenuSheet({ whatsappNumber }: { whatsappNumber: string | null }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<"brands" | "help" | null>(null);
  const { brands, load: loadBrands, ensure: ensureBrands } = useStoreBrands();
  const lists = useDeviceLists();
  const pathname = usePathname();
  const close = () => setOpen(false);
  // A followed link closes the menu, including Back and Forward.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }

  /** The prototype's accordion (`macc`); a closed panel is inert, so it is never tabbed into. */
  const accordion = (id: "brands" | "help", label: string, inner: ReactNode) => (
    <div className={section === id ? "macc open" : "macc"}>
      <button
        type="button"
        className="macc-btn"
        aria-expanded={section === id}
        aria-controls={`macc-${id}`}
        onClick={() => setSection(section === id ? null : id)}
      >
        <span>{label}</span>
        <Icon name="chev-d" />
      </button>
      <div className="macc-panel" id={`macc-${id}`} inert={section !== id}>
        <div className="macc-in">{inner}</div>
      </div>
    </div>
  );
  const count = (value: number) => (value > 0 ? <span className="c">{value}</span> : null);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          ensureBrands();
        }}
        className="ibtn only-sm"
        aria-label="Open menu"
      >
        <Icon name="menu" />
      </button>
      <Sheet
        open={open}
        onClose={close}
        title="Menu"
        side="left"
        head={
          <div className="sh-head">
            <span className="wm">
              Iqos <span>Haven</span>
            </span>
            <button type="button" className="ibtn" aria-label="Close menu" onClick={close}>
              <Icon name="x" />
            </button>
          </div>
        }
      >
        <button
          type="button"
          className="m-search"
          onClick={() => {
            close();
            openSearchSheet();
          }}
        >
          <Icon name="search" /> Search
        </button>
        <nav className="mnav" aria-label="Menu">
          <Link href="/" prefetch={false} onClick={close}>
            <span>Home</span>
          </Link>
          {PRIMARY_NAV.filter((item) => item.href !== "/brands").map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              onClick={close}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              <span>{item.label}</span>
            </Link>
          ))}
          {accordion(
            "brands",
            "Brands",
            <>
              {brands.state === "ready" ? (
                brands.items.length ? (
                  <div className="mnav-sub">
                    {brands.items.map((brand) => (
                      <Link
                        key={brand.slug}
                        href={`/brands/${brand.slug}`}
                        prefetch={false}
                        onClick={close}
                      >
                        <span>{brand.name}</span>
                        <span className="c">{brand.productCount}</span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="small muted macc-note">No brands yet.</p>
                )
              ) : brands.state === "failed" ? (
                <p className="small muted macc-note">
                  Brands could not be loaded.{" "}
                  <button type="button" className="link" onClick={loadBrands}>
                    Try again
                  </button>
                </p>
              ) : (
                <p role="status" className="small muted macc-note">
                  Loading brands…
                </p>
              )}
              <Link href="/brands" prefetch={false} onClick={close} className="macc-all">
                View all brands
              </Link>
            </>,
          )}
          <Link href="/wishlist" prefetch={false} onClick={close}>
            <span>Saved items</span>
            {count(lists.saved.length)}
          </Link>
          <Link href="/compare" prefetch={false} onClick={close}>
            <span>Compare kits</span>
            {count(lists.compare.length)}
          </Link>
          {accordion(
            "help",
            "Help & info",
            <>
              {HELP_LINKS.map((link) => (
                <Link key={link.href} href={link.href} prefetch={false} onClick={close}>
                  <span>{link.label}</span>
                </Link>
              ))}
            </>,
          )}
        </nav>
        <WhatsAppLink
          number={whatsappNumber}
          message={WHATSAPP_MESSAGES.general(SITE.name)}
          className="btn btn-wa btn-block m-wa"
        >
          <Icon name="wa" size="sm" /> Chat on WhatsApp
        </WhatsAppLink>
      </Sheet>
    </>
  );
}
