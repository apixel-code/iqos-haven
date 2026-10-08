import "reflect-metadata";
import { Body, Controller, Post, Get, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiErrorFilter } from "./error.filter";
import { createZodDto, ZodValidationPipe } from "./zod-validation.pipe";
import { requestId } from "./request-id";
import type { ErrorEnvelope } from "@ih/contracts";
class Input extends createZodDto(z.object({ quantity: z.number().int().min(1).max(10) })) {}
@Controller("probe")
class ProbeController {
  @Post() create(@Body() input: Input) {
    return input;
  }
  @Post("missing-contract") missing(@Body() input: object) {
    return input;
  }
  @Get("error") error() {
    throw new Error("SQL_SECRET postgres://PASSWORD_SECRET");
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}
describe("HTTP contract and error privacy", () => {
  let app: INestApplication;
  let base: string;
  beforeAll(async () => {
    app = await NestFactory.create(
      ProbeModule,
      new FastifyAdapter({ bodyLimit: 128, genReqId: requestId }),
      { logger: false },
    );
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(new ApiErrorFilter());
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
  });
  it("validates bounded input and rejects unknown fields", async () => {
    const valid = await fetch(base + "/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 2 }),
    });
    expect(valid.status).toBe(201);
    for (const body of [{ quantity: 0 }, { quantity: 2, extra: true }]) {
      const response = await fetch(base + "/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_ERROR");
    }
  });
  it("does not expose SQL, internal errors or missing DTO details", async () => {
    const response = await fetch(base + "/probe/error", {
      headers: { "x-request-id": "request-1234" },
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("SECRET");
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).toContain("request-1234");
    const missing = await fetch(base + "/probe/missing-contract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(500);
  });
  it("bounds request bodies and rejects malformed JSON without reflecting input", async () => {
    const oversized = await fetch(base + "/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 2, secret: "PRIVATE".repeat(40) }),
    });
    expect(oversized.status).toBe(413);
    const oversizedText = await oversized.text();
    expect(oversizedText).not.toContain("PRIVATE");
    expect(JSON.parse(oversizedText).error.requestId).toBeTruthy();
    const malformed = await fetch(base + "/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"quantity":PRIVATE}',
    });
    expect(malformed.status).toBe(400);
    const malformedText = await malformed.text();
    expect(malformedText).not.toContain("PRIVATE");
    expect(JSON.parse(malformedText).error.fields).toEqual([]);
  });
  it("returns a standard not-found envelope", async () => {
    const response = await fetch(base + "/absent");
    expect(response.status).toBe(404);
    const data = (await response.json()) as ErrorEnvelope;
    expect(data.error.code).toBe("NOT_FOUND");
    expect(data.error.requestId).toBeTruthy();
  });
});
