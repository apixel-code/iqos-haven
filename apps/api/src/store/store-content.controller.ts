import { Controller, Get, Req, Res, ServiceUnavailableException } from "@nestjs/common";
import { storeHomeResponseSchema } from "@ih/contracts";
import { CacheOverloadedError } from "@ih/platform";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { STORE_CATALOG_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { StoreCatalogService } from "./store-catalog.service";

/**
 * `GET /v1/store/content/home` (roadmap step 98, ADR 0066): the published home sections in one
 * response. Behind the age ticket like the catalogue, limited per address, never cached by the
 * browser or a proxy (the answer depends on the ticket).
 */
@Controller({ path: "store/content", version: "1" })
export class StoreContentController {
  constructor(
    private readonly catalog: StoreCatalogService,
    private readonly limits: RateLimitService,
  ) {}

  @Get("home")
  @AgeVerified()
  @Serialize(storeHomeResponseSchema)
  async home(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      STORE_CATALOG_POLICY,
      { ip: typeof header === "string" && isIP(header) ? header : request.ip },
      request,
      reply,
    );
    try {
      return await this.catalog.home();
    } catch (error) {
      if (error instanceof CacheOverloadedError) {
        reply.header("Retry-After", "2");
        throw new ServiceUnavailableException();
      }
      throw error;
    }
  }
}
