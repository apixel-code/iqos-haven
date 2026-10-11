import { ImageResponse } from "next/og";
import { AGE_COPY } from "@/lib/age/copy";
import { SITE } from "@/lib/site";

export const alt = SITE.name;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The one link-preview image for every URL of the store: the store name and the adults-only
 * badge. It is generated from constants only, so it cannot show a product.
 */
export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        background: "#f2f4f5",
        color: "#14181b",
      }}
    >
      <div style={{ fontSize: 112, fontWeight: 700, letterSpacing: -3 }}>{SITE.name}</div>
      <div
        style={{
          fontSize: 36,
          padding: "12px 32px",
          borderRadius: 999,
          background: "#14181b",
          color: "#ffffff",
        }}
      >
        {AGE_COPY.badge}
      </div>
    </div>,
    size,
  );
}
