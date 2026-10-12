import { randomBytes } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import type { StoreQuoteRequest, StoreQuoteResponse } from "@ih/contracts";
import {
  CouponRejectedError,
  previewQuote,
  VariantUnavailableError,
  type Database,
  type Quote,
} from "@ih/db";
import { DeliveryUnavailableError, DeliveryUnconfiguredError } from "@ih/domain";
import { quoteFingerprint, signQuote, type QuoteFacts, type QuoteKey } from "@ih/platform";
import { API_ENV, DATABASE } from "../infra/tokens";

/** The facts a shopper accepts: what is charged, and nothing that does not change it. */
export function quoteFacts(quote: Quote): QuoteFacts {
  return {
    areaId: quote.delivery.areaId,
    deliveryFeeFils: quote.deliveryFeeFils,
    couponCode: quote.coupon?.code ?? null,
    couponPercentBps: quote.coupon?.percentBps ?? 0,
    merchandiseSubtotalFils: quote.merchandiseSubtotalFils,
    discountFils: quote.discountFils,
    totalFils: quote.totalFils,
    lines: quote.lines.map(({ variantId, quantity, unitPriceFils }) => ({
      variantId,
      quantity,
      unitPriceFils,
    })),
  };
}
/**
 * Cart quote (roadmap step 71, ADR 0041): the authoritative total for a cart, an area and at
 * most one code, with a signed token saying what was shown. Nothing is reserved or recorded.
 */
@Injectable()
export class CartQuoteService {
  /** First key signs. The order service verifies with the same ring (step 76). */
  readonly keys: readonly QuoteKey[];
  private readonly ttlMs: number;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    // Staging and production must configure keys (the config schema refuses to start without).
    // Locally a key made at start-up is enough: a restart only makes shoppers re-quote.
    this.keys = env.QUOTE_SIGNING_KEYS.length
      ? env.QUOTE_SIGNING_KEYS
      : [{ keyId: "ephemeral", secret: randomBytes(32).toString("base64url") }];
    this.ttlMs = env.QUOTE_TTL_SECONDS * 1000;
  }
  async quote(input: StoreQuoteRequest): Promise<StoreQuoteResponse> {
    let quote: Awaited<ReturnType<typeof previewQuote>>;
    try {
      quote = await previewQuote(this.db, {
        lines: input.lines,
        areaId: input.areaId,
        couponCode: input.couponCode,
      });
    } catch (error) {
      // One stable code each; never the detailed reason, a code, or which variant.
      if (error instanceof DeliveryUnavailableError || error instanceof DeliveryUnconfiguredError)
        throw new ConflictException({ code: "AREA_UNAVAILABLE" });
      if (error instanceof VariantUnavailableError)
        throw new ConflictException({ code: "VARIANT_UNAVAILABLE" });
      if (error instanceof CouponRejectedError) throw new ConflictException({ code: error.code });
      throw error;
    }
    const fingerprint = quoteFingerprint(quoteFacts(quote));
    const expiresAt = new Date(Math.floor((Date.now() + this.ttlMs) / 1000) * 1000);
    return {
      lines: quote.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceFils: line.unitPriceFils,
        subtotalFils: line.subtotalFils,
        discountFils: line.discountFils,
        totalFils: line.totalFils,
      })),
      merchandiseSubtotalFils: quote.merchandiseSubtotalFils,
      discountFils: quote.discountFils,
      deliveryFeeFils: quote.deliveryFeeFils,
      totalFils: quote.totalFils,
      freeDeliveryThresholdFils: null,
      delivery: {
        areaId: quote.delivery.areaId,
        areaName: quote.delivery.areaName,
        emirate: quote.delivery.emirate as StoreQuoteResponse["delivery"]["emirate"],
        etaText: quote.delivery.etaText,
      },
      coupon: quote.coupon
        ? { code: quote.coupon.code, percentBps: quote.coupon.percentBps }
        : null,
      insufficientStock: quote.insufficientStock,
      quote: {
        token: signQuote(fingerprint, expiresAt, this.keys[0]!),
        fingerprint,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }
}
