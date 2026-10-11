import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type { ProductCreateRequest, ProductsQuery, ProductUpdateRequest } from "@ih/contracts";
import {
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueNotFoundError,
  createProduct,
  listProducts,
  readProduct,
  updateProduct,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";

@Injectable()
export class ProductsService {
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
  list(actor: string, query: ProductsQuery) {
    return this.execute(() => listProducts(this.db, actor, query));
  }
  read(actor: string, id: string) {
    return this.execute(() => readProduct(this.db, actor, id));
  }
  create(context: CommandContext, input: ProductCreateRequest) {
    return this.execute(() => createProduct(this.db, context, input));
  }
  update(context: CommandContext, id: string, input: ProductUpdateRequest) {
    return this.execute(() => updateProduct(this.db, context, id, input));
  }
}
