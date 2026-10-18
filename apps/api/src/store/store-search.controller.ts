import { BadRequestException, Controller, Get, Inject, Query, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  storeSearchQuerySchema,
  storeSearchResponseSchema,
  storeSuggestQuerySchema,
  storeSuggestResponseSchema,
  type StoreSearchQuery,
  type StoreSearchResponse,
  type StoreSuggestResponse,
} from "@ih/contracts";
import {
  assertStoreSearchCursor,
  StoreCursorError,
  suggestStoreSearch,
  type Database,
} from "@ih/db";
import type { EndpointLimitPolicy } from "@ih/platform";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";
import {
  STORE_CATALOG_POLICY,
  STORE_SEARCH_POLICY,
  STORE_SUGGEST_POLICY,
} from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { StoreCatalogService } from "./store-catalog.service";

class SearchQueryDto extends createZodDto(storeSearchQuerySchema) {}
class SuggestQueryDto extends createZodDto(storeSuggestQuerySchema) {
  declare q: string;
}

/**
 * Gated search, facets and suggestions (roadmap step 60, ADR 0029). Same controls as the other
 * store reads: age ticket, per-address limit, `private, no-store`, contract-only responses.
 * Results for a typed term are not cached: the text is free-form, so a cache would only hold
 * other people's typos. Without a term this is browsing (the listing pages' filters, parity
 * G-S2, ADR 0086): it has the catalogue's budget and cache.
 */
@Controller({ path: "store/search", version: "1" })
export class StoreSearchController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly catalog: StoreCatalogService,
    private readonly limits: RateLimitService,
  ) {}

  private async guard(
    policy: EndpointLimitPolicy<"ip">,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      policy,
      { ip: typeof header === "string" && isIP(header) ? header : request.ip },
      request,
      reply,
    );
  }

  @Get()
  @AgeVerified()
  @Serialize(storeSearchResponseSchema)
  async search(
    @Query() raw: SearchQueryDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StoreSearchResponse> {
    const query = raw as unknown as StoreSearchQuery;
    const browsing = !query.q?.trim();
    await this.guard(browsing ? STORE_CATALOG_POLICY : STORE_SEARCH_POLICY, request, reply);
    try {
      // Refuse a malformed cursor before any query runs.
      assertStoreSearchCursor(query);
      return browsing ? await this.catalog.browse(query) : await this.catalog.loadSearch(query);
    } catch (error) {
      if (error instanceof StoreCursorError) throw new BadRequestException();
      throw error;
    }
  }

  @Get("suggest")
  @AgeVerified()
  @Serialize(storeSuggestResponseSchema)
  async suggest(
    @Query() query: SuggestQueryDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StoreSuggestResponse> {
    await this.guard(STORE_SUGGEST_POLICY, request, reply);
    return suggestStoreSearch(this.db, query.q);
  }
}
