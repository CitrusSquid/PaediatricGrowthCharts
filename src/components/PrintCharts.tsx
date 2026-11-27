// The growth charts that go into the Export PDF (print) output.
//
// The on-screen charts cannot simply be printed: only the selected tab is mounted, and a
// chart that has been drag-zoomed would print zoomed in. So printing uses its own copy of
// all four charts - drawn in a fixed page-sized box (GrowthChart's staticPrint mode) in
// black on white, two to a page - and leaves out any parameter with nothing to plot, e.g.
// head circumference for a child who is now 8 years old, whose readings fall outside the
// WHO 0-5y reference.
//
// Axis: the Range button the user has selected wins for the tab they are looking at; the
// other charts get the axis the app would pick for them by default. A drag-zoom is never
// carried onto paper.

import { GrowthChart } from './GrowthChart';
import {
  chartSourceFor,
  defaultRangeFor,
  rangeOptionsFor,
  type ChartMetric,
} from '../utils/chartSource';

type PrintPoint = { age: number; value: number; p?: number };

/** The bits of an evaluated measurement this component needs. */
export type PrintMeasurement = {
  ageMonths: number | null;
  weight: number | '';
  height: number | '';
  hc: number | '';
  bmi: number | null;
  results: {
    wRes?: { p?: number } | null;
    hRes?: { p?: number } | null;
    hcRes?: { p?: number } | null;
    bmiRes?: { p?: number } | null;
  } | null;
};

type PrintChartsProps = {
  sex: 'male' | 'female' | null;
  standard: 'who' | 'cdc';
  dob: string;
  maxAgeMonths: number | null;
  /** The tab on screen and the Range button selected on it. */
  activeTab: ChartMetric;
  selectedRange: number;
  measurements: PrintMeasurement[];
};

// Print order, with the axis caption and the readings each chart plots. The filters match
// the on-screen charts exactly, so a printed chart shows the same points as that tab.
const PRINT_CHARTS: {
  metric: ChartMetric;
  axis: string;
  read: (m: PrintMeasurement) => { value: number; p?: number } | null;
}[] = [
  {
    metric: 'Weight',
    axis: 'Weight (kg)',
    read: (m) => (m.weight === '' || !(Number(m.weight) > 0) ? null : { value: Number(m.weight), p: m.results?.wRes?.p }),
  },
  {
    metric: 'Height',
    axis: 'Height (cm)',
    read: (m) => (m.height === '' || !(Number(m.height) > 0) ? null : { value: Number(m.height), p: m.results?.hRes?.p }),
  },
  {
    metric: 'BMI',
    axis: 'BMI',
    read: (m) => (m.bmi === null || m.bmi === undefined || !(m.bmi > 0) ? null : { value: m.bmi, p: m.results?.bmiRes?.p }),
  },
  {
    metric: 'HC',
    axis: 'Head Circumference (cm)',
    read: (m) => (m.hc === '' || !(Number(m.hc) > 0) ? null : { value: Number(m.hc), p: m.results?.hcRes?.p }),
  },
];

// Two charts to a page. The table has its own page, then the charts come two-up.
const CHARTS_PER_PAGE = 2;

/**
 * Axis to print one chart at: the selected Range button for the tab it belongs to, the
 * default axis for the others, always snapped to an axis this chart actually offers (HC
 * has no 0-12y/0-18y, BMI has no 0-6m/0-24m/0-5y). Snapping rounds up so the oldest
 * reading is never cut off by a stale selection.
 */
function rangeForPrint(
  metric: ChartMetric,
  standard: 'who' | 'cdc',
  activeTab: ChartMetric,
  selectedRange: number,
  maxAgeMonths: number | null
) {
  const options = rangeOptionsFor(metric, standard)
    .map((o) => o.value)
    .sort((a, b) => a - b);
  const wanted = metric === activeTab ? selectedRange : defaultRangeFor(metric, standard, maxAgeMonths);
  if (options.includes(wanted)) return wanted;
  return options.find((v) => v >= wanted) ?? options[options.length - 1];
}

export default function PrintCharts({
  sex,
  standard,
  dob,
  maxAgeMonths,
  activeTab,
  selectedRange,
  measurements,
}: PrintChartsProps) {
  if (!sex) return null;

  const charts = PRINT_CHARTS.map(({ metric, axis, read }) => {
    // Whether a parameter has anything to print is judged on its default axis, so narrowing
    // the Range button cannot make a whole chart vanish - and a head circumference taken
    // after the 0-5y reference still prints nothing.
    const defaultRange = defaultRangeFor(metric, standard, maxAgeMonths);
    const points: PrintPoint[] = [];
    for (const m of measurements) {
      if (m.ageMonths === null || Number.isNaN(m.ageMonths)) continue;
      const value = read(m);
      if (value) points.push({ age: m.ageMonths as number, ...value });
    }
    const hasPlottablePoint = metric === 'BMI'
      ? points.some((pt) => pt.age >= 24 && pt.age <= defaultRange)
      : points.some((pt) => pt.age <= defaultRange);
    if (!hasPlottablePoint) return null;
    const range = rangeForPrint(metric, standard, activeTab, selectedRange, maxAgeMonths);
    return { metric, axis, range, points, source: chartSourceFor(metric, standard, range, sex) };
  }).filter((chart): chart is NonNullable<typeof chart> => chart !== null);

  const pages: (typeof charts)[] = [];
  for (let i = 0; i < charts.length; i += CHARTS_PER_PAGE) {
    pages.push(charts.slice(i, i + CHARTS_PER_PAGE));
  }

  return (
    <>
      {pages.map((page) => (
        <section key={page.map((c) => c.metric).join('+')} className="hidden print:block pdf-page">
          {page.map(({ metric, axis, range, points, source }) => (
            <div key={metric} className="pdf-chart">
              <h3 className="text-center text-base font-semibold mb-1">
                {source.title} ({source.standard.toUpperCase()})
              </h3>
              <p className="text-center text-xs mb-3">
                {sex === 'male' ? 'Male' : 'Female'} &middot; DOB {dob || '--'}
              </p>
              <GrowthChart
                staticPrint
                datasetData={source.dataset}
                standard={source.standard}
                metric={axis}
                patientPoints={points}
                isDarkMode={false}
                initialRange={range}
              />
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
