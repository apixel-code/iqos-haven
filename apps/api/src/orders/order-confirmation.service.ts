import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiEnv } from "@ih/config";
import {
  idempotencyKeyHash,
  readConfirmationReplay,
  readOrderConfirmation,
  STORE_CHECKOUT_SCOPE,
  type Database,
} from "@ih/db";
import {
  ConfirmationCipher,
  confirmationHash,
  orderConfirmationCookie,
  readConfirmationCookie,
} from "@ih/platform";
import { API_ENV, DATABASE } from "../infra/tokens";
@Injectable()
export class OrderConfirmationService {
  private readonly cipher: ConfirmationCipher | null;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    // Only dev/test can use an ephemeral key; a restart may lose cookie replay, never the order.
    this.cipher = env.ORDER_CONFIRMATION_KEYS.length
      ? new ConfirmationCipher(env.ORDER_CONFIRMATION_KEYS)
      : env.APP_ENV === "development" || env.APP_ENV === "test"
        ? new ConfirmationCipher([
            { keyId: "ephemeral", secret: randomBytes(32).toString("base64url") },
          ])
        : null;
  }
  private binding(key: string) {
    return (
      STORE_CHECKOUT_SCOPE + ":" + idempotencyKeyHash(STORE_CHECKOUT_SCOPE, key).toString("hex")
    );
  }
  mint(key: string) {
    if (!this.cipher) throw new ServiceUnavailableException();
    return this.cipher.mint(this.binding(key));
  }
  async restore(key: string) {
    if (!this.cipher) return null;
    const saved = await readConfirmationReplay(
      this.db,
      STORE_CHECKOUT_SCOPE,
      idempotencyKeyHash(STORE_CHECKOUT_SCOPE, key),
    );
    if (!saved) return null;
    const token = this.cipher.open(saved.material, this.binding(key));
    if (
      !token ||
      !timingSafeEqual(confirmationHash(token), saved.hash) ||
      saved.expiresAt.getTime() <= Date.now()
    )
      return null;
    return orderConfirmationCookie(token, saved.expiresAt);
  }
  async find(cookie: string | undefined) {
    const token = readConfirmationCookie(cookie);
    return token ? readOrderConfirmation(this.db, confirmationHash(token)) : null;
  }
}
