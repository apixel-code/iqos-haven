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
  downloadStreamedReport,
  listReportJobs,
  readReportJob,
  ReportConflictError,
  ReportForbiddenError,
  ReportNotAvailableError,
  ReportNotFoundError,
  ReportTooLargeError,
  requestReport,
  type Database,
} from "@ih/db";
import { MetricRangeError } from "@ih/domain";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { NoResponseBody, Serialize } from "../auth/serialize";
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
    if (error instanceof ReportNotAvailableError)
      throw new ConflictException({ code: "REPORT_NOT_AVAILABLE" });
    if (error instanceof ReportTooLargeError)
      throw new ConflictException({ code: "REPORT_TOO_LARGE" });
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
 * A streamed report is generated on download (step 111); built files arrive in step 112.
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

  /**
   * `GET /v1/admin/reports/:id/download` (step 111, ADR 0077): a streamed report as CSV. The
   * database read re-checks the requester, the job's required rights and its expiry, and
   * audits the download before a byte is sent. Never cached.
   */
  @Get(":id/download")
  @RequirePermission("reports.export")
  @NoResponseBody()
  async download(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res() reply: FastifyReply,
  ) {
    const file = await run(() =>
      downloadStreamedReport(
        this.db,
        { requestId: request.id, actorId: request.staff!.userId },
        params.id,
      ),
    );
    await reply
      .status(200)
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${file.fileName}"`)
      .header("Cache-Control", "private, no-store")
      .header("Vary", "Cookie")
      .header("X-Content-Type-Options", "nosniff")
      .send(file.text);
  }
}
