// Shared time-conversion constants (Julian year / mean month).
export const DAYS_PER_MONTH = 30.4375;
export const DAYS_PER_YEAR = 365.25;

/**
 * Calculates Z-score based on Cole's LMS method.
 * Returns null when the measurement or LMS parameters are non-positive,
 * so callers can distinguish "invalid/empty" from a genuine z of 0 (the 50th centile).
 */
export function calculateZScore(x: number, l: number, m: number, s: number): number | null {
  if (!(x > 0) || !(m > 0) || !(s > 0)) return null;
  if (Math.abs(l) < 0.0001) {
    return Math.log(x / m) / s;
  }
  return (Math.pow(x / m, l) - 1) / (l * s);
}

/**
 * Calculates the exact measurement value given a Z-score using LMS method.
 * The LMS power is undefined once 1 + l*s*z reaches zero (only possible when z
 * has the opposite sign to l), so that limit is returned explicitly instead of
 * letting Math.pow hand back NaN: with L < 0 the curve runs to +infinity.
 */
export function calculateValueAtZ(z: number, l: number, m: number, s: number): number {
  if (Math.abs(l) < 0.0001) {
    return m * Math.exp(s * z);
  }
  const base = 1 + l * s * z;
  if (base <= 0) {
    return l < 0 ? Infinity : 0;
  }
  return m * Math.pow(base, 1 / l);
}

/**
 * Converts a Z-score to a percentile using error function approximation.
 */
export function zToPercentile(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf) * 100;
}

/**
 * Finds the closest LMS data point for a given age in months.
 * WHO reference ages are stored in days (0-1856), CDC in months (0-240),
 * so the target age is converted accordingly. Runs a binary search over the
 * (pre-sorted, ascending) reference array instead of sorting a copy each call.
 */
export function getClosestLms(dataArray: any[], currentAgeMonths: number, standard: 'who' | 'cdc' = 'who') {
  if (!dataArray || dataArray.length === 0) return null;
  const isDays = standard === 'who';
  const targetAge = isDays ? currentAgeMonths * DAYS_PER_MONTH : currentAgeMonths;

  let lo = 0;
  let hi = dataArray.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = dataArray[mid].age;
    if (v === targetAge) return dataArray[mid];
    if (v < targetAge) lo = mid + 1;
    else hi = mid - 1;
  }
  // `lo` is the insertion point; the nearest value is at lo-1 or lo.
  if (lo >= dataArray.length) return dataArray[dataArray.length - 1];
  if (lo <= 0) return dataArray[0];
  const lower = dataArray[lo - 1];
  const upper = dataArray[lo];
  return targetAge - lower.age <= upper.age - targetAge ? lower : upper;
}

/**
 * Re-maps chart data and generates arrays for Recharts using standard percentiles.
 */
export function generateChartData(
  dataArray: any[],
  centileKeys: string[],
  zScoresDef: Record<string, number>,
  isWhoData: boolean
) {
  if (!dataArray) return [];
  // Sort data array by age
  const sorted = [...dataArray].sort((a, b) => a.age - b.age);

  return sorted.map((point) => {
    // WHO data is in days (0-1856), CDC is in months (0-240).
    const ageMonths = isWhoData ? point.age / DAYS_PER_MONTH : point.age;
    
    const datum: any = { age: ageMonths };
    for (const key of centileKeys) {
      const z = zScoresDef[key] || 0;
      datum[key] = calculateValueAtZ(z, point.l, point.m, point.s);
    }
    return datum;
  });
}

export function formatAgeString(days: number) {
   if (days < DAYS_PER_MONTH) {
      return `${Math.floor(days)}d`;
   } else if (days < DAYS_PER_MONTH * 3) {
      const weeks = Math.floor(days / 7);
      const remDays = Math.floor(days % 7);
      if (remDays === 0) return `${weeks}wk`;
      return `${weeks}wk ${remDays}d`;
   } else if (days < DAYS_PER_YEAR) {
      const mo = Math.floor(days / DAYS_PER_MONTH);
      const remDays = Math.floor(days % DAYS_PER_MONTH);
      if (remDays === 0) return `${mo}m`;
      return `${mo}m ${remDays}d`;
   } else {
      const y = Math.floor(days / DAYS_PER_YEAR);
      const mo = Math.floor((days % DAYS_PER_YEAR) / DAYS_PER_MONTH);
      if (mo === 0) return `${y}y`;
      return `${y}y ${mo}m`;
   }
}
