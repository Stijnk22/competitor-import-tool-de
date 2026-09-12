/**
 * Price calculator
 *
 * Rules (as agreed):
 *  - Final price (what the customer pays) = competitor price ± configurable
 *    amount, rounded to the NEAREST amount ending in .95.
 *  - Every product gets a discount. The discount TYPE is chosen per batch:
 *    exactly 50%, exactly 40%, or a random percentage between 20% and 35%
 *    (freshly randomized for each individual product when "random" is
 *    chosen — not the same random value for the whole batch).
 *  - The compare-at price (the struck-through "was" price) is a whole,
 *    round number (no cents) that lands as close as possible to the
 *    target percentage.
 */

export type DiscountType = "50" | "40" | "random";

export type PricingResult = {
  finalPrice: number; // what the customer pays, always ending in .95
  compareAtPrice: number | null; // only set when a discount applies
};

/**
 * Rounds an amount to the nearest amount ending in .95.
 */
export function roundToNearest95(value: number): number {
  const shifted = value - 0.95;
  const rounded = Math.round(shifted) + 0.95;
  // Prevent negative/too-low prices by enforcing a floor of 0.95.
  const result = Math.max(rounded, 0.95);
  return Math.round(result * 100) / 100;
}

/**
 * Rounds an amount to the nearest whole number (no cents) — a "round"
 * compare-at price, but precise enough to land close to an exact target
 * discount percentage (rounding to the nearest multiple of 5 instead was
 * tried first, but its coarser granularity could shift the displayed
 * discount noticeably away from the target, e.g. 48% instead of 50% —
 * the nearest whole number keeps prices looking just as clean while
 * staying far closer to the intended percentage).
 */
export function roundToNearestWholeNumber(value: number): number {
  return Math.round(value);
}

/**
 * Resolves a discount TYPE into an actual target percentage. For
 * "random", a fresh percentage between 20 and 35 is picked every time
 * this is called — so calling it once per product (not once per batch)
 * gives natural-looking variation across a batch instead of every
 * product getting the exact same random value.
 */
function resolveTargetPercentage(discountType: DiscountType): number {
  if (discountType === "50") return 50;
  if (discountType === "40") return 40;
  return 20 + Math.random() * 15; // random: 20-35%
}

export function calculatePricing(
  competitorPrice: number,
  adjustmentEur: number,
  discountType: DiscountType | null
): PricingResult {
  const rawFinal = competitorPrice + adjustmentEur;
  const finalPrice = roundToNearest95(rawFinal);

  if (!discountType) {
    return { finalPrice, compareAtPrice: null };
  }

  const targetPercentage = resolveTargetPercentage(discountType);
  return { finalPrice, compareAtPrice: findValidCompareAtPrice(finalPrice, targetPercentage) };
}

/**
 * Finds a compare-at price that (a) is a whole, round number (no cents)
 * and (b) yields as close as possible to the target discount percentage
 * relative to finalPrice.
 */
function findValidCompareAtPrice(finalPrice: number, targetPercentage: number): number {
  const idealCompareAt = finalPrice / (1 - targetPercentage / 100);
  const rounded = roundToNearestWholeNumber(idealCompareAt);

  // Safety floor: rounding down could theoretically land at or below
  // finalPrice for unusual amounts — never let compareAtPrice end up
  // lower than (or equal to) the price itself.
  const minimumValid = roundToNearestWholeNumber(finalPrice) + 1;
  return Math.max(rounded, minimumValid);
}
