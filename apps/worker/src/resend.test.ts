import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PermanentEffectError, type EmailMessage } from "@ih/application";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EmailProviderTransientError, ResendEmailAdapter } from "./email";

/** Local stand-in for api.resend.com that mimics its idempotency behaviour. */
interface Seen {
  key: string | undefined;
  auth: string | undefined;
  body: Array<{ from: string; to: string[]; bcc?: unknown; headers: Record<string, string> }>;
}
const seen: Seen[] = [];
const idempotency = new Map<string, string>();
let nextStatus: { status: number; name: string } | undefined;
let server: Server;
let apiUrl: string;

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });

const message = (bcc: string[]): EmailMessage => ({
  deliveryKey: "email-" + "a".repeat(40),
  from: "orders@iqoshaven.com",
  bcc,
  subject: "New order",
  text: "text",
  html: "<p>html</p>",
});
const signal = () => new AbortController().signal;
const adapter = () => new ResendEmailAdapter({ apiKey: "re_test_1234567890", apiUrl });

describe("ResendEmailAdapter (local stub)", () => {
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const raw = await read(req);
      const key = req.headers["idempotency-key"] as string | undefined;
      seen.push({ key, auth: req.headers.authorization, body: JSON.parse(raw) });
      if (nextStatus) {
        const { status, name } = nextStatus;
        nextStatus = undefined;
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ statusCode: status, name, message: "to: someone@example.com" }),
        );
      }
      // Same key + same payload → same response without "sending" again.
      const previous = key ? idempotency.get(key) : undefined;
      if (previous && previous !== raw) {
        res.writeHead(409, { "content-type": "application/json" });
        return res.end(JSON.stringify({ statusCode: 409, name: "invalid_idempotent_request" }));
      }
      if (key) idempotency.set(key, raw);
      const body = JSON.parse(raw) as unknown[];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: body.map((_, i) => ({ id: `${key}-msg-${i}` })) }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    seen.length = 0;
    idempotency.clear();
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends one email per recipient, without Bcc, keyed by the delivery key", async () => {
    const result = await adapter().send(message(["a@x.ae", "b@x.ae"]), signal());
    expect(result).toMatchObject({ accepted: 2, rejected: 0 });
    expect(result.receipt).toMatch(/^resend:email-a{40}-msg-0\+1$/);
    const [request] = seen;
    expect(request!.key).toBe("email-" + "a".repeat(40));
    expect(request!.auth).toBe("Bearer re_test_1234567890");
    expect(request!.body.map((email) => email.to)).toEqual([["a@x.ae"], ["b@x.ae"]]);
    expect(request!.body.every((email) => email.bcc === undefined)).toBe(true);
    expect(request!.body[0]!.headers["X-IH-Delivery-Key"]).toBe("email-" + "a".repeat(40));
  });

  it("repeats the identical request on retry so the provider can de-duplicate", async () => {
    await adapter().send(message(["a@x.ae"]), signal());
    await adapter().send(message(["a@x.ae"]), signal());
    expect(seen).toHaveLength(2);
    expect(seen[0]!.key).toBe(seen[1]!.key);
    expect(JSON.stringify(seen[0]!.body)).toBe(JSON.stringify(seen[1]!.body));
  });

  it("sends an identical request whatever order the planner returns recipients in", async () => {
    await adapter().send(message(["b@x.ae", "a@x.ae"]), signal());
    await adapter().send(message(["a@x.ae", "b@x.ae"]), signal());
    expect(JSON.stringify(seen[0]!.body)).toBe(JSON.stringify(seen[1]!.body));
  });

  it("retries an incomplete success body instead of treating it as a rejection", async () => {
    nextStatus = { status: 200, name: "" };
    await expect(adapter().send(message(["a@x.ae"]), signal())).rejects.toMatchObject({
      code: "RESEND_BAD_BODY",
    });
  });

  it("splits more than 100 recipients into stable, distinctly keyed batches", async () => {
    const recipients = Array.from({ length: 150 }, (_, i) => `r${i}@x.ae`);
    const result = await adapter().send(message(recipients), signal());
    expect(result.accepted).toBe(150);
    expect(seen.map((request) => [request.key, request.body.length])).toEqual([
      ["email-" + "a".repeat(40) + "-0", 100],
      ["email-" + "a".repeat(40) + "-1", 50],
    ]);
  });

  it.each([
    [422, "validation_error", PermanentEffectError, "RESEND_422"],
    [400, "validation_error", PermanentEffectError, "RESEND_400"],
    [409, "invalid_idempotent_request", PermanentEffectError, "IDEMPOTENCY_CONFLICT"],
    [409, "concurrent_idempotent_requests", EmailProviderTransientError, "RESEND_409"],
    [429, "rate_limit_exceeded", EmailProviderTransientError, "RESEND_429"],
    [403, "validation_error", EmailProviderTransientError, "RESEND_403"],
    [401, "missing_api_key", EmailProviderTransientError, "RESEND_401"],
    [500, "application_error", EmailProviderTransientError, "RESEND_500"],
  ])("classifies HTTP %i %s", async (status, name, type, code) => {
    nextStatus = { status, name };
    const error = await adapter()
      .send(message(["a@x.ae"]), signal())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ code });
    // The provider's message (which may echo addresses) is never carried along.
    expect(String((error as Error).message)).not.toContain("@");
  });

  it("aborts when the effect lease is lost", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(adapter().send(message(["a@x.ae"]), controller.signal)).rejects.toThrow();
  });
});
