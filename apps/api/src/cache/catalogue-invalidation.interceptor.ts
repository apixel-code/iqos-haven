import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { finalize, type Observable } from "rxjs";
import { CatalogueCacheService } from "./catalogue-cache.service";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Put on every admin controller that changes catalogue data. After a mutating handler settles
 * (its transaction has committed or rolled back) the local cache is dropped. Failures invalidate
 * too: a handler may fail after its commit, and an extra miss is harmless.
 */
@Injectable()
export class CatalogueInvalidationInterceptor implements NestInterceptor {
  constructor(private readonly cache: CatalogueCacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { method } = context.switchToHttp().getRequest<FastifyRequest>();
    if (READS.has(method)) return next.handle();
    return next.handle().pipe(finalize(() => this.cache.invalidateAfterCommit()));
  }
}
