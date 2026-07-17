export const DISTANCE_GAIN_FLOOR = 0.2;
export const DISTANCE_GAIN_NEAR_M = 100;

/**
 * Perceptual loudness for geographic distance (ADR 0003 / PRD v1.7 delta D-3).
 * The panner cannot express this: placeAtBearing ring-normalizes every source
 * to sourceRadiusM, so geographic distance maps to gain here instead — 1 in
 * the near field (≤ 100 m), linear in log10(d) down to the 0.2 floor at the
 * collection maximum. Constants are WP-D listening-pass tunables; the floor
 * and monotonicity are contractual.
 */
export function distanceGain(distanceM: number, maxDistanceM: number, coLocated = false): number {
  if (coLocated || !Number.isFinite(distanceM) || distanceM <= DISTANCE_GAIN_NEAR_M) {
    return 1;
  }
  const ceilingM = Math.max(Number.isFinite(maxDistanceM) ? maxDistanceM : 0, DISTANCE_GAIN_NEAR_M);
  if (distanceM >= ceilingM) {
    return DISTANCE_GAIN_FLOOR;
  }
  const progress = (Math.log10(distanceM) - Math.log10(DISTANCE_GAIN_NEAR_M))
    / (Math.log10(ceilingM) - Math.log10(DISTANCE_GAIN_NEAR_M));
  return 1 - (1 - DISTANCE_GAIN_FLOOR) * progress;
}

/** Equal-power ensemble trim: 1/√N over the active source count (ADR 0003). */
export function ensembleTrim(activeCount: number): number {
  return activeCount > 1 ? 1 / Math.sqrt(activeCount) : 1;
}
