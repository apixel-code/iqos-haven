/**
 * The admin prototype's icon set (docs/prototypes/admin.html sprite, ADR 0097): one hidden sprite
 * in the shell, and `<Icon name>` uses a symbol from it, exactly as the prototype's `ico()`.
 * Decorative: every icon is aria-hidden; the control around it carries the accessible name.
 */
export type IconName =
  | "home"
  | "orders"
  | "box"
  | "folder"
  | "award"
  | "layers"
  | "users"
  | "user"
  | "star"
  | "percent"
  | "layout"
  | "chart"
  | "file"
  | "search"
  | "settings"
  | "shield"
  | "bell"
  | "plus"
  | "minus"
  | "x"
  | "check"
  | "check-c"
  | "x-c"
  | "cd"
  | "cr"
  | "cl"
  | "cu"
  | "arr-r"
  | "arr-l"
  | "up"
  | "down"
  | "sort"
  | "more"
  | "edit"
  | "trash"
  | "restore"
  | "wa"
  | "phone"
  | "copy"
  | "filter"
  | "cal"
  | "download"
  | "upload"
  | "image"
  | "grip"
  | "eye"
  | "eye-off"
  | "lock"
  | "logout"
  | "menu"
  | "clock"
  | "truck"
  | "pkg"
  | "alert"
  | "info"
  | "refresh"
  | "wifi-off"
  | "ext"
  | "mail"
  | "pin"
  | "sun"
  | "moon"
  | "globe"
  | "link"
  | "cash"
  | "card"
  | "printer"
  | "heart"
  | "zap"
  | "send"
  | "book"
  | "monitor"
  | "tablet"
  | "mobile"
  | "play"
  | "grid"
  | "tag"
  | "store"
  | "wand";

// Static markup from the prototype (no user input).
const SPRITE =
  '<defs> <symbol id="i-home" viewBox="0 0 24 24"> <path d="M3 10.5 12 3l9 7.5" /> <path d="M5 9.5V21h5v-6h4v6h5V9.5" /> </symbol> <symbol id="i-orders" viewBox="0 0 24 24"> <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /> <path d="M9 8h6M9 12h6M9 16h3" /> </symbol> <symbol id="i-box" viewBox="0 0 24 24"> <path d="M21 8 12 3 3 8v8l9 5 9-5z" /> <path d="M3 8l9 5 9-5M12 13v8" /> </symbol> <symbol id="i-folder" viewBox="0 0 24 24"> <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" /> </symbol> <symbol id="i-award" viewBox="0 0 24 24"> <circle cx="12" cy="9" r="6" /> <path d="m8.5 14-1.5 7 5-3 5 3-1.5-7" /> </symbol> <symbol id="i-layers" viewBox="0 0 24 24"> <path d="m12 3 9 5-9 5-9-5z" /> <path d="m3 13 9 5 9-5" /> </symbol> <symbol id="i-users" viewBox="0 0 24 24"> <circle cx="9" cy="8" r="3.5" /> <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5" /> <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2" /> </symbol> <symbol id="i-user" viewBox="0 0 24 24"> <circle cx="12" cy="8" r="4" /> <path d="M4 21c1-4.2 4-6.5 8-6.5s7 2.3 8 6.5" /> </symbol> <symbol id="i-star" viewBox="0 0 24 24"> <path d="m12 2.8 2.8 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.1l-5.7 3 1.2-6.3L2.9 9.4l6.3-.8z" /> </symbol> <symbol id="i-percent" viewBox="0 0 24 24"> <path d="M19 5 5 19" /> <circle cx="7" cy="7" r="2.5" /> <circle cx="17" cy="17" r="2.5" /> </symbol> <symbol id="i-layout" viewBox="0 0 24 24"> <rect x="3" y="3" width="18" height="18" rx="2" /> <path d="M3 9h18M9 21V9" /> </symbol> <symbol id="i-chart" viewBox="0 0 24 24"> <path d="M3 3v18h18" /> <path d="m7 15 4-4 3 3 6-7" /> </symbol> <symbol id="i-file" viewBox="0 0 24 24"> <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" /> <path d="M14 3v5h5M9 13h6M9 17h6" /> </symbol> <symbol id="i-search" viewBox="0 0 24 24"> <circle cx="11" cy="11" r="7" /> <path d="m20 20-4-4" /> </symbol> <symbol id="i-settings" viewBox="0 0 24 24"> <circle cx="12" cy="12" r="3" /> <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /> </symbol> <symbol id="i-shield" viewBox="0 0 24 24"> <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z" /> <path d="m9 12 2 2 4-4" /> </symbol> <symbol id="i-bell" viewBox="0 0 24 24"> <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /> <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /> </symbol> <symbol id="i-plus" viewBox="0 0 24 24"> <path d="M12 5v14M5 12h14" /> </symbol> <symbol id="i-minus" viewBox="0 0 24 24"><path d="M5 12h14" /></symbol> <symbol id="i-x" viewBox="0 0 24 24"> <path d="M18 6 6 18M6 6l12 12" /> </symbol> <symbol id="i-check" viewBox="0 0 24 24"> <path d="M20 6 9 17l-5-5" /> </symbol> <symbol id="i-check-c" viewBox="0 0 24 24"> <circle cx="12" cy="12" r="9" /> <path d="m8 12.5 2.8 2.8L16.5 9.5" /> </symbol> <symbol id="i-x-c" viewBox="0 0 24 24"> <circle cx="12" cy="12" r="9" /> <path d="m15 9-6 6M9 9l6 6" /> </symbol> <symbol id="i-cd" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></symbol> <symbol id="i-cr" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></symbol> <symbol id="i-cl" viewBox="0 0 24 24"> <path d="m15 6-6 6 6 6" /> </symbol> <symbol id="i-cu" viewBox="0 0 24 24"> <path d="m18 15-6-6-6 6" /> </symbol> <symbol id="i-arr-r" viewBox="0 0 24 24"> <path d="M5 12h14M13 6l6 6-6 6" /> </symbol> <symbol id="i-arr-l" viewBox="0 0 24 24"> <path d="M19 12H5M11 6l-6 6 6 6" /> </symbol> <symbol id="i-up" viewBox="0 0 24 24"> <path d="M7 17 17 7M8 7h9v9" /> </symbol> <symbol id="i-down" viewBox="0 0 24 24"> <path d="M7 7l10 10M17 8v9H8" /> </symbol> <symbol id="i-sort" viewBox="0 0 24 24"> <path d="m7 9 5-5 5 5M7 15l5 5 5-5" /> </symbol> <symbol id="i-more" viewBox="0 0 24 24"> <circle cx="5" cy="12" r="1.2" /> <circle cx="12" cy="12" r="1.2" /> <circle cx="19" cy="12" r="1.2" /> </symbol> <symbol id="i-edit" viewBox="0 0 24 24"> <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /> <path d="m13.5 6.5 4 4" /> </symbol> <symbol id="i-trash" viewBox="0 0 24 24"> <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12.5A1.5 1.5 0 0 0 8 21h8a1.5 1.5 0 0 0 1.5-1.5L18.5 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" /> </symbol> <symbol id="i-restore" viewBox="0 0 24 24"> <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /> <path d="M3 3v5h5" /> </symbol> <symbol id="i-wa" viewBox="0 0 24 24"> <path d="M3.5 20.5 5 16a8.5 8.5 0 1 1 3.2 3.1z" /> <path d="M9 8.6c0 3.4 3 6.4 6.4 6.4l1.1-1.6-2.2-1-1 .9a5 5 0 0 1-2.6-2.6l.9-1-1-2.2z" /> </symbol> <symbol id="i-phone" viewBox="0 0 24 24"> <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /> </symbol> <symbol id="i-copy" viewBox="0 0 24 24"> <rect x="9" y="9" width="12" height="12" rx="2" /> <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" /> </symbol> <symbol id="i-filter" viewBox="0 0 24 24"> <path d="M3 5h18M6 12h12M10 19h4" /> </symbol> <symbol id="i-cal" viewBox="0 0 24 24"> <rect x="3" y="5" width="18" height="16" rx="2" /> <path d="M3 10h18M8 3v4M16 3v4" /> </symbol> <symbol id="i-download" viewBox="0 0 24 24"> <path d="M12 4v11M7 10l5 5 5-5M4 20h16" /> </symbol> <symbol id="i-upload" viewBox="0 0 24 24"> <path d="M12 16V5M7 10l5-5 5 5M4 20h16" /> </symbol> <symbol id="i-image" viewBox="0 0 24 24"> <rect x="3" y="3" width="18" height="18" rx="2" /> <circle cx="9" cy="9" r="2" /> <path d="m21 15-5-5L5 21" /> </symbol> <symbol id="i-grip" viewBox="0 0 24 24"> <circle cx="9" cy="6" r="1.2" /> <circle cx="15" cy="6" r="1.2" /> <circle cx="9" cy="12" r="1.2" /> <circle cx="15" cy="12" r="1.2" /> <circle cx="9" cy="18" r="1.2" /> <circle cx="15" cy="18" r="1.2" /> </symbol> <symbol id="i-eye" viewBox="0 0 24 24"> <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12" /> <circle cx="12" cy="12" r="3" /> </symbol> <symbol id="i-eye-off" viewBox="0 0 24 24"> <path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.4 3.2M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" /> </symbol> <symbol id="i-lock" viewBox="0 0 24 24"> <rect x="4" y="10.5" width="16" height="10.5" rx="2" /> <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /> </symbol> <symbol id="i-logout" viewBox="0 0 24 24"> <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 17l-5-5 5-5M5 12h11" /> </symbol> <symbol id="i-menu" viewBox="0 0 24 24"> <path d="M4 7h16M4 12h16M4 17h16" /> </symbol> <symbol id="i-clock" viewBox="0 0 24 24"> <circle cx="12" cy="12" r="9" /> <path d="M12 7v5l3 2" /> </symbol> <symbol id="i-truck" viewBox="0 0 24 24"> <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h9A1.5 1.5 0 0 1 15 6.5V16H3z" /> <path d="M15 9h3.5l2.5 3.5V16h-6" /> <circle cx="7" cy="17.5" r="1.8" /> <circle cx="17.5" cy="17.5" r="1.8" /> </symbol> <symbol id="i-pkg" viewBox="0 0 24 24"> <path d="M21 8 12 3 3 8v8l9 5 9-5z" /> <path d="m7.5 5.5 9 5M3 8l9 5 9-5M12 13v8" /> </symbol> <symbol id="i-alert" viewBox="0 0 24 24"> <path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0" /> <path d="M12 9.5v4M12 17h.01" /> </symbol> <symbol id="i-info" viewBox="0 0 24 24"> <circle cx="12" cy="12" r="9" /> <path d="M12 11v5M12 8h.01" /> </symbol> <symbol id="i-refresh" viewBox="0 0 24 24"> <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8" /> <path d="M21 3v5h-5M3 21v-5h5" /> </symbol> <symbol id="i-wifi-off" viewBox="0 0 24 24"> <path d="M3 3l18 18M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.2-2.4M19 12.9a10 10 0 0 0-2.1-1.6M2 9.2a15 15 0 0 1 4.3-2.8M22 9.2A15 15 0 0 0 11 5.1M12 20h.01" /> </symbol> <symbol id="i-ext" viewBox="0 0 24 24"> <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /> </symbol> <symbol id="i-mail" viewBox="0 0 24 24"> <rect x="3" y="5" width="18" height="14" rx="2" /> <path d="m3 7 9 6 9-6" /> </symbol> <symbol id="i-pin" viewBox="0 0 24 24"> <path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21" /> <circle cx="12" cy="9.5" r="2.5" /> </symbol> <symbol id="i-sun" viewBox="0 0 24 24"> <circle cx="12" cy="12" r="4" /> <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /> </symbol> <symbol id="i-moon" viewBox="0 0 24 24"> <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5" /> </symbol> <symbol id="i-globe" viewBox="0 0 24 24"> <circle cx="12" cy="12" r="9" /> <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /> </symbol> <symbol id="i-link" viewBox="0 0 24 24"> <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /> <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /> </symbol> <symbol id="i-cash" viewBox="0 0 24 24"> <rect x="2.5" y="6" width="19" height="12" rx="2" /> <circle cx="12" cy="12" r="2.5" /> <path d="M6 9.5v5M18 9.5v5" /> </symbol> <symbol id="i-card" viewBox="0 0 24 24"> <rect x="2.5" y="5" width="19" height="14" rx="2" /> <path d="M2.5 10h19M6 15h4" /> </symbol> <symbol id="i-printer" viewBox="0 0 24 24"> <path d="M7 9V3h10v6M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /> <rect x="7" y="14" width="10" height="7" rx="1" /> </symbol> <symbol id="i-heart" viewBox="0 0 24 24"> <path d="M12 20s-7.5-4.6-9-9.5C2 7 4.3 4.5 7.3 4.5c1.9 0 3.6 1 4.7 2.6 1.1-1.6 2.8-2.6 4.7-2.6 3 0 5.3 2.5 4.3 6C19.5 15.4 12 20 12 20" /> </symbol> <symbol id="i-zap" viewBox="0 0 24 24"> <path d="M13 2 4 14h7l-1 8 9-12h-7z" /> </symbol> <symbol id="i-send" viewBox="0 0 24 24"> <path d="m22 2-11 11M22 2l-7 20-4-9-9-4z" /> </symbol> <symbol id="i-book" viewBox="0 0 24 24"> <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /> <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /> </symbol> <symbol id="i-monitor" viewBox="0 0 24 24"> <rect x="2.5" y="4" width="19" height="13" rx="2" /> <path d="M8 21h8M12 17v4" /> </symbol> <symbol id="i-tablet" viewBox="0 0 24 24"> <rect x="4" y="2.5" width="16" height="19" rx="2" /> <path d="M11 18h2" /> </symbol> <symbol id="i-mobile" viewBox="0 0 24 24"> <rect x="6.5" y="2.5" width="11" height="19" rx="2" /> <path d="M11 18h2" /> </symbol> <symbol id="i-play" viewBox="0 0 24 24"> <path d="M7 4.5v15l12-7.5z" /> </symbol> <symbol id="i-grid" viewBox="0 0 24 24"> <rect x="3" y="3" width="7" height="7" rx="1.5" /> <rect x="14" y="3" width="7" height="7" rx="1.5" /> <rect x="3" y="14" width="7" height="7" rx="1.5" /> <rect x="14" y="14" width="7" height="7" rx="1.5" /> </symbol> <symbol id="i-tag" viewBox="0 0 24 24"> <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8" /> <circle cx="7.5" cy="7.5" r="1.5" /> </symbol> <symbol id="i-store" viewBox="0 0 24 24"> <path d="M4 9.5V20h16V9.5M3 5l1.5-2h15L21 5v2.5a2.5 2.5 0 0 1-4.5 1.5 2.5 2.5 0 0 1-4.5 0 2.5 2.5 0 0 1-4.5 0A2.5 2.5 0 0 1 3 7.5z" /> <path d="M10 20v-5h4v5" /> </symbol> <symbol id="i-wand" viewBox="0 0 24 24"> <path d="m15 4 5 5L9 20l-5-5zM12 7l5 5" /> </symbol> </defs>';

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

export function Icon({ name, size }: { name: IconName; size?: "sm" | "lg" | "xl" }) {
  return (
    <svg className={size ? `i ${size}` : "i"} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}
