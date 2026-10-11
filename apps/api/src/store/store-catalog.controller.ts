import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { isIP } from "node:net";
import {
  storeBrandsResponseSchema,
  storeCategoriesResponseSchema,
  storeProductParamsSchema,
  storeProductResponseSchema,
  storeProductsQuerySchema,
  storeProductsResponseSchema,
  type StoreProductsQuery,
} from "@ih/contracts";
import { StoreCursorError } from "@ih/db";
import { CacheOverloadedError } from "@ih/platform";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { STORE_CATALOG_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { StoreCatalogService } from "./store-catalog.service";

class ProductsQueryDto extends createZodDto(storeProductsQuerySchema) {}
class ProductParamsDto extends createZodDto(storeProductParamsSchema) {
  declare slug: string;
}

/**
 * Gated catalogue reads for shoppers (roadmap step 58, architecture §10). Every route requires
 * a valid age ticket (`@AgeVerified()`), is limited per client address, answers
 * `private, no-store` and returns only what the response contract lists.
 */
@Controller({ path: "store", version: "1" })
export class StoreCatalogController {
  constructor(
    private readonly catalog: StoreCatalogService,
    private readonly limits: RateLimitService,
  ) {}

  private async read<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    work: () => Promise<T>,
  ): Promise<T> {
    // Set first so limiter and error answers carry it too. The response depends on the cookie.
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      STORE_CATALOG_POLICY,
      { ip: typeof header === "string" && isIP(header) ? header : request.ip },
      request,
      reply,
    );
    try {
      return await work();
    } catch (error) {
      if (error instanceof StoreCursorError) throw new BadRequestException();
      if (error instanceof CacheOverloadedError) {
        // Too many database misses at once: shed load instead of queueing without bound.
        reply.header("Retry-After", "2");
        throw new ServiceUnavailableException();
      }
      throw error;
    }
  }

  @Get("brands")
  @AgeVerified()
  @Serialize(storeBrandsResponseSchema)
  brands(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.read(request, reply, () => this.catalog.brands());
  }

  @Get("categories")
  @AgeVerified()
  @Serialize(storeCategoriesResponseSchema)
  categories(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.read(request, reply, () => this.catalog.categories());
  }

  @Get("products")
  @AgeVerified()
  @Serialize(storeProductsResponseSchema)
  products(
    @Query() query: ProductsQueryDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.read(request, reply, () =>
      this.catalog.products(query as unknown as StoreProductsQuery),
    );
  }

  @Get("products/:slug")
  @AgeVerified()
  @Serialize(storeProductResponseSchema)
  product(
    @Param() params: ProductParamsDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.read(request, reply, async () => {
      const product = await this.catalog.product(params.slug);
      // Unknown, draft, trashed and hidden products all answer the same 404.
      if (!product) throw new NotFoundException();
      return product;
    });
  }
}
