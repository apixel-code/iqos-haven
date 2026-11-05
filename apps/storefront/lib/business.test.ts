import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ storefrontEnv: () => ({ API_INTERNAL_URL: "http://api.test" }) }));
const { businessLine, forgetBusiness, readBusiness } = await import("./business");

describe("public business details on the storefront (ADR 0106)", () => {
  afterEach(() => {
    forgetBusiness();
    vi.unstubAllGlobals();
  });

  it("shows nothing on any failure or unexpected answer", async () => {
    for (const answer of [
      () => Promise.reject(new Error("down")),
      () => Promise.resolve(new Response("{}", { status: 500 })),
      () => Promise.resolve(Response.json({ legalName: "X LLC" })),
      () => Promise.resolve(Response.json({ legalName: null, tradeLicence: null, phone: "+971" })),
    ]) {
      forgetBusiness();
      vi.stubGlobal("fetch", vi.fn(answer));
      expect(await readBusiness()).toEqual({ legalName: null, tradeLicence: null });
    }
  });

  it("follows the Owner's details, held for a minute", async () => {
    const business = { legalName: "Haven Trading LLC", tradeLicence: "CN-1234567" };
    const fetch = vi.fn(() => Promise.resolve(Response.json(business)));
    vi.stubGlobal("fetch", fetch);
    expect(await readBusiness(0)).toEqual(business);
    await readBusiness(59_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await readBusiness(61_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("joins whichever details are set", () => {
    expect(businessLine({ legalName: "Haven Trading LLC", tradeLicence: "CN-1234567" })).toBe(
      "Haven Trading LLC · Trade licence no. CN-1234567",
    );
    expect(businessLine({ legalName: null, tradeLicence: "CN-1" })).toBe("Trade licence no. CN-1");
    expect(businessLine({ legalName: "Haven Trading LLC", tradeLicence: null })).toBe(
      "Haven Trading LLC",
    );
    expect(businessLine({ legalName: null, tradeLicence: null })).toBeNull();
  });
});
