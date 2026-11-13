import { promises as dns } from "node:dns";
import { BlockList, isIP } from "node:net";

/**
 * Verified search crawlers (ADR 0114). Under the `catalogue` indexing policy the routing gate
 * lets Google's and Bing's crawlers read catalogue pages without the age check. The User-Agent
 * never grants anything: it only decides whether the address is worth checking. Trust comes
 * from DNS, the way both engines document it: the client address must reverse-resolve to one
 * of their crawler hosts, and that host must resolve forward to the same address. Any failure
 * or timeout means "not a crawler".
 */
const CRAWLER_AGENT = /googlebot|google-inspectiontool|bingbot/i;
// Not `google.com`: that also names Google's user-triggered fetchers and proxies (a translated
// page, for one), which fetch for any person and so prove nothing about who is reading.
const CRAWLER_HOSTS: readonly string[] = [".googlebot.com", ".search.msn.com"];
const VERIFIED_MS = 6 * 60 * 60 * 1000;
const REFUSED_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 2000;
const MAX_HELD = 2000;

export interface CrawlerResolver {
  reverse(ip: string): Promise<string[]>;
  forward(host: string, family: 4 | 6): Promise<string[]>;
}

const dnsResolver: CrawlerResolver = {
  reverse: (ip) => dns.reverse(ip),
  forward: (host, family) => (family === 4 ? dns.resolve4(host) : dns.resolve6(host)),
};

async function confirm(resolver: CrawlerResolver, ip: string, family: 4 | 6): Promise<boolean> {
  const hosts = (await resolver.reverse(ip)).map((host) => host.toLowerCase().replace(/\.$/, ""));
  const kind = family === 4 ? "ipv4" : "ipv6";
  for (const host of hosts) {
    if (!CRAWLER_HOSTS.some((suffix) => host.endsWith(suffix))) continue;
    // BlockList compares addresses by value, so two spellings of one IPv6 address match.
    const confirmed = new BlockList();
    for (const address of await resolver.forward(host, family))
      if (isIP(address) === family) confirmed.addAddress(address, kind);
    if (confirmed.check(ip, kind)) return true;
  }
  return false;
}

export function createCrawlerVerifier(
  resolver: CrawlerResolver = dnsResolver,
  now: () => number = Date.now,
) {
  const held = new Map<string, { verified: Promise<boolean>; until: number }>();
  return async function isVerifiedCrawler(
    userAgent: string | null,
    ip: string | null,
  ): Promise<boolean> {
    if (!userAgent || !CRAWLER_AGENT.test(userAgent) || !ip) return false;
    const family = isIP(ip);
    if (family !== 4 && family !== 6) return false;
    const known = held.get(ip);
    if (known && known.until > now()) return known.verified;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const verified = Promise.race([
      confirm(resolver, ip, family),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), TIMEOUT_MS);
      }),
    ])
      .catch(() => false)
      .finally(() => clearTimeout(timer));
    if (held.size >= MAX_HELD) held.delete(held.keys().next().value!);
    const entry = { verified, until: now() + REFUSED_MS };
    held.delete(ip);
    held.set(ip, entry);
    // A confirmed crawler address is held for hours; a refusal is asked again after minutes.
    void verified.then((ok) => {
      if (ok) entry.until = now() + VERIFIED_MS;
    });
    return verified;
  };
}

/** Process-wide verifier for the routing gate. */
export const isVerifiedCrawler = createCrawlerVerifier();
