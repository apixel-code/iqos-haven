import logoDark from "@/assets/logo-dark.png";
import logoLight from "@/assets/logo-light.png";
import { SITE } from "@/lib/site";

/**
 * The store's logo (client, 2026-11-08): the IH mark with "Iqos Haven". `dark` is ink for light
 * backgrounds, `light` is white for the dark footer. Served from `/_next/static`, so the age
 * gate shows it too. Pass `alt=""` when a link around it already names the store.
 */
export function BrandLogo({
  tone = "dark",
  alt = SITE.name,
  className,
}: {
  tone?: "dark" | "light";
  alt?: string;
  className?: string;
}) {
  const image = tone === "light" ? logoLight : logoDark;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className ? `site-logo ${className}` : "site-logo"}
      src={image.src}
      width={image.width}
      height={image.height}
      alt={alt}
      decoding="async"
    />
  );
}
