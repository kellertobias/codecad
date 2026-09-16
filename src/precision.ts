/** Optional fixed decimal places for dimensions expressed in millimetres. */
export function validateMmPrecision(value: number | undefined): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 0 || value > 6)
  )
    throw new Error("mmPrecision must be an integer from 0 to 6");
}

export function formatMm(
  value: number,
  precision?: number,
  fallback?: number,
): string {
  validateMmPrecision(precision);
  if (!Number.isFinite(value))
    throw new Error("Millimetre value must be finite");
  if (precision !== undefined) return value.toFixed(precision);
  return fallback === undefined
    ? String(value)
    : String(Number(value.toFixed(fallback)));
}
