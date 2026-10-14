import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  AdminOrdersQuery,
  OrderCancelRequest,
  OrderCollectionCorrectionRequest,
  OrderCollectionRequest,
  OrderEditRequest,
  OrderTransitionRequest,
} from "@ih/contracts";
import type { CommandContext } from "@ih/application";
import { DeliveryUnavailableError, DeliveryUnconfiguredError } from "@ih/domain";
import {
  listAdminOrders,
  OrderCursorError,
  AdminOrderNotFoundError,
  OrderReadForbiddenError,
  readAdminOrder,
  transitionOrder,
  OrderTransitionConflictError,
  OrderTransitionForbiddenError,
  OrderTransitionNotFoundError,
  editOrder,
  OrderEditConflictError,
  OrderEditForbiddenError,
  OrderEditNotFoundError,
  CouponRejectedError,
  VariantUnavailableError,
  cancelOrder,
  OrderCancelConflictError,
  OrderCancelForbiddenError,
  OrderCancelInvalidError,
  OrderCancelNotFoundError,
  correctCollection,
  OrderCollectionConflictError,
  OrderCollectionForbiddenError,
  OrderCollectionNotFoundError,
  OrderCollectionTimeError,
  recordCollection,
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
      if (error instanceof OrderTransitionForbiddenError) throw new ForbiddenException();
      if (error instanceof OrderTransitionNotFoundError) throw new NotFoundException();
      if (error instanceof OrderTransitionConflictError)
        throw new ConflictException({ code: error.reason });
      if (error instanceof OrderEditForbiddenError) throw new ForbiddenException();
      if (error instanceof OrderEditNotFoundError) throw new NotFoundException();
      if (error instanceof OrderEditConflictError)
        throw new ConflictException({ code: error.reason });
      if (error instanceof OrderCancelForbiddenError) throw new ForbiddenException();
      if (error instanceof OrderCancelNotFoundError) throw new NotFoundException();
      if (error instanceof OrderCancelInvalidError)
        throw new BadRequestException({
          code: "VALIDATION_ERROR",
          details: [{ path: "returnItems", message: "Invalid field" }],
        });
      if (error instanceof OrderCancelConflictError)
        throw new ConflictException({ code: error.reason });
      if (error instanceof OrderCollectionForbiddenError) throw new ForbiddenException();
      if (error instanceof OrderCollectionNotFoundError) throw new NotFoundException();
      if (error instanceof OrderCollectionTimeError)
        throw new BadRequestException({
          code: "VALIDATION_ERROR",
          details: [{ path: "collectedAt", message: "Invalid field" }],
        });
      if (error instanceof OrderCollectionConflictError)
        throw new ConflictException({ code: error.reason });
      if (error instanceof CouponRejectedError) throw new ConflictException({ code: error.code });
      if (error instanceof VariantUnavailableError)
        throw new ConflictException({ code: error.code });
      if (error instanceof DeliveryUnavailableError || error instanceof DeliveryUnconfiguredError)
        throw new ConflictException({ code: "AREA_UNAVAILABLE" });
      throw error;
    }
  }

  list(actorId: string, query: AdminOrdersQuery) {
    return this.execute(() => listAdminOrders(this.db, actorId, query));
  }

  find(actorId: string, orderId: string) {
    return this.execute(() => readAdminOrder(this.db, actorId, orderId));
  }

  transition(context: CommandContext, orderId: string, input: OrderTransitionRequest) {
    return this.execute(() => transitionOrder(this.db, context, orderId, input));
  }

  edit(context: CommandContext, orderId: string, input: OrderEditRequest) {
    return this.execute(() => editOrder(this.db, context, orderId, input));
  }

  collect(context: CommandContext, orderId: string, input: OrderCollectionRequest) {
    return this.execute(() => recordCollection(this.db, context, orderId, input));
  }

  correctCollection(
    context: CommandContext,
    orderId: string,
    input: OrderCollectionCorrectionRequest,
  ) {
    return this.execute(() => correctCollection(this.db, context, orderId, input));
  }

  cancel(context: CommandContext, orderId: string, input: OrderCancelRequest) {
    return this.execute(() => cancelOrder(this.db, context, orderId, input));
  }
}
