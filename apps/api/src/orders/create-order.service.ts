import { OrderConfirmationService } from "./order-confirmation.service";
import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import type { CheckoutAddress, CheckoutContact } from "@ih/contracts";
import { createStoreOrder, QuoteNotAcceptedError, type Database } from "@ih/db";
import type { OrderLine } from "@ih/domain";
import { checkAcceptedQuote, verifyQuote } from "@ih/platform";
import { API_ENV, DATABASE } from "../infra/tokens";
import { CartQuoteService } from "../store/cart-quote.service";

export interface PlaceOrderCommand {
  idempotencyKey: string;
  contact: CheckoutContact;
  address: CheckoutAddress;
  lines: readonly OrderLine[];
  couponCode: string | null;
  /** The token returned with the total the shopper accepted. */
  quoteToken: string;
  requestId: string;
}
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
/**
 * Places a storefront order (roadmap step 76). Supplies what the database layer cannot know:
 * the quote signing keys and the age policy the shopper confirmed. Everything else, including
 * every lock and write, happens in `createStoreOrder`'s single transaction. Reached through
 * `StoreOrdersController` (step 77).
 */
@Injectable()
export class CreateOrderService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly quotes: CartQuoteService,
    private readonly confirmations: OrderConfirmationService,
  ) {}
  // Async so that every refusal, including the early one below, is a rejected promise.
  async place(command: PlaceOrderCommand) {
    // The fingerprint the token names identifies the request; whether it is genuine, current
    // and still true is decided later, against the facts recomputed under the locks.
    const claimed = command.quoteToken.split(".")[3] ?? "";
    if (!FINGERPRINT.test(claimed)) throw new QuoteNotAcceptedError("QUOTE_CHANGED");
    // Taken once, before any lock wait: a token that expires while the order waits its turn
    // still counts, which is at most the bounded wait later.
    const now = new Date();
    // A token this server never issued gets no database work at all: no claim, no customer
    // lock. An expired but genuine token goes on, because a retry of an order that was already
    // placed must still get its answer; a new order with it is refused inside as QUOTE_EXPIRED.
    const issued = verifyQuote(command.quoteToken, this.quotes.keys, now);
    if (!issued.ok && issued.reason !== "expired") throw new QuoteNotAcceptedError("QUOTE_CHANGED");
    return createStoreOrder(this.db, {
      confirmation: this.confirmations.mint(command.idempotencyKey),
      idempotencyKey: command.idempotencyKey,
      contact: command.contact,
      address: command.address,
      lines: command.lines,
      couponCode: command.couponCode,
      quote: {
        fingerprint: claimed,
        accept: (facts) => checkAcceptedQuote(command.quoteToken, this.quotes.keys, now, facts),
      },
      age: { policyVersion: this.env.AGE_POLICY_VERSION },
      requestId: command.requestId,
    });
  }
}
