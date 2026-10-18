import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { flushErrorReporting, startErrorReporting } from "./error-reporting";

describe("error reporting end to end (step 125)", () => {
  const received: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push(
        request.headers["content-encoding"] === "gzip"
          ? gunzipSync(body).toString("utf8")
          : body.toString("utf8"),
      );
      response.writeHead(200).end("{}");
    });
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  it("is off without a DSN, and sends only the scrubbed error kind and location", async () => {
    expect(startErrorReporting({ APP_ENV: "test" }, "api")).toBeUndefined();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    const report = startErrorReporting(
      {
        SENTRY_DSN: `http://public@127.0.0.1:${port}/1`,
        SENTRY_RELEASE: "abc123",
        APP_ENV: "test",
      },
      "api",
    )!;
    expect(report).toBeTypeOf("function");
    class OrderFailure extends Error {
      override name = "OrderFailure";
    }
    report(new OrderFailure("could not reach shopper@example.com at +971500000000"));
    await flushErrorReporting();
    const envelope = received.join("\n");
    expect(envelope).toContain("OrderFailure");
    expect(envelope).toContain("abc123");
    expect(envelope).toContain('"service":"api"');
    for (const secret of ["shopper@example.com", "971500000000"])
      expect(envelope).not.toContain(secret);
  });
});
