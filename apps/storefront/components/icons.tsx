/**
 * The prototype's icon set (docs/prototypes/storefront.html sprite, ADR 0097): one hidden sprite
 * in the store shell, and `<Icon name>` uses a symbol from it, exactly as the prototype's `ico()`.
 * Decorative: every icon is aria-hidden; the control around it carries the accessible name.
 */
export type IconName =
  | "search"
  | "bag"
  | "heart"
  | "menu"
  | "x"
  | "chev-r"
  | "chev-l"
  | "chev-d"
  | "plus"
  | "minus"
  | "trash"
  | "wa"
  | "truck"
  | "shield"
  | "cash"
  | "home"
  | "grid"
  | "tag"
  | "filter"
  | "check"
  | "info"
  | "compare"
  | "star"
  | "pin"
  | "clock"
  | "arrow-r"
  | "arrow-l"
  | "pause"
  | "play"
  | "lock"
  | "copy"
  | "building"
  | "briefcase"
  | "box"
  | "phone"
  | "tablet"
  | "desktop"
  | "doc"
  | "eye"
  | "refresh"
  | "layers"
  | "external";

// Static markup from the prototype (no user input).
const SPRITE = `<defs><symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></symbol><symbol id="i-bag" viewBox="0 0 24 24"><path d="M5 8h14l-1.1 12.1a1 1 0 0 1-1 .9H7.1a1 1 0 0 1-1-.9L5 8z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /></symbol><symbol id="i-heart" viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z" /></symbol><symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10" /></symbol><symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></symbol><symbol id="i-chev-r" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></symbol><symbol id="i-chev-l" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></symbol><symbol id="i-chev-d" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></symbol><symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol><symbol id="i-minus" viewBox="0 0 24 24"><path d="M5 12h14" /></symbol><symbol id="i-trash" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" /></symbol><symbol id="i-wa" viewBox="0 0 24 24"><path d="M4 20l1.2-3.7A8 8 0 1 1 8 19.1L4 20z" /><path d="M9.2 8.6c.3-.4.8-.4 1 0l.7 1.5c.1.3 0 .6-.2.8l-.5.5c.5 1 1.4 1.9 2.4 2.4l.5-.5c.2-.2.5-.3.8-.2l1.5.7c.4.2.4.7 0 1-.6.6-1.4.9-2.2.7-2.1-.6-3.8-2.3-4.4-4.4-.2-.8.1-1.6.4-2.5z" /></symbol><symbol id="i-truck" viewBox="0 0 24 24"><path d="M3 6.5h11v9.5H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></symbol><symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" /></symbol><symbol id="i-cash" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6.5 9.5h.01M17.5 14.5h.01" /></symbol><symbol id="i-home" viewBox="0 0 24 24"><path d="M4 10.5L12 4l8 6.5V20h-5v-6H9v6H4z" /></symbol><symbol id="i-grid" viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></symbol><symbol id="i-tag" viewBox="0 0 24 24"><path d="M3.5 12V4.5H11l9 9-7.5 7.5-9-9z" /><circle cx="7.8" cy="8.3" r="1.3" /></symbol><symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4" /></symbol><symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></symbol><symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.01" /></symbol><symbol id="i-compare" viewBox="0 0 24 24"><path d="M7 4L3 8l4 4M3 8h12M17 12l4 4-4 4M21 16H9" /></symbol><symbol id="i-star" viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" /></symbol><symbol id="i-pin" viewBox="0 0 24 24"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z" /><circle cx="12" cy="10" r="2.2" /></symbol><symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></symbol><symbol id="i-arrow-r" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></symbol><symbol id="i-arrow-l" viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6" /></symbol><symbol id="i-pause" viewBox="0 0 24 24"><path d="M9 6v12M15 6v12" /></symbol><symbol id="i-play" viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" /></symbol><symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></symbol><symbol id="i-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></symbol><symbol id="i-building" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10.5 21v-3h3v3" /></symbol><symbol id="i-briefcase" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5h6v2M3 12h18" /></symbol><symbol id="i-box" viewBox="0 0 24 24"><path d="M3 7.5l9-4 9 4v9l-9 4-9-4z" /><path d="M3 7.5l9 4 9-4M12 11.5v9" /></symbol><symbol id="i-phone" viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></symbol><symbol id="i-tablet" viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M11 18h2" /></symbol><symbol id="i-desktop" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M9 20h6M12 16v4" /></symbol><symbol id="i-doc" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></symbol><symbol id="i-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></symbol><symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></symbol><symbol id="i-layers" viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></symbol><symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></symbol></defs>`;

export function IconSprite() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: "absolute" }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: SPRITE }}
    />
  );
}

export function Icon({ name, size }: { name: IconName; size?: "sm" | "lg" | "xl" | "fill" }) {
  return (
    <svg className={size ? `i ${size}` : "i"} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
