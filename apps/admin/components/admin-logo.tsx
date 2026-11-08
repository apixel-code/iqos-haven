import logoDark from "../assets/logo-dark.png";
import logoLight from "../assets/logo-light.png";
import markIcon from "../assets/mark.png";

/**
 * The store's logo (client, 2026-11-08). Both tones are rendered and the theme picks one in CSS
 * (`.logo-tone-*`), so the light and dark admin themes, system or chosen, each show a readable
 * logo. `mark` is the square IH icon for the narrow sidebar rail.
 */
export function AdminLogo({ alt = "Iqos Haven" }: { alt?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="admin-logo logo-tone-dark"
        src={logoDark.src}
        width={logoDark.width}
        height={logoDark.height}
        alt={alt}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="admin-logo logo-tone-light"
        src={logoLight.src}
        width={logoLight.width}
        height={logoLight.height}
        alt=""
        aria-hidden="true"
      />
    </>
  );
}

export function AdminMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="admin-mark"
      src={markIcon.src}
      width={markIcon.width}
      height={markIcon.height}
      alt=""
      aria-hidden="true"
    />
  );
}
