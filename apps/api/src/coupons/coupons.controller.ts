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
  type CouponCreateRequest,
  type CouponUpdateRequest,
  type CouponsQuery,
  couponCreateRequestSchema,
  couponParamsSchema,
  couponResponseSchema,
  couponsQuerySchema,
  couponsResponseSchema,
  couponStateRequestSchema,
  couponUpdateRequestSchema,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { isIP } from "node:net";
import { createZodDto } from "../http/zod-validation.pipe";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { RateLimitService } from "../security/rate-limit.service";
import { COUPONS_MANAGE_POLICY } from "../security/limit-policies";
import { CouponsService } from "./coupons.service";
class CreateDto extends createZodDto(couponCreateRequestSchema) {
  declare code: CouponCreateRequest["code"];
  declare percentBps: number;
  declare minSubtotalFils: number;
  declare startsAt: string | null;
  declare expiresAt: string | null;
  declare active: boolean;
  declare usageLimit: number | null;
}
class UpdateDto extends createZodDto(couponUpdateRequestSchema) {
  declare version: CouponUpdateRequest["version"];
  declare percentBps: number;
  declare minSubtotalFils: number;
  declare startsAt: string | null;
  declare expiresAt: string | null;
  declare active: boolean;
  declare usageLimit: number | null;
}
class StateDto extends createZodDto(couponStateRequestSchema) {
  declare version: number;
}
class QueryDto extends createZodDto(couponsQuerySchema) {
  declare limit: number;
  declare after?: CouponsQuery["after"];
  declare trashed: boolean;
}
class ParamsDto extends createZodDto(couponParamsSchema) {
  declare id: string;
}
/** Owner coupon administration (step 69). Percentage coupons only; nothing is hard-deleted. */
@Controller({ path: "admin/coupons", version: "1" })
@RequirePermission("coupons.manage")
export class AdminCouponsController {
  constructor(
    private readonly coupons: CouponsService,
    private readonly limits: RateLimitService,
  ) {}
  private async mutation(request: AuthenticatedRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      COUPONS_MANAGE_POLICY,
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
  @Serialize(couponsResponseSchema)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.coupons.list(request.staff!.userId, query as unknown as CouponsQuery);
  }
  @Post()
  @HttpCode(201)
  @Serialize(couponResponseSchema)
  async create(
    @Body() body: CreateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.coupons.create(await this.mutation(request, reply), body);
  }
  @Patch(":id")
  @Serialize(couponResponseSchema)
  async update(
    @Param() params: ParamsDto,
    @Body() body: UpdateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.coupons.update(await this.mutation(request, reply), params.id, body);
  }
  @Post(":id/trash")
  @HttpCode(200)
  @Serialize(couponResponseSchema)
  async trash(
    @Param() params: ParamsDto,
    @Body() body: StateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.coupons.trash(await this.mutation(request, reply), params.id, body);
  }
  @Post(":id/restore")
  @HttpCode(200)
  @Serialize(couponResponseSchema)
  async restore(
    @Param() params: ParamsDto,
    @Body() body: StateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.coupons.restore(await this.mutation(request, reply), params.id, body);
  }
}
