import {
  applyDecorators,
  HttpCode,
  Injectable,
  InternalServerErrorException,
  SetMetadata,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  fieldPolicyPermissions,
  filterFields,
  PERMISSION_KEYS,
  type FieldPolicy,
} from "@ih/domain";
import { map, type Observable } from "rxjs";
import type { z } from "zod";
import type { AuthenticatedRequest } from "./access";

export const SERIALIZE = "ih:serialize";
type SerializeOptions =
  { readonly schema: z.ZodType; readonly fields?: FieldPolicy } | { readonly empty: true };

/**
 * Response serializer: first removes the fields the caller's permissions do not cover (field
 * policy), then parses the result with the response contract so only contract fields leave the
 * API. A contract violation is a server bug: it is logged by path and answered with a generic 500,
 * never by sending the unvalidated value. Owner-only fields must be optional in the contract.
 * Without a signed-in caller every policy field is removed (fail closed).
 */
export const Serialize = (schema: z.ZodType, fields?: FieldPolicy) => {
  for (const key of fields ? fieldPolicyPermissions(fields) : [])
    if (!PERMISSION_KEYS.includes(key)) throw new Error(`Unknown permission "${String(key)}"`);
  return applyDecorators(
    SetMetadata(SERIALIZE, { schema, fields } satisfies SerializeOptions),
    UseInterceptors(SerializeInterceptor),
  );
};

/** A signed-in route that answers 204 with no body; anything the handler returns is dropped. */
export const NoResponseBody = () =>
  applyDecorators(
    HttpCode(204),
    SetMetadata(SERIALIZE, { empty: true } satisfies SerializeOptions),
    UseInterceptors(SerializeInterceptor),
  );

@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<SerializeOptions | undefined>(SERIALIZE, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Startup invariant (AccessPolicyCheck); kept as a fail-closed backstop.
    if (!options) throw new InternalServerErrorException("Missing response contract");
    if ("empty" in options) return next.handle().pipe(map(() => undefined));
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return next.handle().pipe(
      map((value: unknown) => {
        const visible = options.fields
          ? filterFields(value, options.fields, new Set(request.staff?.permissions ?? []))
          : value;
        const parsed = options.schema.safeParse(visible);
        if (parsed.success) return parsed.data;
        request.log.error(
          { paths: parsed.error.issues.slice(0, 20).map((issue) => issue.path.join(".")) },
          "response contract violation",
        );
        throw new InternalServerErrorException();
      }),
    );
  }
}
