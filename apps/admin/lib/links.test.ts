import { describe, expect, it } from "vitest";
import { newOrderForPhone, notificationDestination, orderHref, ordersHref } from "./links";

const ID = "01a14865-52b0-7a07-bd83-786bf58a5c86";

describe("admin deep links", () => {
  it("opens the exact order, stock line or list a notification points to", () => {
    expect(notificationDestination(`/orders/${ID}`)).toEqual({
      href: orderHref(ID),
      label: "Open order",
    });
    expect(notificationDestination(`/inventory/${ID}`)?.href).toBe(
      `/workspace/inventory?variant=${ID}`,
    );
    expect(notificationDestination("/reviews")?.href).toBe("/workspace/reviews");
  });

  it("never copies anything but an ID into a link", () => {
    expect(notificationDestination("/orders/x?y=1")?.href).toBe("/workspace/orders");
    expect(notificationDestination("/orders/a/b")).toBeNull();
    expect(notificationDestination("//evil.example/orders/1")).toBeNull();
    expect(notificationDestination("https://evil.example")).toBeNull();
    expect(notificationDestination(null)).toBeNull();
  });

  it("builds list filters", () => {
    expect(ordersHref()).toBe("/workspace/orders");
    expect(ordersHref({ status: "pending" })).toBe("/workspace/orders?status=pending");
    expect(ordersHref({ delayed: true })).toBe("/workspace/orders?delayed=1");
  });
  it("opens a new order with a customer's phone filled in", () => {
    expect(newOrderForPhone("+971501234567")).toBe("/workspace/orders?new=1&phone=%2B971501234567");
  });
});
