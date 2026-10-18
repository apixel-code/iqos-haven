import { describe, expect, it } from "vitest";
import { scrubErrorEvent } from "./scrub";

describe("error report scrubbing (step 125)", () => {
  it("keeps the error kind and location, drops everything that may hold personal data", () => {
    const event = {
      event_id: "abc",
      timestamp: 1,
      level: "error",
      platform: "node",
      release: "cd826ea",
      environment: "production",
      tags: { service: "api", email: "shopper@example.com" },
      message: "order for shopper@example.com",
      user: { email: "shopper@example.com", ip_address: "203.0.113.9" },
      request: {
        url: "https://iqoshaven.com/api/v1/store/orders?phone=971500000000",
        headers: { cookie: "__Host-ih_admin=secret" },
        data: { name: "Shopper", phone: "+971500000000" },
      },
      breadcrumbs: [{ message: "GET /order-confirmation?token=secret" }],
      extra: { body: "secret" },
      contexts: { trace: { trace_id: "t" } },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read 'phone' of shopper@example.com",
            mechanism: { type: "onunhandledrejection", handled: false },
            stacktrace: {
              frames: [
                {
                  filename: "/app/dist/orders.js",
                  function: "createOrder",
                  lineno: 10,
                  colno: 4,
                  in_app: true,
                  vars: { phone: "+971500000000" },
                  context_line: "const phone = input.phone",
                },
              ],
            },
          },
        ],
      },
    };
    const scrubbed = scrubErrorEvent(event);
    const json = JSON.stringify(scrubbed);
    for (const secret of [
      "shopper@example.com",
      "971500000000",
      "secret",
      "Shopper",
      "203.0.113.9",
    ])
      expect(json).not.toContain(secret);
    expect(scrubbed).toMatchObject({
      release: "cd826ea",
      environment: "production",
      tags: { service: "api" },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "[redacted]",
            mechanism: { type: "onunhandledrejection", handled: false },
            stacktrace: {
              frames: [{ filename: "/app/dist/orders.js", function: "createOrder", lineno: 10 }],
            },
          },
        ],
      },
    });
  });
});
