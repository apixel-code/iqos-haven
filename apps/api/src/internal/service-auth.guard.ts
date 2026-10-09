import {
  applyDecorators,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiEnv } from "@ih/config";
import { createLogger } from "@ih/logger";
import { verifyServiceRequest, type NonceStore } from "@ih/platform";
import type { FastifyRequest } from "fastify";
import { InternalAccess } from "../auth/access";
import { API_ENV } from "../infra/tokens";

export const NONCE_STORE = Symbol("NONCE_STORE");
const INTERNAL_SERVICES = "ih:internal-services";

/** Identity of the verified calling service, attached to the request. */
export interface ServiceIdentity {
  readonly service: string;
  readonly keyId: string;
}
export type InternalRequest = FastifyRequest & {
  rawBody?: Buffer;
  serviceIdentity?: ServiceIdentity;
};

/**
 * Marks a route as internal: only the listed services, with a valid HMAC signature
 * (@ih/platform service auth), may call it. Admin/shopper cookies are never accepted here.
 */
export const InternalService = (...services: string[]) =>
  applyDecorators(
    SetMetadata(INTERNAL_SERVICES, services),
    InternalAccess(),
    UseGuards(ServiceAuthGuard),
  );

@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly log;

  constructor(
    private readonly reflector: Reflector,
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(NONCE_STORE) private readonly nonces: NonceStore,
  ) {
    this.log = createLogger({ service: "api-internal-auth", level: env.LOG_LEVEL });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const allowed =
      this.reflector.getAllAndOverride<string[]>(INTERNAL_SERVICES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    const request = context.switchToHttp().getRequest<InternalRequest>();
    // The body is part of the signature. If a body was sent but its raw bytes were not captured
    // (unparsed content type, rawBody disabled), refuse rather than verify it as empty.
    const hasBody =
      Number(request.headers["content-length"] ?? 0) > 0 ||
      request.headers["transfer-encoding"] !== undefined;
    const result = !allowed.length
      ? ({ ok: false, reason: "SERVICE_NOT_ALLOWED" } as const)
      : hasBody && request.rawBody === undefined
        ? ({ ok: false, reason: "BAD_SIGNATURE" } as const)
        : await verifyServiceRequest(
            {
              method: request.method,
              path: request.url,
              body: request.rawBody,
              headers: request.headers,
            },
            { keys: this.env.INTERNAL_SERVICE_KEYS, allowedServices: allowed, nonces: this.nonces },
          );
    if (!result.ok) {
      // Reason code only: never headers, signatures or keys.
      this.log.warn({ reason: result.reason, requestId: request.id }, "internal request rejected");
      throw new UnauthorizedException();
    }
    request.serviceIdentity = { service: result.service, keyId: result.keyId };
    return true;
  }
}
