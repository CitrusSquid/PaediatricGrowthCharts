// Which reference series a chart draws.
//
// Shared by the on-screen charts and the printed charts (v1.7.2) so the two can never
// disagree about their source data. The rule mirrors the axis-range logic in App.tsx: any
// axis wider than 60 months is always CDC, because the WHO tables stop at 5 years. Below
// that the active standard wins, with CDC as the fallback for metrics WHO has no table for
// (WHO publishes no BMI reference).

import { paediatricData as pData } from '../paediatric_data';

export type ChartMetric = 'Weight' | 'Height' | 'BMI' | 'HC';

// Weight/Height ranges follow the active standard: WHO tops out at 0-5y (no 0-12y/0-18y),
// CDC starts at 0-12y. BMI and Head Circumference keep fixed ranges regardless of standard.
export function rangeOptionsFor(tab: ChartMetric, standard: 'who' | 'cdc'): { label: string; value: number }[] {
  if (tab === 'BMI') return [{ label: '0-12y', value: 144 }, { label: '0-18y', value: 216 }];
  if (tab === 'HC') return [{ label: '0-6m', value: 6 }, { label: '0-24m', value: 24 }, { label: '0-5y', value: 60 }];
  if (standard === 'who') return [{ label: '0-6m', value: 6 }, { label: '0-24m', value: 24 }, { label: '0-5y', value: 60 }];
  return [{ label: '0-12y', value: 144 }, { label: '0-18y', value: 216 }];
}

// Smallest selectable axis that still fits the oldest reading (for the active standard).
// With the per-standard options this yields: WHO -> 0-6m/0-24m/0-5y, CDC weight/height ->
// 0-12y (under 12y) or 0-18y (>= 12y, inclusive). BMI min 0-12y, HC caps at 0-5y.
export function defaultRangeFor(tab: ChartMetric, standard: 'who' | 'cdc', ageMonths: number | null): number {
  const opts = rangeOptionsFor(tab, standard).map(o => o.value).sort((a, b) => a - b);
  const a = ageMonths === null || Number.isNaN(ageMonths) ? 0 : ageMonths;
  const fits = (v: number) => (a >= 24 ? v > a : v >= a);
  return opts.find(fits) ?? opts[opts.length - 1];
}

export type ChartSource = {
  dataset: any[];
  standard: 'who' | 'cdc';
  /** Heading without the standard suffix, e.g. "Weight for Age". */
  title: string;
};

export function chartSourceFor(
  metric: ChartMetric,
  standard: 'who' | 'cdc',
  rangeMonths: number,
  sex: 'male' | 'female' | null
): ChartSource {
  const tablesFor = (std: 'who' | 'cdc') => pData.growthData?.[std]?.[sex as string] || {};
  const cdc = tablesFor('cdc');
  const active = tablesFor(standard);
  const useCdc = rangeMonths > 60;

  if (metric === 'HC') {
    // Head circumference is WHO 0-5y only - there is no wider reference to fall back to.
    return { dataset: pData.growthData?.who?.[sex as string]?.hc_for_age || [], standard: 'who', title: 'Head Circumference for Age' };
  }

  if (metric === 'Weight') {
    const isCdc = useCdc && !!cdc.weight_for_age;
    return {
      dataset: isCdc ? cdc.weight_for_age : active.weight_for_age || cdc.weight_for_age || [],
      standard: isCdc ? 'cdc' : standard,
      title: 'Weight for Age',
    };
  }

  if (metric === 'Height') {
    const isCdc = useCdc && !!cdc.height_for_age;
    return {
      dataset: isCdc
        ? cdc.height_for_age
        : active.height_for_age || active.length_for_age || cdc.height_for_age || [],
      standard: isCdc ? 'cdc' : standard,
      title: 'Height for Age',
    };
  }

  const isCdc = useCdc && !!cdc.bmi_for_age;
  return {
    dataset: isCdc ? cdc.bmi_for_age : active.bmi_for_age || cdc.bmi_for_age || [],
    standard: isCdc ? 'cdc' : active.bmi_for_age ? standard : 'cdc',
    title: 'BMI for Age',
  };
}
