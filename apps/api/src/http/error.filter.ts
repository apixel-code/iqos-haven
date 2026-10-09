import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { TransactionContentionError } from "@ih/db";
import { errorSummary, type Logger } from "@ih/logger";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ErrorEnvelope } from "@ih/contracts";
import { requestId } from "./request-id";
const ERRORS: Record<number, [string, string]> = {
  400: ["VALIDATION_ERROR", "Invalid request"],
  401: ["UNAUTHENTICATED", "Authentication required"],
  403: ["FORBIDDEN", "Permission denied"],
  404: ["NOT_FOUND", "Resource not found"],
  409: ["CONFLICT", "Request conflicts with current state"],
  413: ["PAYLOAD_TOO_LARGE", "Request too large"],
  415: ["UNSUPPORTED_MEDIA_TYPE", "Unsupported request content type"],
  429: ["RATE_LIMITED", "Too many requests"],
  503: ["SERVICE_UNAVAILABLE", "Service temporarily unavailable"],
};
/** The standard envelope for a status, without details (also used by Fastify hooks). */
export function errorEnvelope(status: number, requestId: string): ErrorEnvelope {
  const [code, message] = ERRORS[status] ?? ["INTERNAL_ERROR", "Unexpected server error"];
  return { error: { code, message, requestId, fields: [] } };
}
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly logger?: Pick<Logger, "error">) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const res = http.getResponse<FastifyReply>();
    const id = requestId(req.raw as typeof req.raw & { id?: string });
    const nativeCode =
      error && typeof error === "object" && "code" in error ? error.code : undefined;
    const nativeStatus =
      nativeCode === "FST_ERR_CTP_BODY_TOO_LARGE"
        ? 413
        : ["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"].includes(
              String(nativeCode),
            )
          ? 400
          : nativeCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE"
            ? 415
            : 500;
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : error instanceof TransactionContentionError
          ? 503
          : nativeStatus;
    const [code, message] = ERRORS[status] ?? ["INTERNAL_ERROR", "Unexpected server error"];
    const body: ErrorEnvelope = {
      error: {
        code: error instanceof TransactionContentionError ? error.code : code,
        message,
        requestId: id,
        fields: [],
      },
    };
    // Only our controlled validation details are exposed; other HttpException messages may contain secrets.
    if (error instanceof HttpException && status === 400) {
      const response = error.getResponse();
      if (
        response &&
        typeof response === "object" &&
        "details" in response &&
        Array.isArray(response.details)
      ) {
        body.error.fields = response.details
          .slice(0, 30)
          .filter(
            (item): item is { path: string; message: string } =>
              !!item && typeof item.path === "string" && item.message === "Invalid field",
          )
          .map((item) => ({ path: item.path.slice(0, 200), message: item.message }));
      }
    }
    if (status >= 500)
      (this.logger ?? req.log).error({ requestId: id, ...errorSummary(error) }, "request failed");
    res.header("x-request-id", id).header("cache-control", "no-store").status(status).send(body);
  }
}
