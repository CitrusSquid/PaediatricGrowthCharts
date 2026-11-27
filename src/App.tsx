/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { calculateZScore, getClosestLms, zToPercentile, calculateValueAtZ, formatAgeString, DAYS_PER_MONTH, DAYS_PER_YEAR } from './utils/growthMath';
import { Stethoscope, Sun, Moon } from 'lucide-react';
import { GrowthChart } from './components/GrowthChart';
import PrintCharts from './components/PrintCharts';
import { chartSourceFor, rangeOptionsFor, defaultRangeFor, type ChartMetric } from './utils/chartSource';
import { encodeTrackingString, decodeTrackingString } from './utils/trackingString';
import { calculateIdealBodyWeights } from './utils/idealBodyWeight';

import { paediatricData as pData } from './paediatric_data';
import { bpRecommendations } from './bp_data';

type Measurement = {
  id: string;
  currentDate: string;
  directAgeY: number | '';
  directAgeM: number | '';
  directAgeD: number | '';
  weight: number | '';
  height: number | '';
  hc: number | '';
  // bp
  sys: number | '';
  dia: number | '';
};

// Compact "cN" centile token used by the clinical-notes export (98th centile -> "c98").
// Extreme percentiles are meaningless when rounded, so flag them with bounds instead.
function formatCentileC(p: number | undefined | null) {
  if (p === undefined || p === null || Number.isNaN(p)) return '';
  if (p < 0.1) return '<c0.1';
  if (p > 99.9) return '>c99.9';
  return `c${Math.round(p)}`;
}

// Compact "N.N%" display used by the results grid, clamped at the chart bounds.
function formatPercent(p: number | undefined | null) {
  if (p === undefined || p === null || Number.isNaN(p)) return '-';
  if (p < 0.1) return '<0.1%';
  if (p > 99.9) return '>99.9%';
  return `${p.toFixed(1)}%`;
}

// Whole-day UTC instant for a "YYYY-MM-DD" string. Using UTC avoids the local/UTC
// mismatch (and DST drift) that shifting Date objects introduces at month/timezone
// boundaries; the difference of two such instants is always an exact multiple of a day.
function utcDayMs(dateStr: string | undefined | null): number {
  if (!dateStr) return NaN;
  const p = String(dateStr).split('-');
  if (p.length !== 3) return NaN;
  const y = parseInt(p[0], 10), mo = parseInt(p[1], 10), d = parseInt(p[2], 10);
  if (isNaN(y) || isNaN(mo) || isNaN(d)) return NaN;
  return Date.UTC(y, mo - 1, d);
}

// True when a (evaluated) measurement carries any entered clinical value.
function hasMeasurementData(m: any): boolean {
  return m.weight !== '' || m.height !== '' || m.hc !== ''
    || (m.bmi !== null && m.bmi !== undefined)
    || (m.sys !== '' && m.dia !== '');
}

// Comparable timestamp for ordering readings. Dated entries use a fixed UTC instant;
// age-only entries use chronological days (ignoring the hidden default currentDate).
function measurementTimeMs(m: any, ageInputMode: 'dob' | 'direct'): number {
  if (ageInputMode === 'dob') {
    const t = utcDayMs(m.currentDate);
    if (!isNaN(t)) return t;
  }
  if (m.chronDays !== null && m.chronDays !== undefined && !Number.isNaN(m.chronDays)) {
    return m.chronDays * 24 * 3600 * 1000;
  }
  if (m.ageMonths !== null && m.ageMonths !== undefined && !Number.isNaN(m.ageMonths)) {
    return m.ageMonths * DAYS_PER_MONTH * 24 * 3600 * 1000;
  }
  return 0;
}

// "YYYY-MM-DD" -> "DD/MM/YY" (string math only, so it is timezone-proof).
function formatMeasuredDateDDMMYY(dateStr: string | undefined | null): string {
  if (!dateStr) return '';
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return '';
  const [y, mo, d] = parts;
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(mo) || !/^\d{2}$/.test(d)) return '';
  return `${d}/${mo}/${y.slice(2)}`;
}

type BpCategory = 'normal' | 'elevated' | 'stage1' | 'stage2';
const BP_RANK: Record<BpCategory, number> = { normal: 1, elevated: 2, stage1: 3, stage2: 4 };

type BpDisplay =
  | { type: 'fixed' }
  | { type: 'percentile'; elevated: number[]; stage1: number[]; stage2: number[] };

// AAP 2017 paediatric BP classification (Table 3).
// - >=13y: fixed adult thresholds (<120/<80 Normal, 120-129/<80 Elevated, 130-139/80-89 Stage 1, >=140/90 Stage 2).
// - 1-12y: percentile-based OR absolute thresholds ("whichever is lower") — 120/80 Elevated,
//   130/80 Stage 1, 140/90 Stage 2.
// p90/p95 are the height-specific [systolic, diastolic] limits for this age/height.
function classifyBloodPressure(
  ageYears: number,
  p90: number[],
  p95: number[],
  sys: number,
  dia: number
): { category: BpCategory; isCritical: boolean; display: BpDisplay } {
  const isTeen = ageYears >= 13;

  // Absolute "OR" thresholds per AAP 2017 Table 3 for ages 1-12y.
  const absElevated: number[] = [120, 80];
  const absStage1: number[] = [130, 80];
  const absStage2: number[] = [140, 90];

  const elevL = [
    Math.min(p90[0], absElevated[0]),
    Math.min(p90[1], absElevated[1]),
  ];
  const stage1L = [
    Math.min(p95[0], absStage1[0]),
    Math.min(p95[1], absStage1[1]),
  ];
  const stage2L = [Math.min(p95[0] + 12, absStage2[0]), Math.min(p95[1] + 12, absStage2[1])];

  const catFor = (val: number, isSys: boolean): BpCategory => {
    if (isTeen) {
      if (isSys) {
        if (val >= 140) return 'stage2';
        if (val >= 130) return 'stage1';
        if (val >= 120) return 'elevated';
        return 'normal';
      }
      if (val >= 90) return 'stage2';
      if (val >= 80) return 'stage1';
      return 'normal';
    }
    const idx = isSys ? 0 : 1;
    if (val >= stage2L[idx]) return 'stage2';
    if (val >= stage1L[idx]) return 'stage1';
    if (val >= elevL[idx]) return 'elevated';
    return 'normal';
  };

  const sysCat = catFor(sys, true);
  const diaCat = catFor(dia, false);
  const category = BP_RANK[sysCat] >= BP_RANK[diaCat] ? sysCat : diaCat;

  const isCritical = isTeen
    ? sys >= 180 || dia >= 120
    : sys > p95[0] + 30 || dia > p95[1] + 30;

  const display: BpDisplay = isTeen
    ? { type: 'fixed' }
    : { type: 'percentile', elevated: elevL, stage1: stage1L, stage2: stage2L };

  return { category, isCritical, display };
}

// What the blood pressure card headline reads. A reading that cannot be classified names
// the input still missing (v1.7.2) instead of implying the measurement itself is invalid,
// and a reading that was never taken asks for blood pressure.
function bpHeadline(bp: any): string {
  if (!bp) return 'Input Blood Pressure';
  if (bp.missing === 'sex') return 'Input Gender';
  if (bp.missing === 'height') return 'Input Height';
  if (bp.error) return 'Insufficient Data';
  if (bp.category === 'stage2') return 'Stage 2 Hypertension';
  if (bp.category === 'stage1') return 'Stage 1 Hypertension';
  if (bp.category === 'elevated') return 'Elevated BP';
  return 'Normal';
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function makeMeasurement(id: string): Measurement {
  return {
    id,
    currentDate: todayIso(),
    directAgeY: '',
    directAgeM: '',
    directAgeD: '',
    weight: '',
    height: '',
    hc: '',
    sys: '',
    dia: '',
  };
}

// Chart axis ranges and the reference series behind each chart live in utils/chartSource.ts
// so that the on-screen charts and the printed charts share exactly the same rules.
type MetricTab = ChartMetric;

export default function App() {
  const [sex, setSex] = useState<'male' | 'female' | null>(null);
  const [ageInputMode, setAgeInputMode] = useState<'dob' | 'direct'>('dob');
  const [dob, setDob] = useState<string>('');
  
  const [showInfo, setShowInfo] = useState(false);
  const [measurements, setMeasurements] = useState<Measurement[]>(() => [makeMeasurement('m1')]);
  // Id of the timepoint the user has starred as the primary reading. When null the
  // primary falls back to box 0 (then the most recent reading by date).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [gestationalAgeStr, setGestationalAgeStr] = useState<string>('40');
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);
  const [importInput, setImportInput] = useState<string>('');
  const [importStatus, setImportStatus] = useState<'success' | 'error' | null>(null);
  const [copiedString, setCopiedString] = useState<boolean>(false);
  const importDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const importStatusRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // Clear any pending import / clipboard timers if the app unmounts.
  useEffect(() => {
    return () => {
      if (importDebounceRef.current) clearTimeout(importDebounceRef.current);
      if (importStatusRef.current) clearTimeout(importStatusRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Gestation is entered as "weeks.days" (a comma is treated as a decimal point).
  // Days roll over into weeks (40.7 -> 41w0d, 40.8 -> 41w1d). More than one decimal
  // digit or any non-numeric text is rejected; final weeks must fall in 21-44 or the
  // value is treated as not-entered (no corrected-age) with an inline error.
  const gestationResult = useMemo(() => {
    const raw = gestationalAgeStr.trim();
    if (!raw) return { value: null as { weeks: number; days: number } | null, error: null as string | null };
    const normalized = raw.replace(/,/g, '.');
    if (!/^\d{1,2}(\.\d)?$/.test(normalized)) {
      return { value: null, error: 'Enter as weeks.days, e.g. 32.5' };
    }
    const num = parseFloat(normalized);
    if (isNaN(num)) return { value: null, error: 'Enter a valid number' };
    let weeks = Math.floor(num);
    const rawDays = Math.round((num - weeks) * 10); // single decimal digit => 0-9
    weeks += Math.floor(rawDays / 7);
    const days = rawDays % 7;
    if (weeks < 21 || weeks > 44) {
      return { value: null, error: 'Weeks must be between 21 and 44' };
    }
    return { value: { weeks, days }, error: null };
  }, [gestationalAgeStr]);

  const parsedGestation = gestationResult.value;
  const gestationError = gestationResult.error;

  const basicMeasurements = useMemo(() => {
    return measurements.map(m => {
      let chronDays = 0;
      
      if (ageInputMode === 'direct') {
        const y = (typeof m.directAgeY === 'number' ? m.directAgeY : 0);
        const mo = (typeof m.directAgeM === 'number' ? m.directAgeM : 0);
        const d = (typeof m.directAgeD === 'number' ? m.directAgeD : 0);
        if (y === 0 && mo === 0 && d === 0 && m.directAgeY === '' && m.directAgeM === '' && m.directAgeD === '') {
           return { ...m, ageMonths: null, chronDays: null, chronString: '', correctedString: null, bmi: null };
        }
        if (y < 0 || mo < 0 || d < 0 || Number.isNaN(y) || Number.isNaN(mo) || Number.isNaN(d)) {
           return { ...m, ageMonths: null, chronDays: null, chronString: '', correctedString: null, bmi: null };
        }
        chronDays = y * 365.25 + mo * 30.4375 + d;
        if (Number.isNaN(chronDays) || chronDays < 0) {
           return { ...m, ageMonths: null, chronDays: null, chronString: '', correctedString: null, bmi: null };
        }
      } else {
        if (!dob || !m.currentDate) return { ...m, ageMonths: null, chronDays: null, chronString: '', correctedString: null, bmi: null };
        const d1 = utcDayMs(dob);
        const d2 = utcDayMs(m.currentDate);
        if (isNaN(d1) || isNaN(d2)) return { ...m, ageMonths: null, chronDays: null, chronString: '', correctedString: null, bmi: null };
        const diffTime = d2 - d1;
        if (diffTime < 0) return { ...m, ageMonths: null, chronDays: null, chronString: '', correctedString: null, bmi: null };
        chronDays = diffTime / (1000 * 3600 * 24);
      }

      const chronString = formatAgeString(chronDays);

      let correctedDays = chronDays;
      let correctedString = null;

      if (chronDays < 730.5 && parsedGestation) {
         const termDays = 280; // 40 weeks
         const gestDays = parsedGestation.weeks * 7 + parsedGestation.days;
         if (parsedGestation.weeks < 37) {
            const shortfall = termDays - gestDays;
            correctedDays = Math.max(0, chronDays - shortfall);
            correctedString = formatAgeString(correctedDays);
         }
      }

      const ageMonths = (correctedString ? correctedDays : chronDays) / 30.4375;
      
      let bmi = null;
      if (Number(m.weight) > 0 && Number(m.height) > 0) {
        bmi = Number(m.weight) / Math.pow(Number(m.height) / 100, 2);
      }

      return { ...m, ageMonths, chronDays, chronString, correctedString, bmi };
    });
  }, [measurements, dob, ageInputMode, gestationalAgeStr, parsedGestation]);

  const [activeTab, setActiveTab] = useState<string>('Weight');
  const [chartRange, setChartRange] = useState<number>(24);
  const [manualStandard, setManualStandard] = useState<'who' | 'cdc'>('who');

  // Range/standard decisions use the OLDEST (highest-age) timepoint so the chart
  // covers the whole series and WHO/CDC never offer an option that cannot plot a point.
  const maxAgeMonths = basicMeasurements.reduce<number | null>(
    (acc, m) =>
      m.ageMonths === null || Number.isNaN(m.ageMonths)
        ? acc
        : acc === null
        ? m.ageMonths
        : Math.max(acc, m.ageMonths),
    null
  );
  const isWhoForced = maxAgeMonths !== null && maxAgeMonths < 24;
  const isCdcForced = maxAgeMonths !== null && maxAgeMonths > 60;
  
  const activeStandard = isCdcForced ? 'cdc' : (isWhoForced ? 'who' : manualStandard);

  const evaluatedMeasurements = useMemo(() => {
    return basicMeasurements.map(m => {
      const { ageMonths, bmi } = m;
      const standardForPoint = ageMonths !== null && ageMonths < 24 ? 'who' : activeStandard;
      
      // Results map
      let results = null;
      if (pData.growthData && ageMonths !== null) {
        const stdData = pData.growthData[standardForPoint]?.[sex] || {};
        const whoStdData = pData.growthData.who?.[sex] || {}; 
        
        const calcMetric = (value: number | string | '', datasetName: string, std: any, isWhoData: boolean) => {
          const table = std[datasetName];
          if (value === '' || value === null || !table || table.length === 0 || ageMonths === null) return null;
          const clampedAgeMonths = Math.max(0, ageMonths);
          const targetAge = isWhoData ? clampedAgeMonths * DAYS_PER_MONTH : clampedAgeMonths;
          if (targetAge < table[0].age || targetAge > table[table.length - 1].age) return null;
          const lms = getClosestLms(table, clampedAgeMonths, isWhoData ? 'who' : 'cdc');
          if (!lms) return null;
          const z = calculateZScore(Number(value), lms.l, lms.m, lms.s);
          if (z === null) return null;
          return { z, p: zToPercentile(z), value: Number(value), lms };
        };

        const wRes = calcMetric(m.weight, 'weight_for_age', stdData, standardForPoint === 'who');
        const heightDatasetName = stdData['height_for_age'] ? 'height_for_age' : 'length_for_age';
        const hRes = calcMetric(m.height, heightDatasetName, stdData, standardForPoint === 'who');
        const hcRes = (ageMonths !== null && ageMonths <= 60) ? calcMetric(m.hc, 'hc_for_age', whoStdData, true) : null;
        // WHO has no bmi_for_age table; the BMI chart falls back to CDC, so results must too,
        // otherwise the panel shows "-" while the chart plots a CDC-referenced marker.
        const bmiStdData = stdData['bmi_for_age'] ? stdData : (pData.growthData?.cdc?.[sex] || {});
        const bmiIsWho = bmiStdData === stdData ? standardForPoint === 'who' : false;
        const bmiRes = calcMetric(bmi || '', 'bmi_for_age', bmiStdData, bmiIsWho);

        let severeObesityPercentage = null;
        if (bmiRes && bmiRes.p > 97) {
          const p95Z = pData.zScores?.p95 || 1.64485;
          const p95Bmi = calculateValueAtZ(p95Z, bmiRes.lms.l, bmiRes.lms.m, bmiRes.lms.s);
          severeObesityPercentage = (bmi! / p95Bmi) * 100;
        }
        
        results = { wRes, hRes, hcRes, bmiRes, severeObesityPercentage };
      }

       // BP was entered, so a reading we cannot classify says which input is still missing
       // (`missing`) instead of looking like a bad measurement. `error` is reserved for
       // ages the AAP table does not cover.
       let bpResults = null;
       const bpEntered = m.sys !== '' && m.dia !== '' && Number(m.sys) > 0 && Number(m.dia) > 0;
       if (bpEntered && pData.bloodPressureData) {
         const ageYears = ageMonths === null || Number.isNaN(ageMonths) ? null : Math.floor(ageMonths / 12);
         if (!sex) {
           bpResults = { missing: 'sex' };
         } else if (ageYears === null) {
           bpResults = { error: 'Age required to calculate BP percentiles.' };
         } else if (ageYears < 1 || ageYears > 17) {
           bpResults = { error: 'BP percentiles only available for ages 1-17 years.' };
         } else if (ageYears < 13 && !(Number(m.height) > 0)) {
           bpResults = { missing: 'height' };
         } else {
           const bpDataAge = pData.bloodPressureData[sex]?.[ageYears];
           if (bpDataAge) {
             let selectedHeightKey = 'p50';
             if (ageYears < 13 && results?.hRes) {
               const hp = results.hRes.p;
               const keys = [5, 10, 25, 50, 75, 90, 95];
               const closest = keys.reduce((a, b) => Math.abs(b - hp) < Math.abs(a - hp) ? b : a);
               selectedHeightKey = 'p' + closest;
             }
             const thresholds = bpDataAge[selectedHeightKey] || bpDataAge['p50'];
             if (thresholds) {
               const { category, isCritical, display } = classifyBloodPressure(
                 ageYears, thresholds.p90, thresholds.p95, Number(m.sys), Number(m.dia)
               );
               bpResults = {
                 category,
                 recommendation: bpRecommendations?.[category] || null,
                 isCritical,
                 display,
               };
             } else {
               bpResults = { error: 'Threshold mapping failed.' };
             }
           } else {
             bpResults = { error: 'No BP reference data for this age.' };
           }
         }
       }

      return { ...m, standardForPoint, results, bpResults };
    });
  }, [basicMeasurements, activeStandard, sex, pData.growthData, pData.bloodPressureData]);

  // Primary reading = the starred timepoint. If none is starred (or the starred box
  // was removed) box 0 takes priority; if box 0 is blank (e.g. freshly imported
  // history fills the older boxes) fall back to the most recent reading by date.
  const primary = (() => {
    if (selectedId) {
      const sel = evaluatedMeasurements.find(m => m.id === selectedId);
      if (sel) return sel;
    }
    const box0 = evaluatedMeasurements[0];
    if (box0 && hasMeasurementData(box0)) return box0;
    const withData = evaluatedMeasurements.filter(hasMeasurementData);
    if (withData.length > 0) {
      return withData.reduce((a, b) => (measurementTimeMs(b, ageInputMode) > measurementTimeMs(a, ageInputMode) ? b : a));
    }
    return box0;
  })();

  // Height velocity (cm/year) between each reading and the previous shorter/earlier one.
  // Computed over the chronological height series so ordering of entry boxes is irrelevant.
  const heightVelocityById = useMemo(() => {
    const map = new Map<string, number>();
    const series = basicMeasurements
      .filter(m => m.height !== '' && Number(m.height) > 0 && m.chronDays !== null && !Number.isNaN(m.chronDays))
      .sort((a, b) => (a.chronDays as number) - (b.chronDays as number));
    for (let i = 1; i < series.length; i++) {
      const prev = series[i - 1];
      const curr = series[i];
      const dtYears = ((curr.chronDays as number) - (prev.chronDays as number)) / DAYS_PER_YEAR;
      if (dtYears > 0) {
        const v = (Number(curr.height) - Number(prev.height)) / dtYears;
        map.set(curr.id, v);
      }
    }
    return map;
  }, [basicMeasurements]);
  const primaryVelocity = primary ? heightVelocityById.get(primary.id) : undefined;

  // Ideal body weight estimates for the primary reading. Always CDC-referenced
  // (inside the util) and only offered for BMI above the 95th centile from 2 years.
  // The BMI centile is passed in so the gate matches the BMI card exactly.
  const ibw = useMemo(() => {
    const height = typeof primary?.height === 'number' ? primary.height : null;
    const weight = typeof primary?.weight === 'number' ? primary.weight : null;
    return calculateIdealBodyWeights(
      sex,
      primary?.ageMonths ?? null,
      height,
      weight,
      primary?.results?.bmiRes?.p ?? null
    );
  }, [sex, primary]);

  const exportText = useMemo(() => {
    if (!primary) return '';

    const primaryTime = measurementTimeMs(primary, ageInputMode);
    // Most recent reading older than the primary, used for the "[from ...]" change.
    const prev = evaluatedMeasurements
      .filter(em => em !== primary && hasMeasurementData(em) && measurementTimeMs(em, ageInputMode) < primaryTime)
      .sort((a, b) => measurementTimeMs(b, ageInputMode) - measurementTimeMs(a, ageInputMode))[0] ?? null;

    const parts: string[] = [];

    // Leading measured-date line (date mode only).
    if (ageInputMode === 'dob') {
      const measuredDate = formatMeasuredDateDDMMYY(primary.currentDate);
      if (measuredDate) parts.push(`Measured ${measuredDate}`);
    }

    const bpLabel = (cat?: string) =>
      cat === 'elevated' ? 'elevated BP'
      : cat === 'stage1' ? 'stage 1 hypertension'
      : cat === 'stage2' ? 'stage 2 hypertension'
      : 'normal';

    // Weight
    if (primary.weight !== '' && primary.results?.wRes) {
      let str = `Wt: ${primary.weight} kg ${formatCentileC(primary.results.wRes.p)}`;
      if (prev && prev.weight !== '' && prev.results?.wRes) {
        str += ` [from ${prev.weight} kg ${formatCentileC(prev.results.wRes.p)}]`;
      }
      parts.push(str);
    }

    // Height
    if (primary.height !== '' && primary.results?.hRes) {
      let str = `Ht: ${primary.height} cm ${formatCentileC(primary.results.hRes.p)}`;
      if (prev && prev.height !== '' && prev.results?.hRes) {
        str += ` [from ${prev.height} cm ${formatCentileC(prev.results.hRes.p)}]`;
      }
      parts.push(str);
    }

    // Head Circumference - shown whenever a positive value is entered, even without a reference range.
    if (Number(primary.hc) > 0) {
      let str = `HC: ${primary.hc} cm`;
      if (primary.results?.hcRes) str += ` ${formatCentileC(primary.results.hcRes.p)}`;
      if (prev && prev.hc !== '' && prev.results?.hcRes) {
        str += ` [from ${prev.hc} cm ${formatCentileC(prev.results.hcRes.p)}]`;
      }
      parts.push(str);
    }

    // BMI
    if (primary.bmi !== null && primary.results?.bmiRes) {
      let str = `BMI: ${primary.bmi.toFixed(1)} kg/m2 ${formatCentileC(primary.results.bmiRes.p)}`;
      if (prev && prev.bmi !== null && prev.results?.bmiRes) {
        str += ` [from ${prev.bmi.toFixed(1)} kg/m2 ${formatCentileC(prev.results.bmiRes.p)}]`;
      }
      parts.push(str);
    }

    // Blood pressure
    if (primary.sys !== '' && primary.dia !== '' && primary.bpResults?.category) {
      parts.push(`BP: ${primary.sys}/${primary.dia} mmHg, ${bpLabel(primary.bpResults.category)}`);
    }

    return parts.join('\n');
  }, [primary, evaluatedMeasurements, ageInputMode]);

  // Grow the clinical-notes box to fit its content (min 6 lines) instead of scrolling.
  useEffect(() => {
    const el = exportRef.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 16;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const minH = 6 * lineHeight + pad + border;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + border, minH)}px`;
  }, [exportText]);

  const trackingString = useMemo(() => {
    return encodeTrackingString(dob, sex, measurements, parsedGestation);
  }, [dob, sex, measurements, parsedGestation]);

  // Tracking strings are DoB- and sex-based, so they can't be produced in age-only mode (or
  // before a DoB and sex are entered). Importing a valid string always restores DoB mode.
  const trackingDisabled = ageInputMode === 'direct' || !dob || !sex;

  const handleCopyTracking = (e: ReactMouseEvent<HTMLInputElement>) => {
    e.currentTarget.select();
    if (!trackingString) return;
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    // Clipboard writes can reject (non-secure context / denied permission);
    // only confirm success once the write actually resolves.
    navigator.clipboard?.writeText(trackingString).then(() => {
      setCopiedString(true);
      copyTimerRef.current = setTimeout(() => setCopiedString(false), 1500);
    }).catch(() => { /* selection remains available for manual copy */ });
  };

  const handleImport = (val: string) => {
    setImportInput(val);
    const trimmed = val.trim();

    if (importDebounceRef.current) clearTimeout(importDebounceRef.current);
    if (importStatusRef.current) clearTimeout(importStatusRef.current);

    if (!trimmed) { setImportStatus(null); return; }

    // Decode on a short debounce so pasting/typing a partial string doesn't
    // flash spurious errors on every keystroke.
    importDebounceRef.current = setTimeout(() => {
      const decoded = decodeTrackingString(trimmed);
      if (decoded) {
        setSelectedId(null);
        setAgeInputMode('dob');
        setDob(decoded.dob);
        setSex(decoded.sex);
        // Restore gestation (weeks.days; drop a trailing ".0").
        setGestationalAgeStr(
          decoded.gestationDays === 0 ? String(decoded.gestationWeeks) : `${decoded.gestationWeeks}.${decoded.gestationDays}`
        );
        // Box 0 stays blank (reserved for a fresh entry); file the imported history
        // underneath it, newest reading first.
        const imported = [...decoded.measurements].sort(
          (a, b) => utcDayMs(b.currentDate) - utcDayMs(a.currentDate)
        );
        setMeasurements([makeMeasurement(`m_new_${Date.now()}`), ...imported]);
        setImportInput('');
        setImportStatus('success');

        // Re-derive the growth standard from the oldest (highest-age) timepoint so the
        // whole imported series plots. The standard is not stored in the string.
        const dobMs = utcDayMs(decoded.dob);
        if (!isNaN(dobMs)) {
          let maxMonths = 0;
          for (const mm of decoded.measurements) {
            const measMs = utcDayMs(mm.currentDate);
            if (!isNaN(measMs)) {
              const months = (measMs - dobMs) / (1000 * 3600 * 24 * DAYS_PER_MONTH);
              if (months > maxMonths) maxMonths = months;
            }
          }
          setManualStandard(maxMonths > 60 ? 'cdc' : 'who');
        }
      } else {
        setImportStatus('error');
      }
      importStatusRef.current = setTimeout(() => setImportStatus(null), 2000);
    }, 400);
  };

  const updateMeasurement = (index: number, field: keyof Measurement, value: any) => {
    const newMeasurements = [...measurements];
    newMeasurements[index] = { ...newMeasurements[index], [field]: value };
    setMeasurements(newMeasurements);
  };

  const addMeasurement = () => {
    setMeasurements((prev) => [...prev, makeMeasurement(`m${Date.now()}`)]);
  };

  const removeMeasurement = (id: string) => {
    if (selectedId === id) setSelectedId(null);
    setMeasurements(measurements.filter(m => m.id !== id));
  };

  const resetAll = () => {
    if (importDebounceRef.current) clearTimeout(importDebounceRef.current);
    if (importStatusRef.current) clearTimeout(importStatusRef.current);
    setSelectedId(null);
    setSex(null);
    setAgeInputMode('dob');
    setDob('');
    setMeasurements([makeMeasurement('m1')]);
    setGestationalAgeStr('40');
    setManualStandard('who');
    setActiveTab('Weight');
    setChartRange(24);
    setImportInput('');
    setImportStatus(null);
  };

  const handleStandardChange = (std: 'who' | 'cdc') => {
    if (std === 'who' && isCdcForced) return;
    if (std === 'cdc' && isWhoForced) return;
    setManualStandard(std);
  };

  // Auto-pick the axis so the whole series stays on-scale. We key the effect on the
  // *range the oldest reading needs* (not a coarse age bucket), so adding an older
  // reading — even one that crosses 12y while staying inside the old 5-18 band — updates
  // the axis. Manual range picks are preserved because the key only changes when the
  // required range, tab, or standard actually changes.
  const neededRange = defaultRangeFor(activeTab as MetricTab, activeStandard, maxAgeMonths);
  const rangeContext = `${activeStandard}|${maxAgeMonths === null ? 'empty' : neededRange}|${activeTab}`;
  const lastRangeContextRef = useRef(rangeContext);

  useEffect(() => {
    if (lastRangeContextRef.current === rangeContext) return;
    lastRangeContextRef.current = rangeContext;
    if (maxAgeMonths !== null) {
      setChartRange(neededRange);
    } else {
      const opts = rangeOptionsFor(activeTab as MetricTab, activeStandard).map(o => o.value);
      setChartRange(opts.includes(24) ? 24 : opts[0]);
    }
  }, [rangeContext, activeTab, activeStandard, neededRange, maxAgeMonths]);

  return (
    <div className="min-h-screen flex flex-col xl:flex-row w-full bg-[#f8fafc] dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-sans">
      {/* Sidebar Input Panel */}
      <aside className="w-full xl:w-[320px] bg-white dark:bg-slate-900 border-b xl:border-b-0 xl:border-r border-slate-200 dark:border-slate-800 flex flex-col shrink-0 print:hidden">
        <div className="p-6 pb-4 border-b border-transparent bg-white dark:bg-slate-900 sticky top-0 z-10 shrink-0 flex justify-between items-start">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 leading-tight dark:text-slate-100">
              Paediatric Growth Charts
            </h1>
            <p className="text-xs text-slate-500 mt-1 dark:text-slate-300">CitrusSquid v1.7.3</p>
          </div>
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)} 
            tabIndex={-1}
            className="p-2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>

        <div className="p-6 pt-0 space-y-5 overflow-visible mt-2">
           {!pData?.growthData && (
              <div className="bg-red-100 p-4 rounded text-red-800">
                 ERROR: pData failed to load! Object: {JSON.stringify(pData)}
              </div>
           )}
          <section className="space-y-4">
            <div className="flex flex-col gap-3 pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-4 text-sm font-medium">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={ageInputMode === 'dob'} onChange={() => setAgeInputMode('dob')} className="accent-blue-600 w-4 h-4" /> Date of Birth
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={ageInputMode === 'direct'} onChange={() => setAgeInputMode('direct')} className="accent-blue-600 w-4 h-4" /> Age
                </label>
              </div>
              <div className="flex items-center gap-4 text-sm font-medium">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={sex === 'male'} onChange={() => setSex('male')} className="accent-blue-600 w-4 h-4" /> Male
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={sex === 'female'} onChange={() => setSex('female')} className="accent-blue-600 w-4 h-4" /> Female
                </label>
              </div>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                {ageInputMode === 'dob' ? (
                  <div className="grid grid-cols-1 gap-3">
                    <div className="flex flex-col">
                      <label className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">Date of Birth</label>
                      <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className="w-full text-sm border border-slate-200 bg-white text-slate-900 rounded px-2.5 py-1.5 focus:outline-none focus:border-blue-500" />
                    </div>
                  </div>
                ) : (
                  <div>
                    {/* Direct age mapping moved to measurements loop */}
                  </div>
                )}
                
                <div className="pt-3">
                   <label className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-1 flex items-center justify-between">
                     <span>Gestation <span className="font-normal text-slate-400 dark:text-slate-300 text-xs">(Optional)</span></span>
                     <span className="text-slate-400 dark:text-slate-300 text-xs bg-slate-100 dark:bg-slate-800 rounded-full w-4 h-4 flex items-center justify-center cursor-help" title="Enter weeks.days, e.g., 37.4 for 37 weeks and 4 days">?</span>
                   </label>
                   <input type="text" placeholder="40" value={gestationalAgeStr} onChange={(e) => setGestationalAgeStr(e.target.value)} className={`w-full text-sm border bg-white text-slate-900 rounded px-3 py-1.5 focus:outline-none ${gestationError ? 'border-red-400 focus:border-red-500' : 'border-slate-200 focus:border-blue-500'}`} />
                   {gestationError ? (
                     <p className="text-xs text-red-600 dark:text-red-400 mt-1">{gestationError}</p>
                   ) : (
                     <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">Format weeks.days, e.g. 32.5 = 32 wks 5 days (21–44).</p>
                   )}
                </div>
              </div>
            </div>

            <div className="pt-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-200 block mb-2">Growth Chart Standard</label>
              <div className="flex rounded-md border border-slate-300 dark:border-slate-800 overflow-hidden mb-3">
                <button onClick={() => handleStandardChange('who')} disabled={isCdcForced} className={`flex-1 py-1.5 text-xs font-semibold transition-all ${activeStandard === 'who' ? 'bg-blue-600 text-white' : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'} ${isCdcForced ? 'opacity-50 cursor-not-allowed bg-slate-100 dark:bg-slate-900' : ''}`}>WHO (0-5y)</button>
                <button onClick={() => handleStandardChange('cdc')} disabled={isWhoForced} className={`flex-1 py-1.5 text-xs font-semibold transition-all ${activeStandard === 'cdc' ? 'bg-blue-600 text-white' : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'} ${isWhoForced ? 'opacity-50 cursor-not-allowed bg-slate-100 dark:bg-slate-900' : ''}`}>CDC (2-20y)</button>
              </div>
            </div>
          </section>

          <hr className="border-slate-100 dark:border-slate-800" />

           <section className="space-y-4">
             <div className="flex justify-between items-center">
               <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Measurements</h2>
             </div>
            
             <div className="space-y-3">
               {measurements.map((m, index) => (
                <div key={m.id} className="relative p-3 border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                  <button
                    onClick={() => setSelectedId(m.id)}
                    tabIndex={-1}
                    title="Show this reading in Results"
                    aria-label="Set as primary reading"
                    className={`absolute -top-2 ${index > 0 ? 'right-8' : '-right-2'} w-6 h-6 flex items-center justify-center rounded-full z-10 shadow-sm border transition-colors ${primary?.id === m.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'}`}
                  >
                    <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill={primary?.id === m.id ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={primary?.id === m.id ? 0 : 2} strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                    </svg>
                  </button>
                  {index > 0 && (
                      <button onClick={() => removeMeasurement(m.id)} tabIndex={-1} className="absolute -top-2 -right-2 w-6 h-6 flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 z-10 shadow-sm border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                       <span className="text-xs font-bold font-sans select-none leading-none -mt-0.5">&times;</span>
                     </button>
                  )}
                  
                  <div className="mb-2">
                    {ageInputMode === 'dob' ? (
                      <div className="flex flex-col">
                        <label className="text-xs text-slate-700 dark:text-slate-200 mb-1">Date</label>
                        <input type="date" value={m.currentDate} onChange={(e) => updateMeasurement(index, 'currentDate', e.target.value)} className="w-full text-sm border border-slate-200 bg-white text-slate-900 rounded px-2.5 py-1.5 focus:outline-none focus:border-blue-500" />
                      </div>
                    ) : (
                      <div className="flex gap-2 items-end">
                        <div className="flex flex-col flex-1">
                          <label className="text-xs text-slate-700 dark:text-slate-200 mb-1 self-start">Years</label>
                          <input type="number" min="0" placeholder="" value={m.directAgeY} onChange={(e) => updateMeasurement(index, 'directAgeY', e.target.value === '' ? '' : Number(e.target.value))} className="no-spinners w-full text-sm border border-slate-200 bg-white text-slate-900 rounded px-2 py-1.5 focus:outline-none focus:border-blue-500" />
                        </div>
                        <div className="flex flex-col flex-1">
                          <label className="text-xs text-slate-700 dark:text-slate-200 mb-1 self-start">Months</label>
                          <input type="number" min="0" value={m.directAgeM} onChange={(e) => updateMeasurement(index, 'directAgeM', e.target.value === '' ? '' : Number(e.target.value))} className="no-spinners w-full text-sm border border-slate-200 bg-white text-slate-900 rounded px-2 py-1.5 focus:outline-none focus:border-blue-500" />
                        </div>
                        <div className="flex flex-col flex-1">
                          <label className="text-xs text-slate-700 dark:text-slate-200 mb-1 self-start">Days</label>
                          <input type="number" min="0" value={m.directAgeD} onChange={(e) => updateMeasurement(index, 'directAgeD', e.target.value === '' ? '' : Number(e.target.value))} className="no-spinners w-full text-sm border border-slate-200 bg-white text-slate-900 rounded px-2 py-1.5 focus:outline-none focus:border-blue-500" />
                        </div>
                      </div>
                    )}
                  </div>
                  
                  <div className="flex gap-2 mb-2">
                    <div className="flex-1 flex gap-2 items-end">
                      <div className="w-full">
                        <label className="text-xs text-slate-700 dark:text-slate-200 block mb-1 truncate">Wt (kg)</label>
                        <div className="flex items-center border border-slate-200 rounded px-2 bg-white">
                          <input type="number" step="0.01" value={m.weight} onChange={(e) => updateMeasurement(index, 'weight', e.target.value ? Number(e.target.value) : '')} className="no-spinners w-full min-w-[20px] text-sm py-1.5 focus:outline-none text-slate-900 bg-white" />
                        </div>
                      </div>
                    </div>
                    <div className="flex-1 flex gap-2 items-end">
                      <div className="w-full">
                        <label className="text-xs text-slate-700 dark:text-slate-200 block mb-1 truncate">Len (cm)</label>
                        <div className="flex items-center border border-slate-200 rounded px-2 bg-white">
                          <input type="number" step="0.1" value={m.height} onChange={(e) => updateMeasurement(index, 'height', e.target.value ? Number(e.target.value) : '')} className="no-spinners w-full min-w-[20px] text-sm py-1.5 focus:outline-none text-slate-900 bg-white" />
                        </div>
                      </div>
                    </div>
                    <div className="flex-1 flex gap-2 items-end">
                      <div className="w-full">
                         <label className="text-xs text-slate-700 dark:text-slate-200 block mb-1 truncate">HC (cm)</label>
                         <div className="flex items-center border border-slate-200 rounded px-2 bg-white">
                           <input type="number" step="0.1" value={m.hc} onChange={(e) => updateMeasurement(index, 'hc', e.target.value ? Number(e.target.value) : '')} className="no-spinners w-full min-w-[20px] text-sm py-1.5 focus:outline-none text-slate-900 bg-white" />
                         </div>
                      </div>
                    </div>
                  </div>

                  {(() => {
                    const em = evaluatedMeasurements[index];
                    if (!em) return null;
                    const hasValues = em.results?.wRes || em.results?.hRes || em.results?.hcRes;
                    return (
                      <div className="mb-2 text-[10px] text-slate-600 dark:text-slate-400 space-y-0.5">
                        {em.chronString ? (
                          em.correctedString ? (
                            <div className="font-semibold">Chn. Age: {em.chronString} | Cor. Age: {em.correctedString}</div>
                          ) : (
                            <div className="font-semibold">Age: {em.chronString}</div>
                          )
                        ) : (
                          <div className="font-semibold text-slate-400 dark:text-slate-500">Age: --</div>
                        )}
                        {hasValues && (
                          <div className="flex gap-2">
                            {em.results?.wRes && <span>Wt: {formatPercent(em.results.wRes.p)}</span>}
                            {em.results?.hRes && <span>Ht: {formatPercent(em.results.hRes.p)}</span>}
                            {em.results?.hcRes && <span>HC: {formatPercent(em.results.hcRes.p)}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  
                  {index === 0 && (
                     <div className="pt-1">
                        <div className="flex justify-between items-center mb-1">
                           <label className="text-xs text-slate-700 dark:text-slate-200 block">Blood Pressure (mmHg)</label>
                        </div>
                        <div className="flex justify-between gap-4">
                           <div className="flex-1">
                             <input type="number" placeholder="Sys" value={m.sys} onChange={(e) => updateMeasurement(index, 'sys', e.target.value ? Number(e.target.value) : '')} className="no-spinners w-full text-sm border border-slate-200 bg-white text-slate-900 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500" />
                           </div>
                           <div className="flex-1 text-center font-bold text-slate-300 dark:text-slate-600 mt-1">/</div>
                           <div className="flex-1">
                             <input type="number" placeholder="Dia" value={m.dia} onChange={(e) => updateMeasurement(index, 'dia', e.target.value ? Number(e.target.value) : '')} className="no-spinners w-full text-sm border border-slate-200 bg-white text-slate-900 rounded px-3 py-1.5 focus:outline-none focus:border-blue-500" />
                           </div>
                        </div>
                     </div>
                  )}
                  
                </div>
              ))}
              
              {measurements.length === 0 ? (
                 <button onClick={addMeasurement} className="w-full border-2 border-dashed border-slate-300 text-slate-500 rounded-lg py-4 text-sm font-medium hover:border-blue-400 hover:text-blue-600 transition-colors">
                    + Add Measurement
                 </button>
               ) : (
                  <button onClick={addMeasurement} className="w-full bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 font-medium py-2 rounded shadow-sm text-sm transition-colors">
                    Add
                  </button>
               )}
             </div>
             
             <div className="pt-2 space-y-3 mb-8">
              <button onClick={resetAll} tabIndex={-1} className="w-full bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 font-medium py-2 rounded shadow-sm text-sm transition-colors">
                Clear
              </button>

              <div className="pt-2">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-200 block mb-1">
                  Import String
                </label>
                <input
                  type="text"
                  placeholder="Paste string..."
                  value={importInput}
                  onChange={(e) => handleImport(e.target.value)}
                  tabIndex={-1}
                  className="w-full text-xs font-mono border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 rounded px-2.5 py-1.5 focus:outline-none focus:border-blue-500"
                />
                {importStatus === 'success' && (
                  <p className="text-xs text-green-600 dark:text-green-400 font-medium mt-1 transition-all">
                    Import Successful
                  </p>
                )}
                {importStatus === 'error' && (
                  <p className="text-xs text-red-600 dark:text-red-400 font-medium mt-1 transition-all">
                    Error
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>
      </aside>

      {/* Middle Results Panel */}
      <section className="w-full xl:w-[380px] bg-[#fafafa] dark:bg-slate-950 border-r border-b xl:border-b-0 border-slate-200 dark:border-slate-800 flex flex-col shrink-0 p-6 md:p-8 print:hidden">
        <h2 className="text-2xl flex justify-center font-bold text-slate-800 dark:text-slate-100 mb-6">Results</h2>
        
        <div className="bg-white dark:bg-slate-900 border text-center border-slate-200 dark:border-slate-800 shadow-sm rounded-lg py-3 px-4 mb-8">
          <p className="text-slate-600 dark:text-slate-300 text-sm">Chronological Age: <span className="font-semibold text-slate-800 dark:text-slate-100">{primary?.chronString || (primary?.ageMonths !== null ? `${primary?.ageMonths?.toFixed(1)} mos` : '--')}</span></p>
          {primary?.correctedString && (
            <p className="text-blue-600 dark:text-blue-400 text-sm mt-1">Corrected Age: <span className="font-semibold text-blue-800 dark:text-blue-300">{primary.correctedString}</span></p>
          )}
        </div>

        <h3 className="text-lg font-semibold text-center text-slate-800 dark:text-slate-100 mb-4">Growth Percentiles</h3>
        <div className="grid grid-cols-3 gap-3 mb-8">
          {/* Weight */}
          <div className="bg-[#fcfcff] dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/50 rounded-lg p-3 text-center flex flex-col justify-center">
            <h4 className="text-purple-800 dark:text-purple-300 text-xs font-medium mb-1">Weight</h4>
            <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{formatPercent(primary?.results?.wRes?.p)}</div>
            <div className="text-[10px] text-purple-600/80 dark:text-purple-400 mt-1">{primary?.results?.wRes ? `${primary.results.wRes.value} kg` : '-'}</div>
          </div>
          
          {/* Height */}
          <div className="bg-[#fcfcff] dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/50 rounded-lg p-3 text-center flex flex-col justify-center">
            <h4 className="text-purple-800 dark:text-purple-300 text-xs font-medium mb-1">Height</h4>
            <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{formatPercent(primary?.results?.hRes?.p)}</div>
            <div className="text-[10px] text-purple-600/80 dark:text-purple-400 mt-1">{primary?.results?.hRes ? `${primary.results.hRes.value} cm` : '-'}</div>
          </div>

          {/* Head Circumference */}
          <div className="bg-[#fcfcff] dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/50 rounded-lg p-3 text-center flex flex-col justify-center">
            <h4 className="text-purple-800 dark:text-purple-300 text-xs font-medium mb-1">Head Circ.</h4>
            <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{formatPercent(primary?.results?.hcRes?.p)}</div>
            <div className="text-[10px] text-purple-600/80 dark:text-purple-400 mt-1">{primary?.results?.hcRes ? `${primary.results.hcRes.value} cm` : '-'}</div>
          </div>

          {/* BMI */}
          <div className="bg-[#fcfcff] dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/50 rounded-lg p-3 text-center flex flex-col justify-center">
            <h4 className="text-purple-800 dark:text-purple-300 text-xs font-medium mb-1">BMI</h4>
            <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{formatPercent(primary?.results?.bmiRes?.p)}</div>
            <div className="text-[10px] text-purple-600/80 dark:text-purple-400 mt-1">{primary?.bmi ? `${primary.bmi.toFixed(1)} kg/m²` : '-'}</div>
          </div>
          
          <div className="bg-[#fcfcff] dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/50 rounded-lg p-3 text-center flex flex-col justify-center">
            <h4 className="text-purple-800 dark:text-purple-300 text-xs font-medium mb-1">H. Vel.</h4>
            <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{primaryVelocity !== undefined ? primaryVelocity.toFixed(1) : '-'}</div>
            <div className="text-[10px] text-purple-600/80 dark:text-purple-400 mt-1">cm/year</div>
          </div>

          <div className="bg-[#fcfcff] dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/50 rounded-lg p-3 text-center flex flex-col justify-center">
            <h4 className="text-purple-800 dark:text-purple-300 text-xs font-medium mb-1">95th BMI</h4>
            <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{primary?.results?.severeObesityPercentage ? Math.round(primary.results.severeObesityPercentage) : '-'}</div>
            <div className="text-[10px] text-purple-600/80 dark:text-purple-400 mt-1">{primary?.results?.severeObesityPercentage ? '%' : '-'}</div>
          </div>
        </div>

        <h3 className="text-lg font-semibold text-center text-slate-800 dark:text-slate-100 mb-4">Blood Pressure Assessment</h3>
        <div className={`rounded-lg border p-5 text-center ${primary?.bpResults?.category === 'stage2' || primary?.bpResults?.category === 'stage1' ? 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-900/50' : primary?.bpResults?.category === 'elevated' ? 'bg-orange-50 border-orange-200 dark:bg-orange-950/20 dark:border-orange-900/50' : primary?.bpResults?.category === 'normal' ? 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-900/50' : 'bg-slate-50 border-slate-200 dark:bg-slate-900 dark:border-slate-800'}`}>
           <p className={`text-xl font-bold ${primary?.bpResults?.category === 'stage2' || primary?.bpResults?.category === 'stage1' ? 'text-red-700 dark:text-red-400' : primary?.bpResults?.category === 'elevated' ? 'text-orange-700 dark:text-orange-400' : primary?.bpResults?.category === 'normal' ? 'text-green-700 dark:text-green-400' : 'text-slate-600 dark:text-slate-300'}`}>
             {bpHeadline(primary?.bpResults)}
           </p>
           {Number(primary?.sys) > 0 && Number(primary?.dia) > 0 && <p className="text-sm text-red-700/80 dark:text-red-400/80 mt-2">Measured BP: {primary.sys}/{primary.dia} mmHg</p>}
           {!!primary?.bpResults?.category && primary.ageMonths !== null && primary.ageMonths >= 156 && <p className="text-xs text-red-600/70 dark:text-red-400/70 mt-2">Age ≥ 13 years uses fixed thresholds.</p>}
           
            {!primary?.bpResults?.error && primary?.bpResults?.display && (
              <div className="mt-3 pt-3 border-t border-slate-200/50 dark:border-slate-700/50 flex flex-col gap-1 text-[11px] text-slate-600 dark:text-slate-400 font-medium">
                {primary.bpResults.display.type === 'fixed' ? (
                   <>
                      <p>Elevated Threshold: 120 / {"<"}80 mmHg</p>
                      <p>Stage 1 Threshold: 130 / 80 mmHg</p>
                      <p>Stage 2 Threshold: 140 / 90 mmHg</p>
                   </>
                ) : (
                   <>
                      <p>Elevated (≥90th): {primary.bpResults.display.elevated[0]} / {primary.bpResults.display.elevated[1]} mmHg</p>
                      <p>Stage 1 (≥95th): {primary.bpResults.display.stage1[0]} / {primary.bpResults.display.stage1[1]} mmHg</p>
                      <p>Stage 2: {primary.bpResults.display.stage2[0]} / {primary.bpResults.display.stage2[1]} mmHg</p>
                   </>
                )}
              </div>
            )}
        </div>

        {primary?.bpResults?.recommendation && (
          <div className="mt-6 space-y-6">
            <div>
              <h4 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-3">{primary.bpResults.recommendation.title || 'Management Routine'}:</h4>
              <div className="space-y-1.5">
                {Array.isArray(primary.bpResults.recommendation.points) ? primary.bpResults.recommendation.points.map((line: string, i: number) => (
                  <p key={i} className={`text-sm ${line.startsWith('-') ? 'pl-4 text-slate-600 dark:text-slate-400' : 'text-slate-800 dark:text-slate-200 font-medium mt-2'}`}>
                    {line}
                  </p>
                )) : null}
              </div>
            </div>

            {primary.bpResults.isCritical && (
              <div className="p-4 bg-red-100 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg">
                <h4 className="text-sm font-bold text-red-800 dark:text-red-400 mb-2 truncate flex items-center gap-1.5">
                  <Stethoscope size={16} /> {bpRecommendations.critical.title}
                </h4>
                <div className="space-y-1.5">
                  {bpRecommendations.critical.points.map((line: string, i: number) => (
                    <p key={i} className="text-xs text-red-700 dark:text-red-300 leading-relaxed italic">
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Export Clinical Notes */}
        <div className="mt-8 pt-6 border-t border-slate-200 dark:border-slate-800 print:hidden">
           <h3 className="text-sm font-semibold text-center text-slate-800 dark:text-slate-100 mb-2">Export - Clinical Notes</h3>
           <textarea 
              ref={exportRef}
   readOnly 
   rows={6}
              className="w-full p-3 text-xs bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none overflow-hidden"
              value={exportText}
              onClick={(e) => { e.currentTarget.select(); }}
           />
        </div>

         {/* Export Tracking String */}
         <div className="mt-4 print:hidden">
             <h3 className="text-sm font-semibold text-center text-slate-800 dark:text-slate-100 mb-2">Export String</h3>
            <div className="relative">
              <input 
                 type="text"
                 readOnly 
                 disabled={trackingDisabled}
                 placeholder={trackingDisabled ? (ageInputMode === 'direct' || !dob ? 'Enter DoB' : 'Select Gender') : ''}
                  className={`w-full p-2.5 text-xs font-mono bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 ${trackingDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer select-all'}`}
                 value={trackingDisabled ? '' : trackingString}
                 onClick={trackingDisabled ? undefined : handleCopyTracking}
              />
             {copiedString && (
               <span className="absolute right-2 top-2 text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded font-medium shadow-sm">
                 Copied!
               </span>
             )}
            </div>
         </div>

         {/* Ideal Body Weight - obese children only (CDC BMI above the 95th centile, from 2 years).
             Every other reading, including under 2 years, renders nothing at all here. */}
         {ibw.state === 'boxes' && (
           <div className="mt-4 print:hidden">
             <h3 className="text-sm font-semibold text-center text-slate-800 dark:text-slate-100 mb-2">IBW</h3>
             <div className="grid grid-cols-3 gap-3">
               {[
                 { label: 'McLaren', estimate: ibw.mcLaren },
                 { label: 'Moore', estimate: ibw.moore },
                 { label: 'BMI50', estimate: ibw.bmi50 },
               ].map(({ label, estimate }) => (
                 <div key={label} className="bg-[#fcfcff] dark:bg-purple-950/20 border border-purple-200 dark:border-purple-900/50 rounded-lg py-3 px-2 text-center flex flex-col justify-center">
                   <h4 className="text-purple-800 dark:text-purple-300 text-xs font-medium mb-1">{label}</h4>
                   <div className="text-lg font-bold text-slate-800 dark:text-slate-100 whitespace-nowrap">
                     {estimate ? `${estimate.value.toFixed(1)} kg` : 'N/A'}
                   </div>
                   {/* Always rendered (blank when there is no cap) so the label and the
                       value line up across all three cards. */}
                   <div className="text-[10px] text-purple-600/80 dark:text-purple-400 mt-1">
                     {estimate?.capped ? '(capped)' : '\u00A0'}
                   </div>
                 </div>
               ))}
             </div>
           </div>
         )}
      </section>

      {/* Main Chart Area Right Panel */}
      <main className="flex-1 flex flex-col bg-white dark:bg-slate-900 p-6 md:p-8 xl:p-10" id="pdf-export-area">
        <div className="flex flex-col gap-4 mb-4 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex gap-6 print:hidden">
             {['Weight', 'Height', 'BMI', 'HC'].map(tab => (
                 <button 
                     key={tab}
                      onClick={() => setActiveTab(tab)}
                     className={`pb-3 sm:pb-0 text-sm font-medium transition-all relative ${activeTab === tab ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-300 hover:text-slate-800 dark:hover:text-slate-100'}`}
                 >
                     {tab}
                     {activeTab === tab && <div className="absolute bottom-[0px] sm:bottom-[-13px] left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400" />}
                 </button>
             ))}
          </div>
          
          <div className="flex items-center justify-between gap-4 print:hidden">
            <button onClick={() => window.print()} className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 px-3 py-1.5 rounded text-xs font-semibold shadow-sm transition">
               Export PDF
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Range:</span>
              <div className="flex gap-1">
                {rangeOptionsFor(activeTab as MetricTab, activeStandard).map(opt => (
                    <button
                      key={opt.label}
                      onClick={() => setChartRange(opt.value)}
                      className={`px-2.5 py-1 text-[10px] font-bold rounded border transition-all ${
                        chartRange === opt.value
                          ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                          : 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      {opt.label}
                    </button>
                ))}
              </div>
              <button 
                onClick={() => setShowInfo(true)} 
                className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300 font-bold text-xs ml-2 hover:bg-slate-300 dark:hover:bg-slate-600 transition"
              >
                ?
              </button>
            </div>
          </div>
        </div>

        {showInfo && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 print:hidden">
            <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-md p-6 relative">
              <button onClick={() => setShowInfo(false)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 font-bold text-lg">
                ✕
              </button>
              <h3 className="text-lg font-bold mb-4 text-slate-900 dark:text-white">Data Sources</h3>
              
              <div className="space-y-5 text-sm text-slate-600 dark:text-slate-300">
                <div>
                  <h4 className="font-bold text-slate-800 dark:text-slate-100">WHO</h4>
                  <ul className="list-disc pl-5 mb-1 text-slate-700 dark:text-slate-400">
                    <li>0-5 years: weight, length, head circumference</li>
                  </ul>
                  <a href="https://www.who.int/tools/child-growth-standards/standards" target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline text-xs break-all">https://www.who.int/tools/child-growth-standards/standards</a>
                </div>
                
                <div>
                  <h4 className="font-bold text-slate-800 dark:text-slate-100">CDC</h4>
                  <ul className="list-disc pl-5 mb-1 text-slate-700 dark:text-slate-400">
                    <li>2-20 years: weight, length, BMI</li>
                  </ul>
                  <a href="https://www.cdc.gov/growthcharts/cdc-data-files.htm" target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline text-xs break-all">https://www.cdc.gov/growthcharts/cdc-data-files.htm</a>
                </div>

                <div>
                  <h4 className="font-bold text-slate-800 dark:text-slate-100">Additional source</h4>
                  <a href="https://github.com/rcpch/growth-references" target="_blank" rel="noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline text-xs break-all">https://github.com/rcpch/growth-references</a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Print/PDF output: the core parameters table first, then the charts two to a
            page. .pdf-page carries the print styling in index.css (page breaks, black on white). */}
        <div className="hidden print:block pdf-page mb-8">
           <h1 className="text-xl font-bold mb-4">Patient Growth Record ({sex ? sex.toUpperCase() : ''})</h1>
           <p className="text-sm mb-4">DOB: {dob || '--'}</p>
           <table className="w-full text-left border-collapse text-sm">
             <thead>
               <tr className="border-b border-slate-300">
                 <th className="py-2">Date</th>
                 <th className="py-2">Age</th>
                 <th className="py-2">Weight</th>
                 <th className="py-2">Height</th>
                 <th className="py-2">HC</th>
                 <th className="py-2">BMI</th>
               </tr>
             </thead>
             <tbody>
               {evaluatedMeasurements.filter(m => Number(m.weight) > 0 || Number(m.height) > 0 || Number(m.hc) > 0).map(em => (
                 <tr key={em.id} className="border-b border-slate-200">
                   <td className="py-2">{ageInputMode === 'dob' && em.currentDate ? em.currentDate : '--'}</td>
                   <td className="py-2">{em.correctedString ? `${em.chronString} (cor. ${em.correctedString})` : (em.chronString || '--')}</td>
                   <td className="py-2">{Number(em.weight) > 0 ? `${em.weight}kg${em.results?.wRes ? ` (${em.results.wRes.p.toFixed(0)}%)` : ''}` : '--'}</td>
                   <td className="py-2">{Number(em.height) > 0 ? `${em.height}cm${em.results?.hRes ? ` (${em.results.hRes.p.toFixed(0)}%)` : ''}` : '--'}</td>
                   <td className="py-2">{Number(em.hc) > 0 ? `${em.hc}cm${em.results?.hcRes ? ` (${em.results.hcRes.p.toFixed(0)}%)` : ''}` : '--'}</td>
                   <td className="py-2">{em.bmi !== null && em.bmi > 0 ? `${em.bmi.toFixed(1)}${em.results?.bmiRes ? ` (${em.results.bmiRes.p.toFixed(0)}%)` : ''}` : '--'}</td>
                 </tr>
               ))}
             </tbody>
           </table>
        </div>

        {/* Two printed charts per page, in black on white, at the selected Range axis,
            skipping any parameter that has nothing to plot (e.g. head circumference once a
            child is past the 0-5y curve). */}
        <PrintCharts
          sex={sex}
          standard={activeStandard}
          dob={dob}
          maxAgeMonths={maxAgeMonths}
          activeTab={activeTab as MetricTab}
          selectedRange={chartRange}
          measurements={evaluatedMeasurements}
        />

        {/* The interactive chart is screen-only: the printed copies above guarantee a
            full-size, un-zoomed chart for every parameter on paper. */}
        <div className="flex-1 print:hidden">
           {activeTab === 'Weight' && (() => {
              const source = chartSourceFor('Weight', activeStandard, chartRange, sex);

              return (
                <div className="h-full min-h-[500px]">
                    <h3 className="text-center font-semibold text-slate-800 dark:text-slate-100 mb-1">
                      {source.title} ({source.standard.toUpperCase()})
                    </h3>
                    <GrowthChart 
                        datasetData={source.dataset}
                        standard={source.standard}
                        metric="Weight (kg)"
                        patientPoints={evaluatedMeasurements.filter(m => Number(m.weight) > 0 && m.ageMonths !== null).map(m => ({ age: m.ageMonths as number, value: m.weight as number, p: m.results?.wRes?.p }))}
                        isDarkMode={isDarkMode}
                        initialRange={chartRange}
                    />
                </div>
              );
           })()}

           {activeTab === 'Height' && (() => {
              const source = chartSourceFor('Height', activeStandard, chartRange, sex);

              return (
                <div className="h-full min-h-[500px]">
                    <h3 className="text-center font-semibold text-slate-800 dark:text-slate-100 mb-1">
                      {source.title} ({source.standard.toUpperCase()})
                    </h3>
                    <GrowthChart 
                        datasetData={source.dataset}
                        standard={source.standard}
                        metric="Height (cm)"
                        patientPoints={evaluatedMeasurements.filter(m => Number(m.height) > 0 && m.ageMonths !== null).map(m => ({ age: m.ageMonths as number, value: m.height as number, p: m.results?.hRes?.p, velocity: heightVelocityById.get(m.id) }))}
                        isDarkMode={isDarkMode}
                        initialRange={chartRange}
                    />
                </div>
              );
           })()}

           {activeTab === 'HC' && (() => {
              const source = chartSourceFor('HC', activeStandard, chartRange, sex);

              return (
                <div className="h-full min-h-[500px]">
                    <h3 className="text-center font-semibold text-slate-800 dark:text-slate-100 mb-1">
                      {source.title} ({source.standard.toUpperCase()})
                    </h3>
                    <GrowthChart 
                        datasetData={source.dataset}
                        standard={source.standard}
                        metric="Head Circumference (cm)"
                        patientPoints={evaluatedMeasurements.filter(m => Number(m.hc) > 0 && m.ageMonths !== null).map(m => ({ age: m.ageMonths as number, value: m.hc as number, p: m.results?.hcRes?.p }))}
                        isDarkMode={isDarkMode}
                        initialRange={chartRange}
                    />
                </div>
              );
           })()}

           {activeTab === 'BMI' && (() => {
               const source = chartSourceFor('BMI', activeStandard, chartRange, sex);

               return (
                  <div className="h-full min-h-[500px]">
                      <h3 className="text-center font-semibold text-slate-800 dark:text-slate-100 mb-1">
                        {source.title} ({source.standard.toUpperCase()})
                      </h3>
                      <GrowthChart 
                          datasetData={source.dataset}
                          standard={source.standard}
                          metric="BMI"
                          patientPoints={evaluatedMeasurements.filter(m => m.bmi !== null && m.ageMonths !== null).map(m => ({ age: m.ageMonths as number, value: m.bmi as number, p: m.results?.bmiRes?.p }))}
                          isDarkMode={isDarkMode}
                          initialRange={chartRange}
                      />
                  </div>
               );
           })()}
        </div>
      </main>
    </div>
  );
}
