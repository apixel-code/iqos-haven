import "@fontsource/poppins/300.css";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { LegacyCleanup } from "@/components/legacy-cleanup";
import { ageGate } from "@/lib/age/runtime";
import { SITE } from "@/lib/site";

/**
 * Generic metadata only (architecture §9, ADR 0026): the same store name, description and
 * preview image for every URL and every visitor, verified or not. Pages may refine the title for
 * verified shoppers later, but product names, images, prices and JSON-LD must never be put in
 * metadata that an unverified request can receive; the routing gate redirects those requests to
 * the age check before any page metadata is produced.
 */
// Every page is rendered per request: nothing is prerendered at build time or stored in a
// shared cache, so a verified shopper's HTML can never be served to someone else (ADR 0025).
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(ageGate().runtime.origins[0]!),
    title: SITE.name,
    description: SITE.description,
    robots: { index: false, follow: false },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      title: SITE.name,
      description: SITE.description,
    },
    twitter: { card: "summary_large_image", title: SITE.name, description: SITE.description },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f2f4f5",
};

/**
 * On a reload the page opens at the top, not where the shopper had scrolled (Marina 2026-11-09),
 * with no jump. Chrome decides whether to restore when the reload starts, from the mode of the
 * page being left, so the mode is set to "manual" as the document is unloaded (`pagehide`), and
 * the new document scrolls to the top in <head>, before its first paint. After it has loaded the
 * mode goes back to "auto", so back/forward between pages of the store (client navigation, no
 * unload) still return to where the shopper was. A page restored from the back/forward cache keeps
 * its own position.
 */
const RELOAD_STARTS_AT_TOP = `(function(){try{if(!("scrollRestoration" in history))return;var h=history;addEventListener("pagehide",function(){h.scrollRestoration="manual"});var n=performance.getEntriesByType("navigation")[0];var reload=n&&n.type==="reload";var top=function(){if(reload)window.scrollTo(0,0)};top();document.addEventListener("DOMContentLoaded",top);addEventListener("load",function(){top();setTimeout(function(){h.scrollRestoration="auto"},0)})}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: RELOAD_STARTS_AT_TOP }} />
      </head>
      <body>
        <LegacyCleanup />
        {children}
      </body>
    </html>
  );
}
