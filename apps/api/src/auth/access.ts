import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { AGE_VERIFICATION_REQUIRED } from "@ih/contracts";
import type { AuthenticatedStaff } from "@ih/db";
import { PERMISSION_KEYS, type PermissionKey } from "@ih/domain";
import type { FastifyRequest } from "fastify";
import { AgeTicketVerifier } from "./age";
import { AuthService } from "./auth.service";
import { SERIALIZE } from "./serialize";
import { readSessionToken } from "./session-cookie";

export type AuthenticatedRequest = FastifyRequest & { staff?: AuthenticatedStaff };
/** Set on store routes once the age ticket verified: the affirmed policy and its expiry. */
export type AgeVerifiedRequest = FastifyRequest & {
  ageTicket?: { readonly policyVersion: string; readonly expiresAt: Date };
};

/**
 * Route access policy (architecture §11, apps/api/CLAUDE.md). Deny by default: every route must
 * declare exactly how it is reached, or the application refuses to start, and the global
 * AccessGuard rejects it at runtime as a second line.
 *
 * - `@Public()` — no admin session (health probes, sign-in/out).
 * - `@InternalService(...)` — HMAC service auth, enforced by ServiceAuthGuard.
 * - `@AgeVerified()` — shopper routes exposing product data or checkout: a valid age ticket
 *   (`AgeGuard` behaviour). No staff session is read; an admin cookie never substitutes.
 * - `@Authenticated()` — any signed-in, active staff member (e.g. /me).
 * - `@RequirePermission(...keys)` — signed in AND holding every listed permission.
 *
 * Permissions come from the database on every request (role → role_permissions), never from
 * the client or the UI. A handler-level policy overrides a controller-level one.
 */
export type AccessPolicy =
  | { readonly kind: "public" }
  | { readonly kind: "internal" }
  | { readonly kind: "store" }
  | { readonly kind: "authenticated" }
  | { readonly kind: "permission"; readonly permissions: readonly PermissionKey[] };

export const ACCESS_POLICY = "ih:access-policy";

export const Public = () => SetMetadata(ACCESS_POLICY, { kind: "public" } satisfies AccessPolicy);
export const AgeVerified = () =>
  SetMetadata(ACCESS_POLICY, { kind: "store" } satisfies AccessPolicy);
export const Authenticated = () =>
  SetMetadata(ACCESS_POLICY, { kind: "authenticated" } satisfies AccessPolicy);
/** Used by `@InternalService`; not for direct use. */
export const InternalAccess = () =>
  SetMetadata(ACCESS_POLICY, { kind: "internal" } satisfies AccessPolicy);

export const RequirePermission = (first: PermissionKey, ...rest: PermissionKey[]) => {
  const permissions = [first, ...rest];
  // Keys are typed, but a cast or a stale catalogue must still fail at startup, not open a route.
  for (const key of permissions)
    if (!PERMISSION_KEYS.includes(key)) throw new Error(`Unknown permission "${String(key)}"`);
  return SetMetadata(ACCESS_POLICY, { kind: "permission", permissions } satisfies AccessPolicy);
};

function policyOf(
  reflector: Reflector,
  targets: Parameters<Reflector["getAllAndOverride"]>[1],
): AccessPolicy | undefined {
  return reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, targets);
}

/** Global guard (APP_GUARD): authentication + permission check for every route. */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly age: AgeTicketVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return false;
    const policy = policyOf(this.reflector, [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!policy) {
      // Unreachable while the startup check runs; never fail open if it is ever bypassed.
      request.log?.error(
        { route: request.routeOptions?.url },
        "route without access policy denied",
      );
      throw new ForbiddenException();
    }
    // Internal routes are authenticated by ServiceAuthGuard (route-level, runs after this one).
    if (policy.kind === "public" || policy.kind === "internal") return true;
    if (policy.kind === "store") {
      const result = this.age.verify(request.headers.cookie);
      if (!result.ok) {
        // Reason code only; the ticket itself is never logged. Debug level: any anonymous
        // visitor produces this, so it must not be able to flood the logs.
        request.log.debug({ reason: result.reason }, "age ticket refused");
        throw new ForbiddenException({ code: AGE_VERIFICATION_REQUIRED });
      }
      (request as AgeVerifiedRequest).ageTicket = {
        policyVersion: result.claims.pol,
        expiresAt: new Date(result.claims.exp * 1000),
      };
      return true;
    }

    const token = readSessionToken(request.headers.cookie);
    const staff = token ? await this.auth.authenticate(token) : null;
    if (!staff) throw new UnauthorizedException();
    request.staff = staff;
    if (policy.kind === "authenticated") return true;

    const missing = policy.permissions.filter((key) => !staff.permissions.includes(key));
    if (missing.length) {
      request.log.warn(
        { staffId: staff.userId, role: staff.role, missing, route: request.routeOptions.url },
        "permission denied",
      );
      throw new ForbiddenException();
    }
    return true;
  }
}

/**
 * Refuses to start the API when a route could fail open: no access policy, a class-wide
 * `@Public`/`@Authenticated` (a later handler would silently inherit it), or a signed-in route
 * whose response is not filtered by `@Serialize` (or declared empty with `@NoResponseBody`).
 */
@Injectable()
export class AccessPolicyCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const problems = routeAccessProblems(this.discovery, this.scanner, this.reflector);
    if (problems.length)
      throw new Error(`Unsafe route access declarations (deny by default): ${problems.join("; ")}`);
  }
}

export function routeAccessProblems(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  reflector: Reflector,
): string[] {
  const problems: string[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const classPolicy = reflector.get<AccessPolicy | undefined>(ACCESS_POLICY, metatype);
    if (
      classPolicy?.kind === "public" ||
      classPolicy?.kind === "authenticated" ||
      classPolicy?.kind === "store"
    )
      problems.push(`${metatype.name}: @${classPolicy.kind} must be declared per handler`);
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as (...args: unknown[]) => unknown;
      if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
      if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
      const route = `${metatype.name}.${name}`;
      const policy = policyOf(reflector, [handler, metatype]);
      if (!policy) problems.push(`${route}: no access policy`);
      else if (
        (policy.kind === "authenticated" ||
          policy.kind === "permission" ||
          policy.kind === "store") &&
        !reflector.getAllAndOverride(SERIALIZE, [handler, metatype])
      )
        problems.push(
          `${route}: ${policy.kind === "store" ? "store" : "signed-in"} route without @Serialize or @NoResponseBody`,
        );
    }
  }
  return problems;
}
