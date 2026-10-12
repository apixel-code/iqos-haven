import {
  Inject,
  Injectable,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import {
  createCoupon,
  listCoupons,
  restoreCoupon,
  trashCoupon,
  updateCoupon,
  CouponConflictError,
  CouponForbiddenError,
  CouponNotFoundError,
  type Database,
} from "@ih/db";
import type {
  CouponCreateRequest,
  CouponsQuery,
  CouponStateRequest,
  CouponUpdateRequest,
} from "@ih/contracts";
import { DATABASE } from "../infra/tokens";
@Injectable()
export class CouponsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private async execute<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CouponForbiddenError) throw new ForbiddenException();
      if (error instanceof CouponConflictError) throw new ConflictException({ code: error.reason });
      if (error instanceof CouponNotFoundError) throw new NotFoundException();
      throw error;
    }
  }
  list(actor: string, query: CouponsQuery) {
    return this.execute(() => listCoupons(this.db, actor, query));
  }
  create(context: CommandContext, input: CouponCreateRequest) {
    return this.execute(() => createCoupon(this.db, context, input));
  }
  update(context: CommandContext, id: string, input: CouponUpdateRequest) {
    return this.execute(() => updateCoupon(this.db, context, id, input));
  }
  trash(context: CommandContext, id: string, input: CouponStateRequest) {
    return this.execute(() => trashCoupon(this.db, context, id, input));
  }
  restore(context: CommandContext, id: string, input: CouponStateRequest) {
    return this.execute(() => restoreCoupon(this.db, context, id, input));
  }
}
