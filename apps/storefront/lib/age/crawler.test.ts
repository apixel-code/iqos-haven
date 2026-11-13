import { describe, expect, it, vi } from "vitest";
import { createCrawlerVerifier, type CrawlerResolver } from "./crawler";

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BINGBOT = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1";

function resolver(records: Record<string, string[]>, forward: Record<string, string[]>) {
  return {
    reverse: vi.fn((ip: string) =>
      records[ip] ? Promise.resolve(records[ip]) : Promise.reject(new Error("ENOTFOUND")),
    ),
    forward: vi.fn((host: string) =>
      forward[host] ? Promise.resolve(forward[host]) : Promise.reject(new Error("ENOTFOUND")),
    ),
  } satisfies CrawlerResolver;
}

describe("verified search crawlers (ADR 0114)", () => {
  it("accepts an address that reverse- and forward-resolves to a crawler host", async () => {
    const dns = resolver(
      {
        "66.249.66.1": ["crawl-66-249-66-1.googlebot.com."],
        "157.55.39.1": ["msnbot-157-55-39-1.search.msn.com"],
        "2001:4860:4801:10::1": ["crawl-v6.googlebot.com"],
      },
      {
        "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"],
        "msnbot-157-55-39-1.search.msn.com": ["157.55.39.1"],
        // Another spelling of the same IPv6 address.
        "crawl-v6.googlebot.com": ["2001:4860:4801:0010:0000:0000:0000:0001"],
      },
    );
    const verify = createCrawlerVerifier(dns);
    expect(await verify(GOOGLEBOT, "66.249.66.1")).toBe(true);
    expect(await verify(BINGBOT, "157.55.39.1")).toBe(true);
    expect(await verify(GOOGLEBOT, "2001:4860:4801:10::1")).toBe(true);
  });

  it("never trusts the User-Agent: a crawler name from another address is refused", async () => {
    const dns = resolver(
      {
        "203.0.113.9": ["host.example.net"],
        // A reverse record anyone can set on their own address…
        "198.51.100.7": ["crawl-66-249-66-1.googlebot.com"],
        "198.51.100.8": ["googlebot.com.attacker.example"],
        "198.51.100.9": ["fakegooglebot.com"],
        // Google's proxies for people (translated pages and the like) are not its crawler.
        "66.249.81.1": ["google-proxy-66-249-81-1.google.com"],
      },
      // …but the real host resolves forward to Google, not to them.
      {
        "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"],
        "google-proxy-66-249-81-1.google.com": ["66.249.81.1"],
      },
    );
    const verify = createCrawlerVerifier(dns);
    for (const ip of [
      "203.0.113.9",
      "198.51.100.7",
      "198.51.100.8",
      "198.51.100.9",
      "66.249.81.1",
      "192.0.2.1",
    ])
      expect(await verify(GOOGLEBOT, ip)).toBe(false);
  });

  it("asks DNS only for crawler agents with a usable address", async () => {
    const dns = resolver({}, {});
    const verify = createCrawlerVerifier(dns);
    expect(await verify(BROWSER, "66.249.66.1")).toBe(false);
    expect(await verify(null, "66.249.66.1")).toBe(false);
    expect(await verify(GOOGLEBOT, null)).toBe(false);
    expect(await verify(GOOGLEBOT, "unknown")).toBe(false);
    expect(dns.reverse).not.toHaveBeenCalled();
  });

  it("holds an answer per address: hours when verified, minutes when refused", async () => {
    let now = 0;
    const dns = resolver(
      { "66.249.66.1": ["crawl.googlebot.com"], "203.0.113.9": ["host.example.net"] },
      { "crawl.googlebot.com": ["66.249.66.1"] },
    );
    const verify = createCrawlerVerifier(dns, () => now);
    await verify(GOOGLEBOT, "66.249.66.1");
    await verify(GOOGLEBOT, "203.0.113.9");
    now = 4 * 60 * 1000;
    await verify(GOOGLEBOT, "66.249.66.1");
    await verify(GOOGLEBOT, "203.0.113.9");
    expect(dns.reverse).toHaveBeenCalledTimes(2);
    now = 6 * 60 * 1000;
    await verify(GOOGLEBOT, "66.249.66.1");
    await verify(GOOGLEBOT, "203.0.113.9");
    expect(dns.reverse).toHaveBeenCalledTimes(3);
    now = 7 * 60 * 60 * 1000;
    await verify(GOOGLEBOT, "66.249.66.1");
    expect(dns.reverse).toHaveBeenCalledTimes(4);
  });

  it("treats a slow resolver as a refusal", async () => {
    vi.useFakeTimers();
    try {
      const verify = createCrawlerVerifier({
        reverse: () => new Promise(() => {}),
        forward: () => Promise.resolve([]),
      });
      const answer = verify(GOOGLEBOT, "66.249.66.1");
      await vi.advanceTimersByTimeAsync(2500);
      expect(await answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
