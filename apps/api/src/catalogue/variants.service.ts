import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type {
  ProductOptionsWriteRequest,
  VariantCreateRequest,
  VariantUpdateRequest,
} from "@ih/contracts";
import {
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueNotFoundError,
  createVariant,
  readProductVariants,
  updateVariant,
  writeProductOptions,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";

@Injectable()
export class VariantsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async execute<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CatalogueForbiddenError) throw new ForbiddenException();
      if (error instanceof CatalogueConflictError)
        throw new ConflictException({ code: error.reason });
      if (error instanceof CatalogueNotFoundError) throw new NotFoundException();
      throw error;
    }
  }
  read(actor: string, productId: string) {
    return this.execute(() => readProductVariants(this.db, actor, productId));
  }
  options(context: CommandContext, productId: string, input: ProductOptionsWriteRequest) {
    return this.execute(() => writeProductOptions(this.db, context, productId, input));
  }
  create(context: CommandContext, productId: string, input: VariantCreateRequest) {
    return this.execute(() => createVariant(this.db, context, productId, input));
  }
  update(
    context: CommandContext,
    productId: string,
    variantId: string,
    input: VariantUpdateRequest,
  ) {
    return this.execute(() => updateVariant(this.db, context, productId, variantId, input));
  }
}
