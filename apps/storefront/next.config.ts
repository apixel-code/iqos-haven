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

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/:path((?!responsible-use$|terms$|privacy$).*)", headers: noindex },
    ];
  },
};

export default nextConfig;
