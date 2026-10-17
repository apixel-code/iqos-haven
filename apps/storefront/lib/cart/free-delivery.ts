/**
 * Free-delivery progress (roadmap step 100; prototype `freeDel`). Shown only while the Owner
 * has a free-delivery threshold switched on, which the API answers as a number; at launch it
 * is off (`null`) and nothing is shown or claimed anywhere. The amounts are the server quote's
 * (merchandise after discount); this only words them, it decides nothing about the fee.
 * When a reviewed policy switches the threshold on, have the API send the remaining amount
 * with the quote and show that instead of deriving it here.
 */
export type FreeDeliveryProgress =
  { kind: "short"; remainingFils: number; percent: number } | { kind: "reached" };
export function freeDeliveryProgress(
  thresholdFils: number | null,
  merchandiseAfterDiscountFils: number,
): FreeDeliveryProgress | null {
  if (thresholdFils === null || !Number.isSafeInteger(thresholdFils) || thresholdFils <= 0)
    return null;
  if (merchandiseAfterDiscountFils >= thresholdFils) return { kind: "reached" };
  return {
    kind: "short",
    remainingFils: thresholdFils - merchandiseAfterDiscountFils,
    percent: Math.max(0, Math.floor((merchandiseAfterDiscountFils * 100) / thresholdFils)),
  };
}
