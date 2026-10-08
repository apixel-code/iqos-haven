/**
 * Money is integer fils (1 AED = 100 fils). Floats are never used for money.
 * Final VAT/excise allocation rules wait for accountant-approved examples (business input BI-02).
 */
declare const filsBrand: unique symbol;
export type Fils = number & { readonly [filsBrand]: true };

export function fils(value: number): Fils {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money must be a safe integer number of fils, got ${value}`);
  }
  return value as Fils;
}

export function addFils(...values: Fils[]): Fils {
  return fils(values.reduce<number>((sum, v) => sum + v, 0));
}

export function multiplyFils(amount: Fils, quantity: number): Fils {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`Quantity must be a non-negative integer, got ${quantity}`);
  }
  return fils(amount * quantity);
}

/**
 * amount × basisPoints / 10_000, rounded half-up. 1 bp = 0.01 %, so 15 % = 1500 bp.
 * Non-negative inputs only; discounts and taxes are computed as positive amounts.
 */
export function applyBasisPoints(amount: Fils, basisPoints: number): Fils {
  if (amount < 0) throw new RangeError("Amount must be non-negative");
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError(`Basis points must be a non-negative integer, got ${basisPoints}`);
  }
  const product = BigInt(amount) * BigInt(basisPoints);
  return fils(Number((product + 5_000n) / 10_000n));
}

/** Display only. Example: 12350 → "AED 123.50". */
export function formatAed(amount: Fils): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const whole = Math.trunc(abs / 100).toLocaleString("en-US");
  const fraction = String(abs % 100).padStart(2, "0");
  return `${sign}AED ${whole}.${fraction}`;
}
