import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type {
  CategoryCreateRequest,
  CategoriesQuery,
  CategoryStateRequest,
  CategoryUpdateRequest,
} from "@ih/contracts";
import {
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueInUseError,
  CatalogueNotFoundError,
  createCategory,
  listCategories,
  readCategory,
  restoreCategory,
  trashCategory,
  updateCategory,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";

@Injectable()
export class CategoriesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
  list(actor: string, query: CategoriesQuery) {
    return this.execute(() => listCategories(this.db, actor, query));
  }
  read(actor: string, id: string) {
    return this.execute(() => readCategory(this.db, actor, id));
  }
  create(context: CommandContext, input: CategoryCreateRequest) {
    return this.execute(() => createCategory(this.db, context, input));
  }
  update(context: CommandContext, id: string, input: CategoryUpdateRequest) {
    return this.execute(() => updateCategory(this.db, context, id, input));
  }
  trash(context: CommandContext, id: string, input: CategoryStateRequest) {
    return this.execute(() => trashCategory(this.db, context, id, input));
  }
  restore(context: CommandContext, id: string, input: CategoryStateRequest) {
    return this.execute(() => restoreCategory(this.db, context, id, input));
  }
}
