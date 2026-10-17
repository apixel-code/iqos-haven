"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDeviceLists } from "@/lib/device/store";
import { useStoreBrands } from "@/lib/store/client-hooks";
import { POLICY_PAGES, PRIMARY_NAV, SITE } from "@/lib/site";
import { WHATSAPP_MESSAGES } from "@/lib/whatsapp";
import { WhatsAppLink } from "./whatsapp-link";

const HELP_LINKS = [
  { href: "/help#help-delivery", label: "Delivery information" },
  { href: "/help#help-faq", label: "FAQ" },
  { href: "/help#help-contact", label: "Contact" },
  ...POLICY_PAGES.map((page) => ({ href: page.path, label: page.title })),
];
const row =
  "flex min-h-12 items-center justify-between gap-3 rounded-sm px-3 text-base hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * Mobile menu (parity G-S4, ADR 0083): a sheet from the left with the shop sections, brands,
 * saved items, compare, help and WhatsApp. Shown below the `md` breakpoint, where the header
 * keeps only the logo, this button, search and the cart. Brands are read when the menu first
 * opens (the API checks the age ticket), not on every page.
 */
export function MenuSheet({ whatsappNumber }: { whatsappNumber: string | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const { brands, load: loadBrands, ensure: ensureBrands } = useStoreBrands();
  const lists = useDeviceLists();
  const pathname = usePathname();

  const close = () => dialog.current?.close();
  // A followed link closes the menu, including Back and Forward.
  useEffect(() => close(), [pathname]);

  function show() {
    dialog.current?.showModal();
    setOpen(true);
    ensureBrands();
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={show}
        className="inline-flex h-10 items-center rounded-pill border border-line-2 bg-surface px-4 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:hidden"
      >
        Menu
      </button>
      <dialog
        ref={dialog}
        aria-label="Menu"
        // The close event arrives after the dialog closed; it may have been reopened since.
        onClose={() => !dialog.current?.open && setOpen(false)}
        // A click on the backdrop (outside the panel) closes the menu.
        onClick={(event) => event.target === event.currentTarget && close()}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-dvh w-[min(86vw,22rem)] max-w-none bg-surface p-0 text-ink shadow-3 backdrop:bg-ink/40"
      >
        {open && (
          <div className="flex h-full flex-col">
            <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
              <span className="text-lg font-semibold tracking-tight">{SITE.name}</span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={close}
                className="size-10 rounded-pill text-xl hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus"
              >
                ×
              </button>
            </header>
            <nav aria-label="Menu" className="flex-1 overflow-y-auto px-2 py-3">
              <ul className="flex flex-col">
                <li>
                  <Link href="/" prefetch={false} onClick={close} className={row}>
                    Home
                  </Link>
                </li>
                {PRIMARY_NAV.filter((item) => item.href !== "/brands").map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      prefetch={false}
                      onClick={close}
                      aria-current={pathname === item.href ? "page" : undefined}
                      className={`${row} ${pathname === item.href ? "font-semibold" : ""}`}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <details className="group">
                    <summary className={`${row} cursor-pointer list-none`}>
                      Brands
                      <span
                        aria-hidden="true"
                        className="transition-transform group-open:rotate-180"
                      >
                        ⌄
                      </span>
                    </summary>
                    <div className="flex flex-col pb-2 pl-3">
                      {brands.state === "ready" ? (
                        <>
                          {brands.items.map((brand) => (
                            <Link
                              key={brand.slug}
                              href={`/brands/${brand.slug}`}
                              prefetch={false}
                              onClick={close}
                              className={`${row} min-h-10 text-sm`}
                            >
                              {brand.name}
                              <span className="font-mono text-xs text-ink-3">
                                {brand.productCount}
                              </span>
                            </Link>
                          ))}
                          {brands.items.length === 0 && (
                            <p className="px-3 py-2 text-sm text-ink-2">No brands yet.</p>
                          )}
                        </>
                      ) : brands.state === "failed" ? (
                        <p className="px-3 py-2 text-sm text-ink-2">
                          Brands could not be loaded.{" "}
                          <button type="button" onClick={loadBrands} className="underline">
                            Try again
                          </button>
                        </p>
                      ) : (
                        <p role="status" className="px-3 py-2 text-sm text-ink-2">
                          Loading brands…
                        </p>
                      )}
                      <Link
                        href="/brands"
                        prefetch={false}
                        onClick={close}
                        className={`${row} min-h-10 text-sm font-medium underline underline-offset-2`}
                      >
                        View all brands
                      </Link>
                    </div>
                  </details>
                </li>
                <li>
                  <Link href="/wishlist" prefetch={false} onClick={close} className={row}>
                    Saved items
                    {lists.saved.length > 0 && (
                      <span className="font-mono text-xs text-ink-3">{lists.saved.length}</span>
                    )}
                  </Link>
                </li>
                <li>
                  <Link href="/compare" prefetch={false} onClick={close} className={row}>
                    Compare kits
                    {lists.compare.length > 0 && (
                      <span className="font-mono text-xs text-ink-3">{lists.compare.length}</span>
                    )}
                  </Link>
                </li>
                <li>
                  <details className="group">
                    <summary className={`${row} cursor-pointer list-none`}>
                      Help &amp; info
                      <span
                        aria-hidden="true"
                        className="transition-transform group-open:rotate-180"
                      >
                        ⌄
                      </span>
                    </summary>
                    <div className="flex flex-col pb-2 pl-3">
                      {HELP_LINKS.map((link) => (
                        <Link
                          key={link.href}
                          href={link.href}
                          prefetch={false}
                          onClick={close}
                          className={`${row} min-h-10 text-sm`}
                        >
                          {link.label}
                        </Link>
                      ))}
                    </div>
                  </details>
                </li>
              </ul>
            </nav>
            <div className="border-t border-line px-5 py-4">
              <WhatsAppLink
                number={whatsappNumber}
                message={WHATSAPP_MESSAGES.general(SITE.name)}
                className="flex h-12 w-full items-center justify-center rounded-pill bg-wa px-4 text-sm font-medium text-white hover:bg-wa-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                Chat on WhatsApp
              </WhatsAppLink>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
