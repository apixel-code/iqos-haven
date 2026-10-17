import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  adminCustomerParamsSchema,
  adminCustomerResponseSchema,
  adminCustomersQuerySchema,
  adminCustomersResponseSchema,
  orderWhatsappResponseSchema,
  type AdminCustomersQuery,
} from "@ih/contracts";
import {
  AdminCustomerNotFoundError,
  CustomerCursorError,
  CustomerReadForbiddenError,
  listAdminCustomers,
  orderWhatsappLinks,
  readAdminCustomer,
  type Database,
} from "@ih/db";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";

class ParamsDto extends createZodDto(adminCustomerParamsSchema) {
  declare id: string;
}
class QueryDto extends createZodDto(adminCustomersQuerySchema) {}

async function read<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CustomerReadForbiddenError) throw new ForbiddenException();
    if (error instanceof AdminCustomerNotFoundError) throw new NotFoundException();
    if (error instanceof CustomerCursorError) throw new BadRequestException();
    throw error;
  }
}
const privateRead = (reply: FastifyReply) =>
  reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");

/**
 * Admin customers (roadmap step 90, ADR 0058): phone-grouped customers with their orders.
 * `customers.read`; spend only with `customers.financial_read` (decided per request).
 */
@Controller({ path: "admin/customers", version: "1" })
@RequirePermission("customers.read")
export class AdminCustomersController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Serialize(adminCustomersResponseSchema)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    privateRead(reply);
    return read(() =>
      listAdminCustomers(this.db, request.staff!.userId, query as unknown as AdminCustomersQuery),
    );
  }

  @Get(":id")
  @Serialize(adminCustomerResponseSchema)
  find(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    privateRead(reply);
    return read(() => readAdminCustomer(this.db, request.staff!.userId, params.id));
  }
}

/** `GET /v1/admin/orders/:id/whatsapp`: message links for staff to send themselves. */
@Controller({ path: "admin/orders", version: "1" })
@RequirePermission("customers.read", "orders.read")
export class OrderWhatsappController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get(":id/whatsapp")
  @Serialize(orderWhatsappResponseSchema)
  links(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    privateRead(reply);
    return read(() => orderWhatsappLinks(this.db, request.staff!.userId, params.id));
  }
}
