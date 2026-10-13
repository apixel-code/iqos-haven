import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AdminOrdersQuery } from "@ih/contracts";
import {
  listAdminOrders,
  OrderCursorError,
  AdminOrderNotFoundError,
  OrderReadForbiddenError,
  readAdminOrder,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";

@Injectable()
export class AdminOrdersService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async execute<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OrderReadForbiddenError) throw new ForbiddenException();
      if (error instanceof AdminOrderNotFoundError) throw new NotFoundException();
      if (error instanceof OrderCursorError) throw new BadRequestException();
      throw error;
    }
  }

  list(actorId: string, query: AdminOrdersQuery) {
    return this.execute(() => listAdminOrders(this.db, actorId, query));
  }

  find(actorId: string, orderId: string) {
    return this.execute(() => readAdminOrder(this.db, actorId, orderId));
  }
}
