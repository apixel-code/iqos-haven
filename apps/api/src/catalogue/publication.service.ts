import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type { ProductStateRequest } from "@ih/contracts";
import {
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueInUseError,
  CatalogueNotFoundError,
  changeProductState,
  productReadiness,
  purgeProduct,
  type Database,
} from "@ih/db";
import { createLogger, errorSummary } from "@ih/logger";
import type { ObjectStorage } from "@ih/platform";
import { DATABASE, OBJECT_STORAGE } from "../infra/tokens";

/** Publication, trash/restore and Owner-only purge (step 51, ADR 0021). */
@Injectable()
export class PublicationService {
  private readonly log = createLogger({ service: "api-publication", level: "info" });
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  private async execute<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CatalogueForbiddenError) throw new ForbiddenException();
      if (error instanceof CatalogueConflictError)
        throw new ConflictException({ code: error.reason });
      if (error instanceof CatalogueInUseError) throw new ConflictException({ code: "IN_USE" });
      if (error instanceof CatalogueNotFoundError) throw new NotFoundException();
      throw error;
    }
  }

  readiness(actor: string, productId: string) {
    return this.execute(() => productReadiness(this.db, actor, productId));
  }
  change(
    context: CommandContext,
    productId: string,
    command: "publish" | "unpublish" | "trash" | "restore",
    input: ProductStateRequest,
  ) {
    return this.execute(() => changeProductState(this.db, context, productId, command, input));
  }
  purge(context: CommandContext, productId: string, input: ProductStateRequest) {
    return this.execute(async () => {
      const keys = await purgeProduct(this.db, context, productId, input);
      // After commit, outside any transaction. Objects are private; a failed delete only leaves
      // an unreachable object behind (bucket lifecycle backstop, BI-06), so it is logged.
      let failed = 0;
      for (const { bucket, key } of keys)
        await this.storage.delete(bucket, key).catch((error: unknown) => {
          failed += 1;
          this.log.warn({ productId, ...errorSummary(error) }, "purged object delete failed");
        });
      return { purged: true as const, storageObjects: keys.length, failedDeletes: failed };
    });
  }
}
