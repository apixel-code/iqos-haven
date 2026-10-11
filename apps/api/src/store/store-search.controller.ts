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
  searchStoreProducts,
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
import { STORE_SEARCH_POLICY, STORE_SUGGEST_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { StoreCatalogService } from "./store-catalog.service";

class SearchQueryDto extends createZodDto(storeSearchQuerySchema) {}
class SuggestQueryDto extends createZodDto(storeSuggestQuerySchema) {
  declare q: string;
}

/**
 * Gated search, facets and suggestions (roadmap step 60, ADR 0029). Same controls as the other
 * store reads: age ticket, per-address limit, `private, no-store`, contract-only responses.
 * Results are not cached: the text is free-form, so a cache would only hold other people's typos.
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
    await this.guard(STORE_SEARCH_POLICY, request, reply);
    const query = raw as unknown as StoreSearchQuery;
    try {
      // Refuse a malformed cursor before any query runs.
      assertStoreSearchCursor(query);
      const { rows, ...result } = await searchStoreProducts(this.db, query);
      return { ...result, items: await Promise.all(rows.map((row) => this.catalog.card(row))) };
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
