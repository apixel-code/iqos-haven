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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
