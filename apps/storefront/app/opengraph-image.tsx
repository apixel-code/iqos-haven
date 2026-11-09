import { ImageResponse } from "next/og";
import { OG_LOGO, OG_LOGO_SIZE } from "@/assets/og-logo";
import { AGE_COPY } from "@/lib/age/copy";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name} logo`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0e1116";
const SAFFRON = "#f2b233";

/**
 * The one link-preview image for every URL of the store (ADR 0026): the store logo (client,
 * 2026-11-08), a generic line and the adults-only badge, in the store colours. Built from
 * constants only, so it cannot show a product, a price or a product picture.
 */
export default function OpenGraphImage() {
  const chip = (text: string, accent = false) => (
    <div
      style={{
        display: "flex",
        fontSize: 28,
        padding: "12px 28px",
        borderRadius: 999,
        border: accent ? "none" : "2px solid rgba(255,255,255,0.28)",
        background: accent ? SAFFRON : "transparent",
        color: accent ? INK : "#ffffff",
        fontWeight: 600,
      }}
    >
      {text}
    </div>
  );
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 40,
        background: `radial-gradient(circle at 85% 15%, rgba(242,178,51,0.28), transparent 45%), radial-gradient(circle at 10% 95%, rgba(31,122,153,0.35), transparent 50%), ${INK}`,
        color: "#ffffff",
      }}
    >
      <img src={OG_LOGO} width={OG_LOGO_SIZE.width} height={OG_LOGO_SIZE.height} alt="" />
      <div style={{ display: "flex", fontSize: 38, color: "#c9cfd6", letterSpacing: -0.5 }}>
        Delivery across all seven emirates
      </div>
      <div style={{ display: "flex", gap: 18 }}>
        {chip("All payment methods accepted")}
        {chip(AGE_COPY.badge, true)}
      </div>
    </div>,
    size,
  );
}
