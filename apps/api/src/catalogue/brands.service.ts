import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type {
  BrandCreateRequest,
  BrandsQuery,
  BrandStateRequest,
  BrandUpdateRequest,
} from "@ih/contracts";
import {
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueInUseError,
  CatalogueNotFoundError,
  createBrand,
  listBrands,
  readBrand,
  restoreBrand,
  trashBrand,
  updateBrand,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";

@Injectable()
export class BrandsService {
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
  list(actor: string, query: BrandsQuery) {
    return this.execute(() => listBrands(this.db, actor, query));
  }
  read(actor: string, id: string) {
    return this.execute(() => readBrand(this.db, actor, id));
  }
  create(context: CommandContext, input: BrandCreateRequest) {
    return this.execute(() => createBrand(this.db, context, input));
  }
  update(context: CommandContext, id: string, input: BrandUpdateRequest) {
    return this.execute(() => updateBrand(this.db, context, id, input));
  }
  trash(context: CommandContext, id: string, input: BrandStateRequest) {
    return this.execute(() => trashBrand(this.db, context, id, input));
  }
  restore(context: CommandContext, id: string, input: BrandStateRequest) {
    return this.execute(() => restoreBrand(this.db, context, id, input));
  }
}
