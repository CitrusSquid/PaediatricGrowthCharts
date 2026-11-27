// Ideal Body Weight (IBW) estimates for obese children.
//
// Three published methods are produced together so they can be compared:
//   McLaren  the age at which the child's height would sit on the 50th centile
//            height curve (their "height age"), then the 50th centile weight for
//            that age.
//   Moore    the weight for the child's own age at the same centile as their height.
//   BMI50    the weight that would place the child on the 50th centile BMI at their age.
//
// The reference is always CDC 2-20y regardless of the standard the charts are using,
// because the method works through BMI and the WHO tables have no BMI reference.
// The BMI gate is evaluated against the centile the Results panel already shows, so the
// BMI card and this section can never disagree.
// Every estimate is capped at the child's actual weight: an IBW above the child's
// current weight is meaningless (Moore can overshoot badly for very tall children,
// whose height z-score sits past the end of the reference and is extrapolated).

import { paediatricData as pData } from '../paediatric_data';
import { calculateZScore, calculateValueAtZ } from './growthMath';

/** CDC tables start at 2 years; below that the methods have no reference. */
export const IBW_MIN_AGE_MONTHS = 24;
/** The feature applies to obesity only, so it needs BMI strictly above this centile. */
export const IBW_BMI_CENTILE_GATE = 95;

export type IbwEstimate = { value: number; capped: boolean } | null;

export type IbwResult = {
  /** 'boxes' shows the three methods; 'none' means nothing is rendered at all,
   *  either because there is no complete reading, the child is under 2 years, or
   *  their BMI is not above the gate. */
  state: 'boxes' | 'none';
  mcLaren: IbwEstimate;
  moore: IbwEstimate;
  bmi50: IbwEstimate;
};

const NONE: IbwResult = { state: 'none', mcLaren: null, moore: null, bmi50: null };

/**
 * LMS triple at an age, interpolated between the two surrounding reference rows.
 * The charts snap to the nearest row via getClosestLms; the inverse lookups below
 * need a value at an exact age, so they interpolate instead.
 */
function lmsAtAge(table: any[], ageMonths: number) {
  if (!table || table.length === 0) return null;
  if (ageMonths <= table[0].age) return table[0];
  if (ageMonths >= table[table.length - 1].age) return table[table.length - 1];

  let lo = 0;
  let hi = table.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = table[mid].age;
    if (v === ageMonths) return table[mid];
    if (v < ageMonths) lo = mid + 1;
    else hi = mid - 1;
  }
  const lower = table[lo - 1];
  const upper = table[lo];
  const f = (ageMonths - lower.age) / (upper.age - lower.age);
  return {
    l: lower.l + f * (upper.l - lower.l),
    m: lower.m + f * (upper.m - lower.m),
    s: lower.s + f * (upper.s - lower.s),
  };
}

/**
 * McLaren's "height age": the age at which the 50th centile height equals the
 * child's height. At the 50th centile the LMS value is simply m, and the CDC p50
 * height curve rises monotonically from ~85cm at 2y to its adult plateau at 20y,
 * so the first crossing is the answer. Children taller than that plateau (or
 * shorter than the curve starts) have no height age and get null.
 */
function ageAtFiftiethCentileHeight(heightTable: any[], heightCm: number): number | null {
  if (!heightTable || heightTable.length < 2 || !(heightCm > 0)) return null;
  const first = heightTable[0];
  const last = heightTable[heightTable.length - 1];
  if (heightCm < first.m || heightCm > last.m) return null;

  for (let i = 0; i < heightTable.length - 1; i++) {
    const a = heightTable[i];
    const b = heightTable[i + 1];
    if (heightCm >= a.m && heightCm <= b.m) {
      if (b.m === a.m) return b.age;
      return a.age + ((heightCm - a.m) / (b.m - a.m)) * (b.age - a.age);
    }
  }
  return null;
}

/**
 * Applies the actual-weight cap and reports whether it was needed. Infinity is a
 * legitimate input here (Moore reaches it for children whose height is far past the
 * reference), and it means the same thing as any other overshoot: use actual weight.
 */
function capToActual(value: number | null, actualWeightKg: number): IbwEstimate {
  if (value === null || Number.isNaN(value) || value <= 0) return null;
  if (value > actualWeightKg) return { value: actualWeightKg, capped: true };
  return { value, capped: false };
}

export function calculateIdealBodyWeights(
  sex: 'male' | 'female' | null | undefined,
  ageMonths: number | null | undefined,
  heightCm: number | null | undefined,
  weightKg: number | null | undefined,
  bmiPercentile: number | null | undefined
): IbwResult {
  if (!sex || ageMonths === null || ageMonths === undefined || Number.isNaN(ageMonths)) return NONE;
  if (!(heightCm > 0) || !(weightKg > 0)) return NONE;

  // CDC tables cover 2-20 years (24-240 months); outside that range the methods do not apply.
  if (ageMonths < IBW_MIN_AGE_MONTHS || ageMonths > 240) return NONE;

  const cdc = pData.growthData?.cdc?.[sex];
  const weightTable = cdc?.weight_for_age;
  const heightTable = cdc?.height_for_age;
  const bmiTable = cdc?.bmi_for_age;
  if (!weightTable || !heightTable || !bmiTable) return NONE;

  // Gate on the centile the Results panel is showing (CDC by construction - the WHO
  // tables have no bmi_for_age, so bmiRes always falls back to CDC). Using the same
  // number keeps the BMI card and this section in agreement at the boundary. Children
  // at or below it are not obese, so the section is simply omitted.
  if (bmiPercentile === null || bmiPercentile === undefined || bmiPercentile <= IBW_BMI_CENTILE_GATE) {
    return NONE;
  }

  // bmiLms is only needed for the BMI50 value now; the gate above uses the displayed centile.
  const bmiLms = lmsAtAge(bmiTable, ageMonths);
  const heightLms = lmsAtAge(heightTable, ageMonths);
  const weightLms = lmsAtAge(weightTable, ageMonths);
  const heightZ = heightLms ? calculateZScore(heightCm, heightLms.l, heightLms.m, heightLms.s) : null;

  // McLaren: 50th centile weight at the child's height age.
  const heightAge = ageAtFiftiethCentileHeight(heightTable, heightCm);
  const mcLaren = capToActual(heightAge === null ? null : lmsAtAge(weightTable, heightAge)?.m ?? null, weightKg);

  // Moore: weight at the child's age for their height centile. The height z is used
  // as-is, even past the end of the reference; the actual-weight cap absorbs the
  // resulting extrapolation, including the +infinity that calculateValueAtZ returns
  // once 1 + l*s*z goes past zero (girls from about 185cm at 16-19 years).
  const moore = capToActual(
    heightZ === null || !weightLms ? null : calculateValueAtZ(heightZ, weightLms.l, weightLms.m, weightLms.s),
    weightKg
  );

  // BMI50: weight that puts the child on the 50th centile BMI for their age.
  const bmi50 = capToActual(bmiLms ? bmiLms.m * Math.pow(heightCm / 100, 2) : null, weightKg);

  return { state: 'boxes', mcLaren, moore, bmi50 };
}
