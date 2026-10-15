import { afterEach, describe, expect, it, vi } from "vitest";
import { settingResponseSchema, deliveryConfigurationResponseSchema } from "@ih/contracts";
import { ApiError } from "./auth";
import {
  aedToFils,
  filsToAed,
  deliveryCommand,
  settingsCommand,
  managementRequest,
  managementError,
  emptyResponse,
  FormValidationError,
} from "./management";
afterEach(() => vi.unstubAllGlobals());
const data = (entries: Record<string, string>) => {
  const result = new FormData();
  for (const [key, value] of Object.entries(entries)) result.set(key, value);
  return result;
};
describe("admin management boundary", () => {
  it("uses same-origin cookies/no-store/JSON and validates saved versions", async () => {
    const row = {
      version: 2,
      value: { flatFeeFils: 29, etaText: "Approved test ETA", freeThresholdFils: null },
      updatedAt: new Date().toISOString(),
      updatedBy: "a63f4905-c053-4ee5-9a43-a307f3906348",
    };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(row)));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await managementRequest(
        "/delivery-areas/configuration",
        deliveryConfigurationResponseSchema,
        "PATCH",
        { version: 1, value: row.value },
      ),
    ).toEqual(row);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/admin/delivery-areas/configuration",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, value: row.value }),
      }),
    );
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty("Authorization");
  });
  it("rejects malformed success responses rather than trusting a saved claim", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ key: "store", value: {}, version: 1 }))),
    );
    await expect(
      managementRequest("/settings", settingResponseSchema, "PATCH", {}),
    ).rejects.toThrow();
  });
  it("handles bodyless commands without inventing returned staff versions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(
      await managementRequest("/staff/any/deactivate", emptyResponse, "POST", { version: 3 }),
    ).toBeUndefined();
    expect(() => emptyResponse.parse({ version: 4 })).toThrow();
  });
  it("rejects external/unrelated routes and traversal before sending", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const path of [
      "https://evil.test/staff",
      "/auth/login",
      "//staff",
      "/staff/../settings",
      "/staff#token",
    ])
      await expect(managementRequest(path, emptyResponse)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("propagates cancellation and installs a request deadline", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    await managementRequest("/staff", emptyResponse, "GET", undefined, abort.signal);
    const signal = fetcher.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    abort.abort();
    expect(signal.aborted).toBe(true);
  });
  it("keeps server error detail out of UI and preserves Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("private SQL/recipient detail", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      ),
    );
    const error = await managementRequest("/settings", emptyResponse).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(managementError(error)).toContain("30 seconds");
    expect(managementError(error)).not.toContain("SQL");
  });
  it("maps stale writes/access denial/uncertain saves to actionable safe states", () => {
    expect(managementError(new ApiError(409), true)).toContain("Reload");
    expect(managementError(new ApiError(403), true)).toContain("no longer have access");
    expect(managementError(new Error("secret"), true)).toContain("Could not confirm");
    expect(managementError(new ApiError(400))).toContain("formats");
  });
});
describe("versioned form payloads", () => {
  it("converts exact decimal AED text to integer fils and rejects unsafe formats", () => {
    for (const [input, expected] of [
      ["0", 0],
      ["0.29", 29],
      ["12.5", 1250],
      ["10000000.00", 1000000000],
    ] as const) {
      expect(aedToFils(input)).toBe(expected);
      expect(aedToFils(filsToAed(expected))).toBe(expected);
    }
    for (const input of ["", "-1", "1.001", "1e3", "1,000", "Infinity", "10000000.01"])
      expect(() => aedToFils(input)).toThrow(FormValidationError);
  });
  it("never guesses missing fees or enables the threshold", () => {
    expect(() => deliveryCommand(0, data({ etaText: "Approved ETA" }))).toThrow();
    expect(deliveryCommand(7, data({ fee: "0.29", etaText: " Approved ETA " }))).toEqual({
      version: 7,
      value: { flatFeeFils: 29, etaText: "Approved ETA", freeThresholdFils: null },
    });
  });
  it("builds complete typed settings groups, retains expected version and maps optional blanks to null", () => {
    expect(
      settingsCommand(
        "store",
        0,
        data({ name: " Store ", domain: "store.example.test", legalName: "" }),
      ),
    ).toEqual({
      key: "store",
      version: 0,
      value: { name: "Store", domain: "store.example.test", legalName: null },
    });
    expect(
      settingsCommand(
        "contact",
        8,
        data({ email: "support@example.test", "social.instagram": "https://instagram.com/test" }),
      ),
    ).toMatchObject({
      key: "contact",
      version: 8,
      value: {
        email: "support@example.test",
        phone: null,
        social: { instagram: "https://instagram.com/test", tiktok: null, facebook: null },
      },
    });
  });
  it("validates new-order recipient rules instead of leaking unsupported prototype flags", () => {
    expect(() =>
      settingsCommand("notifications", 1, data({ "newOrderEmail.enabled": "on" })),
    ).toThrow();
    expect(() =>
      settingsCommand(
        "notifications",
        1,
        data({ recipients: "one@example.test, ONE@example.test" }),
      ),
    ).toThrow();
    expect(
      settingsCommand(
        "notifications",
        2,
        data({ inApp: "on", recipients: "one@example.test\ntwo@example.test" }),
      ),
    ).toEqual({
      key: "notifications",
      version: 2,
      value: {
        inApp: true,
        newOrderEmail: { enabled: false, recipients: ["one@example.test", "two@example.test"] },
        lowStockEmail: false,
      },
    });
    // Low-stock email shares the recipient list and needs at least one address.
    expect(() =>
      settingsCommand("notifications", 1, data({ inApp: "on", lowStockEmail: "on" })),
    ).toThrow();
    expect(
      settingsCommand(
        "notifications",
        3,
        data({ lowStockEmail: "on", recipients: "stock@example.test" }),
      ).value,
    ).toEqual({
      inApp: false,
      newOrderEmail: { enabled: false, recipients: ["stock@example.test"] },
      lowStockEmail: true,
    });
  });
  it("rejects unsafe contact URLs and unsupported WhatsApp placeholders", () => {
    expect(() =>
      settingsCommand("contact", 1, data({ "social.instagram": "javascript:alert(1)" })),
    ).toThrow();
    expect(() =>
      settingsCommand("whatsapp", 1, data({ "templates.support": "{{password}}" })),
    ).toThrow();
    expect(
      settingsCommand("whatsapp", 1, data({ "templates.support": "Order {{order_number}}" })),
    ).toMatchObject({
      value: {
        number: null,
        templates: {
          support: "Order {{order_number}}",
          orderConfirmation: null,
          statusUpdate: null,
        },
      },
    });
  });
});
