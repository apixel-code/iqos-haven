import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  reportJobParamsSchema,
  reportJobSchema,
  reportJobsResponseSchema,
  reportRequestSchema,
  type ReportRequest,
} from "@ih/contracts";
import {
  listReportJobs,
  readReportJob,
  ReportConflictError,
  ReportForbiddenError,
  ReportNotFoundError,
  requestReport,
  type Database,
} from "@ih/db";
import { MetricRangeError } from "@ih/domain";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";

class RequestDto extends createZodDto(reportRequestSchema) {}
class ParamsDto extends createZodDto(reportJobParamsSchema) {
  declare id: string;
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReportForbiddenError) throw new ForbiddenException();
    if (error instanceof ReportNotFoundError) throw new NotFoundException();
    if (error instanceof ReportConflictError)
      throw new ConflictException({ code: "IDEMPOTENCY_CONFLICT" });
    if (error instanceof MetricRangeError) throw new BadRequestException();
    throw error;
  }
}
const privateAnswer = (reply: FastifyReply) =>
  reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");

/**
 * Report requests and their status (roadmap step 110, ADR 0076). Requesting needs
 * `reports.export` (the customers report also `customers.export`, decided by the database
 * read); listing and status need `reports.read` and only ever show the caller's own jobs.
 * Generating (step 111) and downloading (step 112) come later.
 */
@Controller({ path: "admin/reports", version: "1" })
export class AdminReportsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Post()
  @RequirePermission("reports.export")
  @Serialize(reportJobSchema)
  async request(
    @Body() body: RequestDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    privateAnswer(reply);
    const { job, created } = await run(() =>
      requestReport(
        this.db,
        { requestId: request.id, actorId: request.staff!.userId },
        body as unknown as ReportRequest,
      ),
    );
    reply.status(created ? 201 : 200);
    return job;
  }

  @Get()
  @RequirePermission("reports.read")
  @Serialize(reportJobsResponseSchema)
  async list(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    privateAnswer(reply);
    return { items: await run(() => listReportJobs(this.db, request.staff!.userId)) };
  }

  @Get(":id")
  @RequirePermission("reports.read")
  @Serialize(reportJobSchema)
  find(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    privateAnswer(reply);
    return run(() => readReportJob(this.db, request.staff!.userId, params.id));
  }
}
