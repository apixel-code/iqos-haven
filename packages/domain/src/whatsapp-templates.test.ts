import { describe, expect, it } from "vitest";
import {
  DEFAULT_WHATSAPP_TEMPLATES,
  renderWhatsappTemplate,
  whatsappMessageHref,
} from "./whatsapp-templates";

const values = {
  store_name: "Iqos Haven",
  order_number: "IH-001001",
  status: "Out for delivery",
  total: "AED 159.00",
  support_phone: "+971501234567",
};

describe("order WhatsApp templates", () => {
  it("fills every placeholder and leaves the rest as written", () => {
    expect(renderWhatsappTemplate(DEFAULT_WHATSAPP_TEMPLATES.orderConfirmation, values)).toBe(
      "Hi, this is Iqos Haven. We received your order IH-001001 for AED 159.00, cash on delivery. Please reply YES to confirm delivery.",
    );
    expect(
      renderWhatsappTemplate(
        "{{order_number}} {{order_number}} {{unknown}} {{support_phone}}",
        values,
      ),
    ).toBe("IH-001001 IH-001001 {{unknown}} +971501234567");
  });

  it("keeps a value on one line", () => {
    expect(
      renderWhatsappTemplate("Hi {{store_name}}!", { ...values, store_name: "Shop\r\nInjected" }),
    ).toBe("Hi Shop Injected!");
  });

  it("builds a wa.me link with the text encoded, for a valid phone only", () => {
    expect(whatsappMessageHref("+971501234567", "Order IH-1 & more?")).toBe(
      "https://wa.me/971501234567?text=Order%20IH-1%20%26%20more%3F",
    );
    for (const phone of ["0501234567", "+0501234567", "+97150123456789012", "+97150 1234567"])
      expect(whatsappMessageHref(phone, "x")).toBeNull();
  });
});
