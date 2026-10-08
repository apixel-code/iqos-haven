import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./index";
describe("log privacy", () => {
  it("removes top-level, nested, array PII, URLs, headers and exception text", () => {
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    });
    const log = createLogger({ service: "test" }, sink);
    log.info(
      {
        phone: "PHONE_SECRET",
        token: "TOKEN_SECRET",
        customer: { name: "PERSON_SECRET" },
        nested: { contact: { email: "MAIL_SECRET", address: "ADDRESS_SECRET" } },
        list: [{ mobile: "MOBILE_SECRET" }],
        req: {
          id: "request-1234",
          method: "GET",
          url: "/reset/TOKEN_PATH_SECRET?token=QUERY_SECRET",
          headers: { cookie: "COOKIE_SECRET" },
        },
        err: new Error("postgres://PASSWORD_SECRET"),
      },
      "static test message",
    );
    for (const marker of [
      "PHONE_SECRET",
      "TOKEN_SECRET",
      "PERSON_SECRET",
      "MAIL_SECRET",
      "ADDRESS_SECRET",
      "MOBILE_SECRET",
      "TOKEN_PATH_SECRET",
      "QUERY_SECRET",
      "COOKIE_SECRET",
      "PASSWORD_SECRET",
    ])
      expect(output).not.toContain(marker);
    expect(output).toContain("request-1234");
    expect(output).toContain("static test message");
  });
  it("bounds recursive/circular input", () => {
    let output = "";
    const sink = new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk);
        done();
      },
    });
    const circular: Record<string, unknown> = {};
    circular.again = circular;
    expect(() => createLogger({ service: "test" }, sink).info(circular, "cycle")).not.toThrow();
    expect(output).toContain("[truncated]");
  });
});
