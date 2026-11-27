# AGENTS.md

Paediatric Growth & BP centile calculator. Static React 19 + Vite + Tailwind v4 SPA,
built into one self-contained `dist/index.html` via `vite-plugin-singlefile`.
No backend. Not a git repo.

## Layout — version snapshots

- `1.5/`, `1.5.1/`, `1.6/`, `1.6.1/`, `1.6.2/`, `1.7/`, `1.7.1/` and `1.7.2/` each hold a
  full app copy under `Code/` (own `package.json` + `node_modules`). There is no root manifest.
- **`1.7.2/Code/` is the active version.** The others are frozen prior snapshots — do not
  edit them. When asked for "the app", work in `1.7.2/Code/`.
- Each version dir: `Code/` = source; `1.7.2/CHANGELOG.md` = current notes.

## Commands — run inside a `Code/` dir (e.g. `1.7.2/Code`)

- `npm install`
- `npm run dev` — Vite on `0.0.0.0:3000`
- `npm run lint` — **this is just `tsc --noEmit`**, not ESLint. It is the only automated check.
- `npm run build` — emits single file `dist/index.html` (open directly to verify)
- `npm run clean` — uses `rm -rf`; fails in PowerShell. Delete `dist/` manually.

## Verification

No test framework or CI. Verify changes by running `npm run lint` and `npm run build`,
then opening `dist/index.html`. (The old `test-legend.js` / `test-sort.js` throwaway
scripts were deleted in v1.6.)

## Data files — do not hand-edit

- `src/paediatric_data.js` (~655 KB) and `src/bp_data.ts` are generated WHO/CDC LMS + BP
  reference tables. Read them, don't reformat or regenerate.
- **Never read `src/paediatric_data.js` in full** (it will blow up context) — grep or read
  targeted snippets/lines only.

## Domain rules that affect code

- Growth standard: **WHO 0–5y vs CDC 2–20y** is auto-selected from age but user-switchable;
  some ages force a standard (buttons disable). Preserve that forcing logic.
- `src/utils/growthMath.ts` uses Cole's **LMS** method. `calculateZScore` returns `null`
  for invalid/empty input — treat `null` differently from a genuine `0` (50th centile).
- **Tracking strings** (`src/utils/trackingString.ts`) are version-sensitive binary:
  8 bytes/record, 4 little-endian uint16 scaled ×100, Base64URL. v1.5.1 prepends a
  required `g{w}w{d}d_` gestation prefix, so **v1.5 strings no longer import**. Changing
  the format breaks prior exports. Records are date-sorted so output is deterministic.
- Dates must use **whole-day UTC arithmetic** (no timezone/DST off-by-one regressions).
- Chart x-axis default: `defaultRangeFor` (in `src/utils/chartSource.ts` since v1.7.2, was in
  `App.tsx`) picks the **smallest axis that fits the oldest reading**, inclusive thresholds:
  `<24m → 0-2y`, `≥24m → 0-12y`, `≥12y → 0-18y`
  (BMI min 0-12y; HC caps at 0-5y — no wider HC ref). A 0-5y default is not reachable for
  weight/height. The auto-range effect keys on the *needed range*, not a coarse age bucket.
- **Range buttons depend on the standard** (`rangeOptionsFor`, v1.6.2) for Weight/Height
  only: WHO shows 0-6m/0-24m/0-5y (never 0-12y/0-18y), CDC shows 0-12y/0-18y. BMI and HC
  are fixed regardless of standard. Keep `rangeOptionsFor`, `defaultRangeFor` and the
  `chartSourceFor` `range > 60 → CDC` switch (all three in `chartSource.ts`) in sync if
  these ever change. `chartSourceFor` is the single source of truth for which reference
  table a chart draws — the on-screen charts and `PrintCharts` both call it, so never
  re-derive a dataset/standard in a component.
- **Ideal Body Weight** (`src/utils/idealBodyWeight.ts`, v1.7) is separate from the centile
  math: it always uses the **CDC** tables regardless of `activeStandard`, gates on BMI
  **>95th centile** and age **≥24 months**, and caps every estimate at actual body weight.
  The gate uses the **BMI centile the Results panel already shows** (`bmiRes.p`, snapped by
  `getClosestLms`) — do not recompute it in the util, or the card and the section disagree
  by up to 0.3 points at the boundary. Anything that does not qualify (under 2 years, or BMI
  at or below the 95th centile) renders **nothing at all** — `state` is only
  `'boxes' | 'none'`; the subdued "Use actual body weight" note was removed in 1.7.1, do not
  re-add it.
  McLaren needs a *height age*, so it returns `N/A` for heights outside the CDC 50th
  centile height curve (which ends at 176.8cm/163.3cm at 20y) — that is expected, not a bug.
  Moore extrapolates the height z unbounded; `calculateValueAtZ` returns `Infinity` once
  `1 + l*s*z` passes zero (girls from ~185cm at 16-19y) and the cap turns that into the
  actual weight marked `(capped)` — it must not be filtered out as NaN.

- **Export PDF / print** (`src/components/PrintCharts.tsx` + the `@media print` block in
  `src/index.css`, v1.7.2) renders its **own** copy of all four charts plus the historical
  results table — never the interactive chart, which is `print:hidden` (only the active tab
  is mounted, and it may be drag-zoomed). Rules that must hold:
  - Charts print **two-up** (`.pdf-chart` pairs inside one `.pdf-page`; the table has its own
    page). Order is Weight, Height, BMI, HC. Breaks go *between* `.pdf-page` blocks
    (`.pdf-page + .pdf-page { break-before: page }`) so there is no trailing blank page.
  - Printed axes come from `rangeForPrint()` in `PrintCharts.tsx`: the **selected Range
    button** for the tab the user is on, `defaultRangeFor()` for the other three, always
    snapped up to an option that metric offers (HC has no 0-12y/0-18y, BMI no 0-6m/0-24m/0-5y).
    Drag-zoom is never carried to paper. Charts are drawn in a fixed `PRINT_CHART_SIZE`
    (600×400) box — two charts + headings + legend ≈ 1014px vs 1047.9px printable height at
    `@page { margin: 10mm }`, so there is only ~34px slack: adding print copy risks spilling
    to a third page. `ResponsiveContainer` measures its parent and the print charts are
    `display:none` on screen; recharts 3.x skips measuring entirely when `width`/`height` are
    both numbers, so they must be numbers here — passing percentages prints nothing.
  - A metric with no point inside its **default** axis is skipped (e.g. HC recorded at 8y has
    nowhere to go on the WHO 0-5y curve) — that is the intended "no chart" case. Judge
    inclusion on the default axis, not the printed one, so narrowing a Range button cannot
    delete a whole chart page.
  - Print is always black-on-white: `GrowthChart`'s `staticPrint` palette (black centiles,
    black axes, light grid, darker red trace) plus `.pdf-page { color: black !important }`,
    since the app starts in dark mode and the browser drops page backgrounds. Legend
    swatches must be **borders**, not background colours (backgrounds need the
    "Background graphics" tick).

- **BP card prompts** (v1.7.2) — `bpResults` has three shapes: classified (`category` +
  `display` + `recommendation`), `missing: 'sex' | 'height'`, and `error` (age outside the
  1-17y AAP table, or a reference-data failure). `null` means no BP was entered. The headline
  comes from `bpHeadline()` in `App.tsx`: no reading → `Input Blood Pressure`, missing sex →
  `Input Gender`, missing height → `Input Height` (height is only required under 13y — teens
  use fixed thresholds), `error` → `Insufficient Data`. Never collapse `missing` into `error`:
  the two read differently on the card. There is deliberately **no "BP Category" label**. The
  `Age ≥ 13 … fixed thresholds` note and the Clinical Notes `BP:` line are gated on
  **`category`**, not `!error` — a `missing` result has no category and would export
  `BP: 130/85 mmHg, undefined`.

## Google AI Studio scaffold (legacy)

Up to v1.5.1 the repo shipped as a Google AI Studio scaffold whose `README.md`,
`metadata.json`, `.env.example` and a `vite.config.ts` `GEMINI_API_KEY` define referenced
Gemini — **the app never calls Gemini**. v1.6 deleted those files and the Gemini define.
Do not re-add AI-API plumbing. `vite.config.ts` still keeps HMR switchable via `DISABLE_HMR`.
