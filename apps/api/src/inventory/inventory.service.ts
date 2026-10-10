import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type { InventoryQuery, StockAdjustmentRequest, StockMovementsQuery } from "@ih/contracts";
import {
  adjustStock,
  CatalogueConflictError,
  CatalogueForbiddenError,
  CatalogueNotFoundError,
  listInventory,
  listStockMovements,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";

@Injectable()
export class InventoryService {
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
  list(actor: string, query: InventoryQuery) {
    return this.execute(() => listInventory(this.db, actor, query));
  }
  movements(actor: string, variantId: string, query: StockMovementsQuery) {
    return this.execute(() => listStockMovements(this.db, actor, variantId, query));
  }
  adjust(context: CommandContext, variantId: string, input: StockAdjustmentRequest) {
    return this.execute(() => adjustStock(this.db, context, variantId, input));
  }
}
