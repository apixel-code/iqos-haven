import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { internalRevalidateRequestSchema } from "@ih/contracts";
import { errorSummary } from "@ih/logger";
import type { FastifyReply } from "fastify";
import { createZodDto } from "../http/zod-validation.pipe";
import { InternalService, type InternalRequest } from "../internal/service-auth.guard";
import { CatalogueCacheService } from "./catalogue-cache.service";

class RevalidateDto extends createZodDto(internalRevalidateRequestSchema) {
  declare eventId: string;
}

/**
 * Private cache-owner invalidation (architecture §9/§10). Called by the worker's durable
 * `storefront_revalidate` effect with HMAC service auth; the gateway never routes it. Repeating
 * the call is harmless.
 */
@Controller({ path: "internal", version: "1" })
export class RevalidateController {
  constructor(private readonly cache: CatalogueCacheService) {}

  @Post("revalidate")
  @HttpCode(204)
  @InternalService("worker")
  async revalidate(
    @Body() body: RevalidateDto,
    @Req() request: InternalRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    reply.header("Cache-Control", "no-store");
    try {
      await this.cache.invalidate();
    } catch (error) {
      // The shared store was not told: answer retryable so the effect tries again.
      request.log.warn({ eventId: body.eventId, ...errorSummary(error) }, "revalidate failed");
      reply.header("Retry-After", "5");
      throw new ServiceUnavailableException();
    }
    request.log.info(
      { eventId: body.eventId, service: request.serviceIdentity?.service },
      "catalogue cache invalidated",
    );
  }
}
