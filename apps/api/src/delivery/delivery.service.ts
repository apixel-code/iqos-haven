import {
  Inject,
  Injectable,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import {
  listDeliveryAreas,
  readDeliveryConfiguration,
  writeDeliveryConfiguration,
  createDeliveryArea,
  updateDeliveryArea,
  DeliveryForbiddenError,
  DeliveryConflictError,
  DeliveryNotFoundError,
  type Database,
} from "@ih/db";
import type {
  DeliveryAreasQuery,
  DeliveryAreaCreateRequest,
  DeliveryAreaUpdateRequest,
  DeliveryConfigurationWriteRequest,
} from "@ih/contracts";
import { DATABASE } from "../infra/tokens";
@Injectable()
export class DeliveryService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private async execute<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DeliveryForbiddenError) throw new ForbiddenException();
      if (error instanceof DeliveryConflictError) throw new ConflictException();
      if (error instanceof DeliveryNotFoundError) throw new NotFoundException();
      throw error;
    }
  }
  list(actor: string, query: DeliveryAreasQuery) {
    return this.execute(() => listDeliveryAreas(this.db, actor, query));
  }
  read(actor: string) {
    return this.execute(() => readDeliveryConfiguration(this.db, actor));
  }
  configure(context: CommandContext, input: DeliveryConfigurationWriteRequest) {
    return this.execute(() => writeDeliveryConfiguration(this.db, context, input));
  }
  create(context: CommandContext, input: DeliveryAreaCreateRequest) {
    return this.execute(() => createDeliveryArea(this.db, context, input));
  }
  update(context: CommandContext, id: string, input: DeliveryAreaUpdateRequest) {
    return this.execute(() => updateDeliveryArea(this.db, context, id, input));
  }
}
