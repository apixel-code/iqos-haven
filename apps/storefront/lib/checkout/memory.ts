/**
 * What the shopper chose on the cart page, carried to the checkout page in memory only: the
 * delivery area and the discount code. It is gone on a reload, like every checkout detail, and
 * the shopper simply chooses again. Never written to device storage.
 */
export interface QuoteChoice {
  areaId: string;
  couponCode: string | null;
}
let choice: QuoteChoice = { areaId: "", couponCode: null };
export const rememberedChoice = (): QuoteChoice => choice;
export function rememberChoice(next: QuoteChoice): void {
  choice = next;
}
