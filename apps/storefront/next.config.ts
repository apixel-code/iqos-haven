import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];
// Indexing stays off (BI-05). The public policy pages are the one exception the Owner may open
// (step 113, ADR 0079): their header is set by the routing proxy from the policy instead.
const noindex = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

/** The retired TEREA edition products (ADR 0110), by slug suffix. */
const TEREA_EDITIONS = [
  "uzbekistan",
  "kyrgyzstan",
  "kazakhstan",
  "indonesia",
  "japan",
  "swiss",
  "uae",
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // The vape pages became the heated-tobacco pages (ADR 0101); old links keep working.
  async redirects() {
    return [
      { source: "/vape-kits", destination: "/devices", permanent: true },
      { source: "/disposable-vapes", destination: "/sticks", permanent: true },
      // Each TEREA edition became one product per flavour in a country category (ADR 0110); the
      // retired edition pages send visitors to that country's flavours.
      ...TEREA_EDITIONS.map((country) => ({
        source: `/p/terea-${country}`,
        destination: `/category/terea-${country}`,
        permanent: true,
      })),
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/:path((?!responsible-use$|terms$|privacy$).*)", headers: noindex },
    ];
  },
};

export default nextConfig;
