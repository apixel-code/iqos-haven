import {
  CouponRejectedError,
  IdempotencyConflictError,
  IdempotencyExpiredError,
  IdempotencyInProgressError,
  InsufficientStockError,
  QuoteNotAcceptedError,
  VariantUnavailableError,
} from "@ih/db";
import { DeliveryUnavailableError, DeliveryUnconfiguredError } from "@ih/domain";

/**
 * One stable code per refusal the shopper can act on (architecture §7). Never the detailed
 * reason, a variant, a coupon, or the order an old key belongs to.
 */
export function refusalCode(error: unknown): string | undefined {
  if (error instanceof QuoteNotAcceptedError) return error.code;
  if (error instanceof InsufficientStockError) return error.code;
  if (error instanceof VariantUnavailableError) return "VARIANT_UNAVAILABLE";
  if (error instanceof DeliveryUnavailableError || error instanceof DeliveryUnconfiguredError)
    return "AREA_UNAVAILABLE";
  if (error instanceof CouponRejectedError) return error.code;
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof IdempotencyInProgressError ||
    error instanceof IdempotencyExpiredError
  )
    return error.code;
  return undefined;
}
