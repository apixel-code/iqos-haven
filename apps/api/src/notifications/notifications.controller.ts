import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import {
  inboxQuerySchema,
  inboxResponseSchema,
  notificationParamsSchema,
  notificationReadResponseSchema,
  notificationsReadAllRequestSchema,
  notificationsReadAllResponseSchema,
  type InboxQuery,
} from "@ih/contracts";
import {
  InboxForbiddenError,
  InboxNotFoundError,
  listInbox,
  markInboxReadUpTo,
  markNotificationRead,
  type Database,
} from "@ih/db";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";

class QueryDto extends createZodDto(inboxQuerySchema) {}
class ParamsDto extends createZodDto(notificationParamsSchema) {
  declare id: string;
}
class ReadAllDto extends createZodDto(notificationsReadAllRequestSchema) {
  declare upTo: string;
}
async function inbox<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InboxForbiddenError) throw new ForbiddenException();
    if (error instanceof InboxNotFoundError) throw new NotFoundException();
    throw error;
  }
}

/**
 * The signed-in user's own notification inbox (roadmap step 91, ADR 0059). Reading changes only
 * that user's receipt. `notifications.read_own`; each type is shown only to users who hold its
 * permission now.
 */
@Controller({ path: "admin/notifications", version: "1" })
@RequirePermission("notifications.read_own")
export class NotificationsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Serialize(inboxResponseSchema)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    const input = query as unknown as InboxQuery;
    return inbox(() =>
      listInbox(this.db, request.staff!.userId, {
        limit: input.limit,
        after: input.after,
        unread: input.unread === "true",
      }),
    );
  }

  @Post("read-all")
  @HttpCode(200)
  @Serialize(notificationsReadAllResponseSchema)
  readAll(@Body() body: ReadAllDto, @Req() request: AuthenticatedRequest) {
    return inbox(() => markInboxReadUpTo(this.db, request.staff!.userId, body.upTo));
  }

  @Post(":id/read")
  @HttpCode(200)
  @Serialize(notificationReadResponseSchema)
  read(@Param() params: ParamsDto, @Req() request: AuthenticatedRequest) {
    return inbox(() => markNotificationRead(this.db, request.staff!.userId, params.id));
  }
}
