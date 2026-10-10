import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
} from "@nestjs/common";
import {
  type DeliveryAreaCreateRequest,
  type DeliveryAreaUpdateRequest,
  type DeliveryConfigurationWriteRequest,
  type DeliveryAreasQuery,
  deliveryAreaCreateRequestSchema,
  deliveryAreaUpdateRequestSchema,
  deliveryAreaResponseSchema,
  deliveryAreasQuerySchema,
  deliveryAreaParamsSchema,
  deliveryAreasResponseSchema,
  deliveryConfigurationWriteRequestSchema,
  deliveryConfigurationResponseSchema,
  deliveryConfigurationQuerySchema,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { isIP } from "node:net";
import { createZodDto } from "../http/zod-validation.pipe";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { RateLimitService } from "../security/rate-limit.service";
import { DELIVERY_MANAGE_POLICY } from "../security/limit-policies";
import { DeliveryService } from "./delivery.service";
class CreateDto extends createZodDto(deliveryAreaCreateRequestSchema) {
  declare code: DeliveryAreaCreateRequest["code"];
  declare name: string;
  declare active: boolean;
}
class UpdateDto extends createZodDto(deliveryAreaUpdateRequestSchema) {
  declare version: DeliveryAreaUpdateRequest["version"];
  declare name: string;
  declare active: boolean;
}
class ConfigurationDto extends createZodDto(deliveryConfigurationWriteRequestSchema) {
  declare version: number;
  declare value: DeliveryConfigurationWriteRequest["value"];
}
class ConfigurationQueryDto extends createZodDto(deliveryConfigurationQuerySchema) {}
class QueryDto extends createZodDto(deliveryAreasQuerySchema) {
  declare limit: number;
  declare after?: DeliveryAreasQuery["after"];
}
class ParamsDto extends createZodDto(deliveryAreaParamsSchema) {
  declare id: string;
}
@Controller({ path: "admin/delivery-areas", version: "1" })
@RequirePermission("delivery.manage")
export class DeliveryAreasController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly limits: RateLimitService,
  ) {}
  private async mutation(request: AuthenticatedRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      DELIVERY_MANAGE_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    return { requestId: request.id, actorId: request.staff!.userId };
  }
  @Get()
  @Serialize(deliveryAreasResponseSchema)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.delivery.list(request.staff!.userId, query);
  }
  @Get("configuration")
  @Serialize(deliveryConfigurationResponseSchema)
  read(
    @Query() _query: ConfigurationQueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.delivery.read(request.staff!.userId);
  }
  @Patch("configuration")
  @Serialize(deliveryConfigurationResponseSchema)
  async configure(
    @Body() body: ConfigurationDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.delivery.configure(await this.mutation(request, reply), body);
  }
  @Post()
  @HttpCode(201)
  @Serialize(deliveryAreaResponseSchema)
  async create(
    @Body() body: CreateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.delivery.create(await this.mutation(request, reply), body);
  }
  @Patch(":id")
  @Serialize(deliveryAreaResponseSchema)
  async update(
    @Param() params: ParamsDto,
    @Body() body: UpdateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.delivery.update(await this.mutation(request, reply), params.id, body);
  }
}
