# Changelog

## v1.7.3

### Changed
- Version bumped to 1.7.3 in the app and `package.json`, and author attribution updated to
  `CitrusSquid`.
- `Export String` now requires Gender as well as Date of Birth before generating a tracking
  string, matching the `DDMMYYYY{M|F}` header format.
- Weight chart `0-12y` Y-axis upper bound changed from `100 kg` to `90 kg` (5 kg increments).

### Fixed
- **AAP 2017 BP thresholds for ages 1-12y**: corrected the absolute "whichever is lower"
  cut-offs in `classifyBloodPressure()` to `[120, 80]` (Elevated), `[130, 80]` (Stage 1),
  and `[140, 90]` (Stage 2) across ages 1-12y, and required positive systolic/diastolic/height
  inputs instead of letting `0` fall through to `p50`.
- **Out-of-range LMS lookups & mixed-age series**: `calcMetric()` now checks table bounds
  before calling `getClosestLms()` so infants under 24 months do not receive clamped 24m CDC
  BMI centiles / severe-obesity percentages and readings over 20y do not clamp to 240m.
  Readings under 24 months in a mixed-age series now score weight/height against WHO.
- **Direct Age mode & Height Velocity**: `measurementTimeMs()` uses chronological days
  rather than the hidden default date when in Direct Age mode, negative direct ages and
  non-positive measurements are rejected, `heightVelocityById` divides by chronological days /
  `DAYS_PER_YEAR`, and clinical notes omit the `Measured` date line in Direct Age mode.
- **Local date & tracking string round-trip**: `todayIso()` uses the local calendar date,
  `encodeTrackingString()` skips pre-birth dates and empty boxes instead of writing phantom
  `0`-day or zero-value records, and `decodeTrackingString()` validates gestational age bounds
  (21-44w, 0-6d) and calendar date rollover (e.g. Feb 30).
- **Ideal Body Weight bounds**: `calculateIdealBodyWeights()` rejects ages above 240 months
  and guards `weightLms` in Moore's calculation.
- **Chart drag-zoom, hover & print table**: `GrowthChart` computes X ticks dynamically across
  zoomed domains, keys Y-axis range on `view[1]` instead of zoom span, keeps centile curves
  continuous across patient points (`connectNulls`), preserves centile values when hovering
  patient-only points, `PrintCharts` omits CDC BMI charts when all points are under 24m, and
  the print table omits `(undefined%)` when no centile exists.
- **UI state hygiene**: cleared stale `selectedId` when deleting or importing, and reset
  empty-state `chartRange` cleanly across standard/tab switches.

## v1.7.2

### Changed
- **Export PDF now prints every growth chart, two to a page.** Printing used to give the
  data table plus whichever single tab happened to be on screen. It now prints the same
  historical table (date, age, weight, height, HC, BMI - each with its centile) on its own
  page, then **Weight + Height** together and **BMI + Head Circumference** together, each
  titled with the standard used and the child's sex and DOB. Pages break between blocks, so
  there is no trailing blank page, and an odd chart (e.g. no HC) simply prints alone on the
  second chart page.
- **A chart with nothing to plot is not printed.** Most often that is head circumference
  for an older child - the WHO head circumference reference stops at 5 years, so a
  measurement taken at 8 years has nowhere to sit and no HC chart appears. The same rule
  covers a parameter that was never recorded. A record with no sex or no measurements prints
  the table alone.
- **Printed charts are crisp black on white, whatever theme is on screen.** The app starts
  in dark mode, where the 50th centile is pure white and the rest pale slate/sky, and the
  browser drops the page background - so printouts came out washed out and the median line
  did not print at all. Printed charts now use a print palette: every centile line black
  (median solid and 2.5pt, the rest dashed as on screen), black axes, tick and axis labels,
  a light grid, and a darker red patient trace. The centile legend swatches are drawn as
  borders rather than background colours, because browsers omit element backgrounds unless
  "Background graphics" is ticked. The on-screen charts are unchanged in both themes.
- **Each printed chart uses the Range button you have selected, and never a drag-zoom.** The
  chart for the tab on screen prints at the axis its Range buttons show (e.g. `0-6m`); the
  other charts keep the axis the app would pick for them by default. A selection is snapped
  to an axis that chart actually offers, rounding up, since head circumference has no
  `0-12y`/`0-18y` and BMI has no `0-6m`/`0-24m`/`0-5y`. Drag-zooming is still ignored: after
  zooming the on-screen weight chart to 6-12 years, the printed weight chart still spans its
  full axis.
- **Printed charts are sized so two fit a page.** Each is drawn in a fixed 600x400px box
  (~159x106mm); with its heading, subtitle and centile legend a chart takes ~507px, so a
  pair measures 1014px inside the 1048px printable height at `@page { margin: 10mm }`.
- `@page` margin is set to 10mm and the print area's screen padding is dropped when
  printing, so a full-width chart cannot be pushed past the edge of the paper.
- The "Hover across chart to view values" hint and the Data Sources dialog no longer print.
- Internals: new `src/components/PrintCharts.tsx` (the printed chart set) and
  `src/utils/chartSource.ts` (which reference series a chart draws). `GrowthChart` gained a
  `staticPrint` mode - fixed size, no interaction handlers firing, print palette.
  `rangeOptionsFor()` and `defaultRangeFor()` moved out of `App.tsx` into
  `utils/chartSource.ts` **unchanged**, so the on-screen and printed charts cannot diverge
  about which axis or table they use.
- Version shown in the app and in `package.json` is now 1.7.2.

### Fixed
- **The blood pressure card now says what is missing instead of blaming the reading.** With
  a BP entered but no sex selected it read `Enter valid BP`, and with no height (under 13
  years, where the AAP thresholds are height-specific) it read `Insufficient Data` - both
  implied the measurement itself was wrong. It now reads **`Input Gender`** or
  **`Input Height`**, keeping the `Measured BP: 130/85 mmHg` line underneath. Nothing
  recorded reads **`Input Blood Pressure`** rather than `Enter valid BP`. Ages outside the
  1-17y reference keep `Insufficient Data`, and a classified reading is unchanged (`Normal`,
  `Elevated BP`, `Stage 1/2 Hypertension`, thresholds, colour, recommendations).
- **"BP Category" label removed** from the card - the headline names the state on its own.
- The `Age >= 13 years uses fixed thresholds.` note only appears with an actual category, so
  it no longer sits under `Input Gender` / `Input Blood Pressure`.
- Internals: `bpResults` gained a `missing: 'sex' | 'height'` state, kept apart from `error`
  (which stays for the age range and reference-data failures); the card headline comes from
  one `bpHeadline()` helper. The Clinical Notes export now keys its `BP:` line on a real
  category, so it can no longer emit `BP: 130/85 mmHg, undefined`.

## v1.7.1

### Fixed
- **Nothing is shown at all for children under 2 years.** The IBW section used to render a
  subdued `N/A` line under the Export String for every under-2 reading. The CDC tables start
  at 2 years, so the section is now omitted entirely below 24 months. `IbwResult['state']` is
  now `'boxes' | 'none'`.
- **The BMI card and the IBW section can no longer disagree.** The >95th centile gate
  recomputed the BMI centile by interpolating between the CDC BMI rows, while the Results
  card snaps to the nearest row (those rows are 0.5-1 month apart). The two could differ by
  up to 0.28 centile points, so a child could be shown `BMI 94.9%` next to three IBW boxes,
  or `95.1%` next to "Use actual body weight". The centile the panel already displays
  (`primary.results.bmiRes.p`) is now passed into `calculateIdealBodyWeights()` and used for
  the gate. Interpolation is still used inside the three methods, where there is no displayed
  figure to contradict; Moore's height centile is deliberately still taken from CDC inside the
  util rather than from the Height card, which follows WHO for 2-5y children.
- **Moore no longer shows `N/A` for extremely tall adolescents.** `calculateValueAtZ()`
  evaluates `m * (1 + l*s*z)^(1/l)`. Every CDC weight-for-age row has L < 0, and the power
  base reaches zero at z as low as 3.34, so a girl of about 185cm or more at 16-19 years
  (past that age's 99.97th centile) produced `NaN` and the Moore card wrongly read `N/A`.
  The limit is now returned explicitly (`+Infinity` for L < 0, `0` for L > 0) and
  `capToActual()` treats it like any other overshoot, so the card shows the child's actual
  weight marked `(capped)`.
  - Verified inert for everything already in the app: across all **211,684** LMS row/z pairs
    the charts and the "% 95th BMI" card can produce (widest z = 2.33, p1-p97), the smallest
    power base is **+0.16**, and all 12 generated reference series are byte-identical to v1.7.

### Changed
- **The "Use actual body weight" note is gone.** Readings that do not qualify for the IBW
  estimates - a BMI at or below the 95th centile from 2 years, as well as every under-2 and
  incomplete reading - now leave the panel exactly as it was before the section existed, with
  no text under the Export String. The subdued note has been removed from `App.tsx` and the
  `'use-actual'` state from `calculateIdealBodyWeights()`; qualifying readings are unchanged.
- **Result cards keep the same vertical alignment whether or not their extra line is
  present.** The "% 95th BMI" card had no third line at all, so its number sat lower than
  the centile in the other five cards; the IBW cards shifted when a method showed
  "(capped)" and its neighbours did not. Both now always reserve that line (blank when
  unused), so every card in a row has identical geometry.
- **"% 95th BMI" card is now "95th BMI"** - the value is a whole number (`118`, not
  `118.1%`) and the `%` moved into the small units line, matching the other cards. Shows
  `-` / `-` when there is nothing to report, like Weight/Height/Head Circ.
- Version shown in the app and in `package.json` is now 1.7.1.
