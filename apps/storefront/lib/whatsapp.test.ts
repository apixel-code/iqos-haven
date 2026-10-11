import { describe, expect, it } from "vitest";
import { whatsappHref, WHATSAPP_MESSAGES } from "./whatsapp";

describe("WhatsApp links", () => {
  it("builds a wa.me link with an encoded, editable message", () => {
    expect(whatsappHref("+971501234567", "Hi Iqos Haven, I have a question.")).toBe(
      "https://wa.me/971501234567?text=Hi%20Iqos%20Haven%2C%20I%20have%20a%20question.",
    );
    expect(whatsappHref("+971501234567", "")).toBe("https://wa.me/971501234567");
  });

  it("gives no link without a valid configured number", () => {
    for (const number of [
      null,
      undefined,
      "",
      "0501234567",
      "+97150",
      "call me",
      "+971 50 123 4567",
    ])
      expect(whatsappHref(number, "hello"), String(number)).toBeNull();
  });

  it("cannot be turned into another URL by the message", () => {
    const href = whatsappHref(
      "+971501234567",
      "a&text=b#frag\nnext line  https://evil.example/?x=1",
    )!;
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe("https://wa.me/971501234567");
    expect([...url.searchParams.keys()]).toEqual(["text"]);
    expect(url.hash).toBe("");
    expect(url.searchParams.get("text")).toBe("a&text=b#frag next line https://evil.example/?x=1");
    expect(whatsappHref("+971501234567", "x".repeat(5000))!.length).toBeLessThan(1100);
  });

  it("words each context from catalogue data only", () => {
    expect(WHATSAPP_MESSAGES.general("Iqos Haven")).toBe("Hi Iqos Haven, I have a question.");
    expect(
      WHATSAPP_MESSAGES.product("Iqos Haven", {
        name: "Halo 7K",
        priceFromFils: 4900,
        soldOut: false,
      }),
    ).toBe("Hi Iqos Haven, I have a question about Halo 7K (AED 49).");
    expect(
      WHATSAPP_MESSAGES.product("Iqos Haven", {
        name: "Halo 7K",
        priceFromFils: 4900,
        soldOut: true,
      }),
    ).toBe("Hi Iqos Haven, please let me know when Halo 7K is back in stock.");
    expect(
      WHATSAPP_MESSAGES.cart("Iqos Haven", [
        { name: "Halo 7K", options: "mint · 20 mg", quantity: 2 },
        { name: "Pod Kit X", options: "", quantity: 1 },
      ]),
    ).toBe("Hi Iqos Haven, I would like to order: 2 x Halo 7K (mint · 20 mg); 1 x Pod Kit X.");
  });
});
