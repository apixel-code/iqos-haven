/**
 * Admin session policy (architecture §11): idle timeout 12 h, absolute expiry 7 days. Last-seen
 * is refreshed at most every 5 minutes, so the effective idle window is 12 h + up to 5 min.
 */
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const SESSION_REVOKE_REASONS = [
  "logout",
  "password_reset",
  "deactivated",
  "role_changed",
  "admin_revoked",
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/**
 * Minimized network metadata: IPv4 truncated to /24, IPv6 to /48. Never the full address.
 * Returns null for anything that is not a plain IP.
 */
export function ipNetwork(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.replace(/^::ffff:/, ""));
  if (v4 && v4.slice(1).every((part) => Number(part) <= 255))
    return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(":")) {
    const groups = expandIpv6(ip);
    return groups ? `${groups.slice(0, 3).join(":")}::/48` : null;
  }
  return null;
}

function expandIpv6(ip: string): string[] | null {
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => group.replace(/^0+(?=.)/, ""));
}

/** Coarse client label such as "Chrome on macOS"; never the raw User-Agent string. */
export function clientLabel(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (!browser && !os) return null;
  return [browser ?? "Browser", os ? `on ${os}` : null].filter(Boolean).join(" ");
}
