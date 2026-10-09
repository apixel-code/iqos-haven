import { describe, expect, it } from "vitest";
import { clientLabel, ipNetwork } from "./session";

describe("session metadata minimization", () => {
  it.each([
    ["203.0.113.77", "203.0.113.0/24"],
    ["::ffff:198.51.100.9", "198.51.100.0/24"],
    ["2001:db8:abcd:12::1", "2001:db8:abcd::/48"],
    ["::1", "0:0:0::/48"],
    ["999.1.1.1", null],
    ["not-an-ip", null],
    [undefined, null],
  ])("truncates %s", (ip, expected) => {
    expect(ipNetwork(ip)).toBe(expected);
  });

  it("keeps only a coarse client label", () => {
    expect(
      clientLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      clientLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1"),
    ).toBe("Safari on iOS");
    expect(clientLabel("curl/8.6.0")).toBeNull();
    expect(clientLabel(undefined)).toBeNull();
  });
});
