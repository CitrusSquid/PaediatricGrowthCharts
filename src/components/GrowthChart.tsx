import React, { useEffect, useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  ReferenceLine
} from 'recharts';
import { generateChartData, formatAgeString } from '../utils/growthMath';
import { paediatricData as pData } from '../paediatric_data';

interface GrowthChartProps {
  datasetData: any[];
  standard: 'who' | 'cdc';
  metric: string;
  patientPoints?: { age: number; value: number; p?: number; velocity?: number }[];
  isDarkMode?: boolean;
  initialRange?: number;
  /** Print/PDF output: fixed size, no interaction, black-on-white palette. */
  staticPrint?: boolean;
}

const DARK_COLORS: Record<string, string> = {
  p1: '#38bdf8',   // sky-400
  p3: '#7dd3fc',   // sky-300
  p5: '#7dd3fc',   // sky-300
  p10: '#cbd5e1',  // slate-300
  p15: '#cbd5e1',  // slate-300
  p25: '#cbd5e1',  // slate-300
  p50: '#ffffff',  // pure white for median
  p75: '#cbd5e1',  // slate-300
  p85: '#cbd5e1',  // slate-300
  p90: '#cbd5e1',  // slate-300
  p95: '#7dd3fc',  // sky-300
  p97: '#38bdf8',  // sky-400
};

const LIGHT_COLORS: Record<string, string> = {
  p1: '#0284c7',   // sky-600
  p3: '#0369a1',   // sky-700
  p5: '#0369a1',   // sky-700
  p10: '#475569',  // slate-600
  p15: '#475569',  // slate-600
  p25: '#475569',  // slate-600
  p50: '#0f172a',  // slate-900 (deep black-blue)
  p75: '#475569',  // slate-600
  p85: '#475569',  // slate-600
  p90: '#475569',  // slate-600
  p95: '#0369a1',  // sky-700
  p97: '#0284c7',  // sky-600
};

// Printed output is always ink on paper, whatever theme is showing on screen. The dark
// palette is unusable there (the 50th centile is pure white and the rest are pale slate),
// and even the light palette's slate-600 curves come out as faint grey, so every centile
// line is printed black and told apart by weight and dash pattern - as on a published
// growth chart.
const PRINT_COLORS: Record<string, string> = {
  p1: '#000000', p3: '#000000', p5: '#000000', p10: '#000000', p15: '#000000',
  p25: '#000000', p50: '#000000', p75: '#000000', p85: '#000000', p90: '#000000',
  p95: '#000000', p97: '#000000',
};

// Fixed box for the printed charts. A ResponsiveContainer measures the element on screen,
// and the print-only charts are display:none there, so they need a size of their own.
// Two of these go on one A4 page: 600px is ~159mm wide and 400px is ~106mm tall, which
// leaves room for both headings and the centile legend inside the printable 190x277mm.
export const PRINT_CHART_SIZE = { width: 600, height: 400 };

const LINE_STYLES: Record<string, { dash: string; width: number }> = {
  p1: { dash: '4 4', width: 1.5 },
  p3: { dash: '6 3', width: 1.5 },
  p5: { dash: '6 3', width: 1.5 },
  p10: { dash: '5 2', width: 1 },
  p15: { dash: '5 2', width: 1 },
  p25: { dash: '6 3', width: 1.5 },
  p50: { dash: '0', width: 2.5 },
  p75: { dash: '6 3', width: 1.5 },
  p85: { dash: '5 2', width: 1 },
  p90: { dash: '5 2', width: 1.5 },
  p95: { dash: '6 3', width: 1.5 },
  p97: { dash: '4 4', width: 1.5 }
};

function getColor(key: string, isDarkMode: boolean, staticPrint = false) {
  if (staticPrint) return PRINT_COLORS[key] || '#000000';
  if (isDarkMode) return DARK_COLORS[key] || '#94a3b8';
  return LIGHT_COLORS[key] || '#475569';
}

function GrowthChartImpl({
  datasetData,
  standard,
  metric,
  patientPoints,
  isDarkMode = false,
  initialRange = 24,
  staticPrint = false
}: GrowthChartProps) {
  const [refAreaLeft, setRefAreaLeft] = useState<number | null>(null);
  const [refAreaRight, setRefAreaRight] = useState<number | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<any | null>(null);

  const selectedRange = initialRange;

  // Zoom domain state
  const [zoomDomain, setZoomDomain] = useState<[number, number]>([0, selectedRange]);

  // Update zoom domain when initialRange changes from parent
  useEffect(() => {
    setZoomDomain([0, initialRange]);
    setHoveredPoint(null);
  }, [initialRange]);

  // Determine centiles for this specific metric and standard
  const centileKeys = useMemo(() => {
    let list: string[] = [];
    const isBmi = metric.toLowerCase().includes('bmi');
    const isHeight = metric.toLowerCase().includes('height') || metric.toLowerCase().includes('length');

    if (isBmi) {
      list = ['p5', 'p50', 'p85', 'p95'];
    } else if (isHeight) {
      const base = pData.centileSets?.[standard] || ['p3', 'p15', 'p50', 'p85', 'p97'];
      list = base.includes('p1') ? base : ['p1', ...base];
    } else {
      list = pData.centileSets?.[standard] || ['p3', 'p15', 'p50', 'p85', 'p97'];
    }

    // Sort strictly numerically by percentile value (P1 < P3 < P5 < P10 < P15 < P25 < P50 < P75 < P85 < P90 < P95 < P97)
    return [...list].sort((a, b) => {
      const numA = parseFloat(a.replace(/[^\d.]/g, ''));
      const numB = parseFloat(b.replace(/[^\d.]/g, ''));
      return numA - numB;
    });
  }, [metric, standard]);

  // Base reference series (independent of patient data) — recomputed only when the
  // underlying dataset or standard changes, not on every patient point update.
  const baseData = useMemo(() => {
    if (!datasetData || datasetData.length === 0) return [] as any[];
    const zScores = pData.zScores || {};
    const maxAgeMonths = standard === 'who' ? 60.1 : 240.1;
    const allConvertedData = generateChartData(datasetData, centileKeys, zScores, standard === 'who');
    return allConvertedData.filter(d => d.age <= maxAgeMonths);
  }, [datasetData, standard, centileKeys]);

  // Merge patient points onto a shallow copy of the base series.
  const chartData = useMemo(() => {
    if (!patientPoints || patientPoints.length === 0) return baseData;
    const maxAgeMonths = standard === 'who' ? 60.1 : 240.1;
    const mergedData = baseData.map(d => ({ ...d }));
    patientPoints.forEach(pt => {
      if (pt.age <= maxAgeMonths) {
        const existing = mergedData.find(d => Math.abs(d.age - pt.age) < 0.001);
        if (existing) {
          existing.patientValue = pt.value;
          existing.patientCentile = pt.p;
        } else {
          mergedData.push({ age: pt.age, patientValue: pt.value, patientCentile: pt.p });
        }
      }
    });
    mergedData.sort((a, b) => a.age - b.age);
    return mergedData;
  }, [baseData, patientPoints, standard]);

  // Double-right-click to reset zoom
  const [lastRightClick, setLastRightClick] = useState<number>(0);
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastRightClick < 300) {
      setZoomDomain([0, initialRange]);
    }
    setLastRightClick(now);
  };

  // Printed charts are pinned to the full axis the parent asks for, so a printout can
  // never come out zoomed in however the on-screen chart was left.
  const view = useMemo<[number, number]>(
    () => (staticPrint ? [0, initialRange] : zoomDomain),
    [staticPrint, initialRange, zoomDomain]
  );

  // Calculate X Axis Ticks and Gridlines based on user specifications
  const { xTicks, xGridLines, xDomain, axisUnit } = useMemo(() => {
    const minAge = view[0];
    const maxAge = view[1];
    const ageRange = maxAge - minAge;

    const ticks: number[] = [];
    const gridLines: number[] = [];
    let unit = 'months';

    if (ageRange <= 6.01) {
      // 0-6 months: monthly axis labels, grid lines every quarter month
      unit = 'months';
      const startTick = Math.ceil(minAge);
      for (let i = startTick; i <= maxAge + 1e-9; i += 1) {
        ticks.push(i);
      }
      const startGrid = Math.ceil(minAge / 0.25) * 0.25;
      for (let i = startGrid; i <= maxAge + 1e-9; i += 0.25) {
        gridLines.push(i);
      }
    } else if (ageRange <= 24.01) {
      // 0-2 years (0-24m): monthly axis labels
      unit = 'months';
      const start = Math.ceil(minAge);
      for (let i = start; i <= maxAge + 1e-9; i += 1) {
        ticks.push(i);
        gridLines.push(i);
      }
    } else if (ageRange <= 60.01) {
      // 0-5 years (0-60m): yearly axis labels (12m), grid lines 1/4 year (3m)
      unit = 'years';
      const start = Math.ceil(minAge / 3) * 3;
      for (let i = start; i <= maxAge + 1e-9; i += 3) {
        if (i % 12 === 0) ticks.push(i);
        gridLines.push(i);
      }
    } else {
      // 0-12 / 0-18 years: yearly axis labels
      unit = 'years';
      const start = Math.ceil(minAge / 12) * 12;
      for (let i = start; i <= maxAge + 1e-9; i += 12) {
        ticks.push(i);
        gridLines.push(i);
      }
    }

    return {
      xTicks: ticks,
      xGridLines: gridLines,
      xDomain: [minAge, maxAge] as [number, number],
      axisUnit: unit
    };
  }, [view]);

  // Calculate Y Axis Range and Increments based on user specifications
  const { yTicks, yDomain } = useMemo(() => {
    const maxAge = view[1];
    const metricLower = metric.toLowerCase();
    const isWeight = metricLower.includes('weight');
    const isHeight = metricLower.includes('height') || metricLower.includes('length');
    const isHC = metricLower.includes('circumference') || metricLower.includes('hc');
    const isBmi = metricLower.includes('bmi');

    let yMin = 0;
    let yMax = 100;
    let yStep = 5;

    if (isWeight) {
      if (maxAge <= 6.01) {
        // 0-6: 2kg to 12kg, 1 kg labelled axis increments
        yMin = 2;
        yMax = 12;
        yStep = 1;
      } else if (maxAge <= 24.01) {
        // 0-24: 2kg to 18kg, 1 kg labelled axis increments
        yMin = 2;
        yMax = 18;
        yStep = 1;
      } else if (maxAge <= 60.01) {
        // 0-5: 0kg to 50kg, 5 kg labelled axis increments
        yMin = 0;
        yMax = 50;
        yStep = 5;
      } else if (maxAge <= 144.01) {
        // 0-12: 0 kg to 90 kg, 5 kg labelled axis increments
        yMin = 0;
        yMax = 90;
        yStep = 5;
      } else {
        // 0-18: 0 kg to 90 kg, 5 kg labelled axis increments
        yMin = 0;
        yMax = 90;
        yStep = 5;
      }
    } else if (isHeight) {
      if (maxAge <= 6.01) {
        // 0-6: 45cm to 75cm, 5cm increments on axis labels
        yMin = 45;
        yMax = 75;
        yStep = 5;
      } else if (maxAge <= 24.01) {
        // 0-24: 45cm - 95cm, 5cm increments on axis labels
        yMin = 45;
        yMax = 95;
        yStep = 5;
      } else if (maxAge <= 60.01) {
        // 0-5: 45cm to 150cm, 5cm increments on axis labels
        yMin = 45;
        yMax = 150;
        yStep = 5;
      } else if (maxAge <= 144.01) {
        // 0-12: 60cm to 185 cm, 5cm increment on axis labels
        yMin = 60;
        yMax = 185;
        yStep = 5;
      } else {
        // 0-18: 60cm to 200 cm, 5cm increment on axis labels
        yMin = 60;
        yMax = 200;
        yStep = 5;
      }
    } else if (isHC) {
      if (maxAge <= 24.01) {
        // 0-6 / 0-24: 30cm to 52 cm, 2cm axis labels
        yMin = 30;
        yMax = 52;
        yStep = 2;
      } else {
        // 0-5y (60m): 30cm to 60 cm, 2 cm axis labels
        yMin = 30;
        yMax = 60;
        yStep = 2;
      }
    } else if (isBmi) {
      if (maxAge <= 24.01) {
        yMin = 10;
        yMax = 22;
        yStep = 2;
      } else {
        yMin = 10;
        yMax = 36;
        yStep = 2;
      }
    }

    const ticks: number[] = [];
    for (let v = yMin; v <= yMax; v += yStep) {
      ticks.push(v);
    }

    return {
      yTicks: ticks,
      yDomain: [yMin, yMax] as [number, number]
    };
  }, [view, metric]);

  // Axis, grid and label colours. Printed charts ignore the screen theme: black rules and
  // text on white paper, with a light grid that stays visible without competing with the
  // centile curves.
  const axis = staticPrint
    ? { grid: '#cbd5e1', line: '#000000', text: '#000000' }
    : isDarkMode
    ? { grid: '#334155', line: '#475569', text: '#94a3b8' }
    : { grid: '#e2e8f0', line: '#cbd5e1', text: '#64748b' };

  // The patient's own trace stays red on paper, but a darker red that still reads once a
  // mono printer turns the page into greyscale.
  const patientColor = staticPrint ? '#dc2626' : '#ef4444';

  return (
    <div 
      className={staticPrint
        ? 'flex flex-col items-center relative print:break-inside-avoid select-none'
        : 'w-full flex-1 flex flex-col items-center relative print:break-inside-avoid print:!h-auto select-none'}
      style={staticPrint ? undefined : { minHeight: '300px' }}
      onContextMenu={staticPrint ? undefined : handleContextMenu}
    >
      <div className={staticPrint ? 'mx-auto' : 'w-full max-w-[850px] mb-2 print:mb-0'}>
        {/* A numeric width and height makes recharts skip measuring its container, which
            matters here: the print-only charts are display:none on screen. */}
        <ResponsiveContainer
          width={staticPrint ? PRINT_CHART_SIZE.width : '100%'}
          height={staticPrint ? PRINT_CHART_SIZE.height : undefined}
          aspect={staticPrint ? undefined : 1.2}
        >
          <LineChart 
            data={chartData} 
            margin={{ top: 20, right: 30, left: 10, bottom: 25 }}
            onMouseDown={(state: any, e: any) => { 
              if (e && e.button === 2) {
                if (state && state.activeLabel !== undefined) setRefAreaLeft(state.activeLabel as number); 
              }
            }}
            onMouseMove={(state: any) => { 
              if (refAreaLeft !== null && state && state.activeLabel !== undefined) {
                setRefAreaRight(state.activeLabel as number);
              }
              if (state && state.activeLabel !== undefined) {
                const labelNum = Number(state.activeLabel);
                const closest = chartData.reduce((prev, curr) => 
                  Math.abs(curr.age - labelNum) < Math.abs(prev.age - labelNum) ? curr : prev, 
                  chartData[0]
                );
                if (
                  closest &&
                  closest[centileKeys[0]] === undefined &&
                  baseData.length > 0 &&
                  closest.age >= baseData[0].age &&
                  closest.age <= baseData[baseData.length - 1].age
                ) {
                  const nearestBase = baseData.reduce((prev, curr) =>
                    Math.abs(curr.age - closest.age) < Math.abs(prev.age - closest.age) ? curr : prev,
                    baseData[0]
                  );
                  setHoveredPoint({ ...nearestBase, age: closest.age });
                } else {
                  setHoveredPoint(closest || null);
                }
              }
            }}
            onMouseLeave={() => {
              setHoveredPoint(null);
            }}
            onMouseUp={(state: any, e: any) => {
              if (e && e.button !== 2 && refAreaLeft === null) return;
              if (refAreaLeft !== null && refAreaRight !== null) {
                let [left, right] = [refAreaLeft, refAreaRight];
                if (left > right) [left, right] = [right, left];
                if (left !== right && Math.abs(right - left) > 0.1) {
                  setZoomDomain([left, right]);
                }
              }
              setRefAreaLeft(null);
              setRefAreaRight(null);
            }}
          >
            <CartesianGrid 
              strokeDasharray="1 1" 
              horizontal={true} 
              vertical={false} 
              stroke={axis.grid} 
            />
            {xGridLines.map((x) => (
              <ReferenceLine key={`grid-${x}`} x={x} stroke={axis.grid} strokeDasharray="1 1" />
            ))}
            <XAxis 
              dataKey="age" 
              label={{ 
                value: `Age (${axisUnit})`, 
                position: 'insideBottom', 
                offset: -18, 
                fill: axis.text, 
                fontSize: 12, 
                fontWeight: 600 
              }} 
              type="number"
              allowDataOverflow
              domain={xDomain}
              ticks={xTicks}
              interval={0}
              tickLine={{ stroke: axis.line }}
              tickFormatter={(tick) => {
                if (tick === 0) return '0';
                if (axisUnit === 'months') return `${tick}`;
                return `${tick / 12}`;
              }}
              tick={{ fontSize: 11, fill: axis.text }}
              stroke={axis.line}
            />
            <YAxis 
              label={{ 
                value: metric, 
                angle: -90, 
                position: 'insideLeft', 
                offset: -5, 
                fill: axis.text, 
                fontSize: 12, 
                fontWeight: 600 
              }}
              domain={yDomain}
              allowDataOverflow
              ticks={yTicks}
              interval={0}
              tickLine={{ stroke: axis.line }}
              tick={{ fontSize: 11, fill: axis.text }}
              stroke={axis.line}
              width={50}
              tickMargin={5}
            />
            {/* Custom vertical tracking line without floating popup */}
            <Tooltip 
              content={() => null}
              cursor={{ stroke: isDarkMode ? '#60a5fa' : '#3b82f6', strokeWidth: 1.5, strokeDasharray: '3 3' }}
            />
            
            {centileKeys.map((key: string) => {
              const dash = LINE_STYLES[key]?.dash || '5 3';
              const strokeWidth = LINE_STYLES[key]?.width || 1.5;
              const lineColor = getColor(key, isDarkMode, staticPrint);

              return (
                <Line 
                  key={key}
                  className={`centile-${key}`}
                  type="monotone"
                  dataKey={key}
                  name={key.toUpperCase()}
                  stroke={lineColor}
                  strokeWidth={strokeWidth}
                  strokeDasharray={dash}
                  dot={false}
                  connectNulls={true}
                  activeDot={{ r: 4, fill: lineColor, stroke: isDarkMode ? '#0f172a' : '#ffffff', strokeWidth: 1.5 }}
                  isAnimationActive={false}
                />
              );
            })}

            {patientPoints && patientPoints.length > 0 && (
              <Line 
                type="monotone" 
                dataKey="patientValue" 
                name="PATIENT"
                legendType="none"
                className="patient-trace"
                stroke={patientColor} 
                strokeWidth={2} 
                dot={{ r: 4, strokeWidth: 2, fill: patientColor, stroke: "white" }} 
                activeDot={{ r: 6 }} 
                connectNulls={true}
                isAnimationActive={false}
              />
            )}

            {refAreaLeft !== null && refAreaRight !== null && (
              <React.Fragment>
                {/* @ts-expect-error Types in recharts for ReferenceArea can be incomplete */}
                <ReferenceArea x1={refAreaLeft} x2={refAreaRight} fill="#3b82f6" fillOpacity={0.15} />
              </React.Fragment>
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Axis and Centile Values Panel below the chart */}
      <div
        className={staticPrint
          ? 'mx-auto px-2 py-2.5 mt-1 border-t border-slate-300 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs'
          : 'w-full max-w-[850px] px-2 py-2.5 mt-1 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs transition-all'}
        style={staticPrint ? { width: PRINT_CHART_SIZE.width } : undefined}
      >
        {hoveredPoint ? (
          // Hover State: Show active age and exact values for each percentile below the axis
          <div className="w-full flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider">Age:</span>
              <span>
                {formatAgeString(hoveredPoint.age * 30.4375)}
                <span className="text-slate-400 ml-1 font-normal">({hoveredPoint.age < 24 ? `${hoveredPoint.age.toFixed(1)}m` : `${(hoveredPoint.age / 12).toFixed(1)}y`})</span>
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {centileKeys.map((key: string) => {
                const val = hoveredPoint[key];
                const color = getColor(key, isDarkMode, staticPrint);
                return (
                  <div key={key} className="flex items-center gap-1 font-mono">
                    <span 
                      className="font-bold text-[11px]" 
                      style={{ color }}
                    >
                      {key.toUpperCase()}:
                    </span>
                    <span className="text-slate-800 dark:text-slate-100 font-semibold">
                      {val !== undefined && val !== null ? Number(val).toFixed(1) : '--'}
                    </span>
                  </div>
                );
              })}

              {/* Patient value display */}
              {(() => {
                const threshold = (zoomDomain[1] - zoomDomain[0]) * 0.02; // 2% of the visible chart width
                if (!patientPoints || patientPoints.length === 0) return null;
                const nearest = patientPoints.reduce((prev, curr) => Math.abs(curr.age - hoveredPoint.age) < Math.abs(prev.age - hoveredPoint.age) ? curr : prev);
                
                if (nearest && nearest.value !== undefined && nearest.value !== null && Math.abs(nearest.age - hoveredPoint.age) <= threshold) {
                  return (
                    <div className="flex items-center gap-1 font-mono bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded font-bold">
                      <span>PATIENT:</span>
                      <span>
                        {Number(nearest.value).toFixed(1)}
                        {nearest.p !== undefined && nearest.p !== null && (
                          <span className="text-[10px] ml-1.5 opacity-80 font-medium tracking-normal">(P {nearest.p.toFixed(0)}%)</span>
                        )}
                        {nearest.velocity !== undefined && nearest.velocity !== null && (
                          <span className="text-[10px] ml-1.5 opacity-90 font-medium tracking-normal">· {nearest.velocity.toFixed(1)} cm/yr</span>
                        )}
                      </span>
                    </div>
                  );
                }
                return null;
              })()}
            </div>
          </div>
        ) : (
          // Default State (No hovering): Centile Labels without numbers
          <div className="w-full flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-4 text-slate-600 dark:text-slate-400">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Centiles:</span>
              {centileKeys.map((key: string) => {
                const color = getColor(key, isDarkMode, staticPrint);
                const isDashed = LINE_STYLES[key]?.dash !== '0';
                return (
                  <div key={key} className="flex items-center gap-1.5">
                    <span 
                      className="inline-block w-4 h-0.5 rounded"
                      style={staticPrint
                        // A printed swatch has to be a border: browsers drop background
                        // colours unless "Background graphics" is ticked.
                        ? { backgroundColor: 'transparent', borderTop: `${key === 'p50' ? 2 : 1}px ${isDashed ? 'dashed' : 'solid'} #000` }
                        : { backgroundColor: color, borderTop: isDashed ? `1px dashed ${color}` : undefined }}
                    />
                    <span className="font-semibold text-slate-700 dark:text-slate-300 text-[11px]">
                      {key.toUpperCase()}
                    </span>
                  </div>
                );
              })}
            </div>
            {!staticPrint && (
              <div className="text-[11px] text-slate-400 italic">
                Hover across chart to view values at exact age
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const GrowthChart = React.memo(GrowthChartImpl);
