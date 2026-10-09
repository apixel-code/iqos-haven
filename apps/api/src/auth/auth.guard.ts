import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { AuthenticatedStaff } from "@ih/db";
import type { FastifyRequest } from "fastify";
import { AuthService } from "./auth.service";
import { readSessionToken } from "./session-cookie";

export type AuthenticatedRequest = FastifyRequest & { staff?: AuthenticatedStaff };

/**
 * Admin authentication: a valid, unrevoked, non-idle, non-expired session of an active user,
 * checked on every request. Permission checks are layered on top (step 31).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionToken(request.headers.cookie);
    const staff = token ? await this.auth.authenticate(token) : null;
    if (!staff) throw new UnauthorizedException();
    request.staff = staff;
    return true;
  }
}
