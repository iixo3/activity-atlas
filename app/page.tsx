"use client";

import {
  createContext,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { displayPoints, partialVolumeProjection, percentBounds, resolveDateRange, shouldUseLogScale, toggleAllHidden } from "../lib/activity-math.mjs";
import { Breakdown, DataHealth, Freshness, Overview } from "./insights";

export type Category = "cex" | "dex" | "prediction";
type VenueCategory = Category | "cex-hl";
export type Metric = "volume" | "oi";
type ViewMode = "percent" | "absolute" | "btc" | "share";
type ValueUnit = "usd" | "multiple" | "contracts";
type Theme = "dark" | "light";
type ChartRangeSelection = { start: string | null; end: string | null };
const EMPTY_CHART_RANGE: ChartRangeSelection = { start: null, end: null };
const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
type Point = {
  date: string;
  value: number;
  valueBtc?: number | null;
  share?: number | null;
  asOfDate?: string;
  collectedAt?: string;
  isComplete?: boolean;
  isSnapshot?: boolean;
  projectionValue?: number | null;
  projectionValueBtc?: number | null;
  projectionCoveredDays?: number;
  projectionDaysInMonth?: number;
  projectionMultiplier?: number;
  projectionCoverageEnd?: string;
  projectionCoverageBasis?: "observed-source-date" | "assumed-through-prior-utc-day";
  projectionUnavailableReason?: string;
  actualValue?: number;
  actualValueBtc?: number | null;
  isProjection?: boolean;
};
type Series = {
  id: string;
  category: Category;
  venue: string;
  metric: string;
  quality: "observed" | "derived" | "proxy";
  sourceKey: string;
  definition: string;
  points: Point[];
};
type Source = {
  key: string;
  title: string;
  page: string;
  api: string;
  retrievedAt: string;
  reportedFrequency: string;
  upstreamSources: string[];
  body: string;
  publisher?: string;
};
type CompositionSeries = {
  id: string;
  venue: string;
  product: string;
  dimension: string;
  group: string;
  metric: string;
  metricLabel: string;
  unit: ValueUnit;
  quality: "observed" | "derived" | "proxy";
  classificationSource: string;
  definition: string;
  coverageStart: string | null;
  coverageEnd: string | null;
  points: Point[];
};
type CompositionVenue = {
  id: string;
  label: string;
  product: string;
  defaultDimension: string;
  defaultMetric: string;
  dimensions: { id: string; label: string }[];
  metrics: { id: string; label: string; unit: ValueUnit }[];
  qualityVolumeMetric: string;
  qualityOiMetric: string;
  coverageNote?: string;
};
type PairResult = {
  pearson: number | null;
  spearman: number | null;
  observations: number;
  start: string | null;
  end: string | null;
};
export type DashboardData = {
  meta: {
    title: string;
    generatedAt: string;
    requestedDefaultStart: string;
    completeThrough: string;
    currentMonthPartial: boolean;
    currency: string;
    dexVenueCount: number;
    refreshSchedule?: string;
    partialVolumeMethod?: string;
    warnings: string[];
  };
  rankings: {
    perpDexByCumulativeVolume: {
      name: string;
      cumulativeVolume: number;
      completeCumulativeVolume?: number;
      includesIncompleteMonth?: boolean;
    }[];
    displayedTopTen: string[];
  };
  correlations: Record<Metric, {
    method: string;
    coverageStart: string;
    pairs: Record<string, PairResult>;
  }>;
  sources: Source[];
  series: Series[];
  composition?: {
    meta: { generatedAt: string; duneRefreshedAt?: string | null; methodology: string; warnings: string[] };
    venues: CompositionVenue[];
    series: CompositionSeries[];
  };
};

type ChartRangeContextValue = {
  ranges: Record<string, ChartRangeSelection>;
  updateRange: (key: string, change: Partial<ChartRangeSelection>) => void;
};

const ChartRangeContext = createContext<ChartRangeContextValue | null>(null);

function ChartRangeProvider({ children }: { children: ReactNode }) {
  const [ranges, setRanges] = useState<Record<string, ChartRangeSelection>>({});

  function updateRange(key: string, change: Partial<ChartRangeSelection>) {
    setRanges((current) => ({
      ...current,
      [key]: { ...EMPTY_CHART_RANGE, ...current[key], ...change },
    }));
  }

  return <ChartRangeContext.Provider value={{ ranges, updateRange }}>{children}</ChartRangeContext.Provider>;
}

type DisplaySeries = Series & { color: string; label: string };

const CATEGORY_COLORS: Record<Category, string> = {
  cex: "#78a7ff",
  dex: "#4fd1a1",
  prediction: "#ff6fae",
};
const CATEGORY_LABELS: Record<Category, string> = {
  cex: "Centralized venues",
  dex: "Perp DEXs",
  prediction: "Prediction markets",
};
const VENUE_COLORS = [
  "#78a7ff",
  "#4fd1a1",
  "#ff6fae",
  "#f6be59",
  "#a98bff",
  "#47c8e8",
  "#ff806f",
  "#54b8a8",
  "#d28a5b",
  "#9da8b8",
];
const NAMED_VENUE_COLORS: Record<string, string> = {
  Binance: "#78a7ff", Bybit: "#f6be59", Kraken: "#a98bff",
  "Coinbase International": "#47c8e8", Hyperliquid: "#4fd1a1", Lighter: "#78a7ff",
};
const QUALITY_LABELS = {
  observed: "Observed",
  derived: "Derived",
  proxy: "Proxy",
};
const PAIR_LABELS: Record<string, string> = {
  cex__dex: "CEX ↔ Perp DEX",
  cex__prediction: "CEX ↔ Prediction",
  dex__prediction: "Perp DEX ↔ Prediction",
};

function monthKey(date: string) {
  return date.slice(0, 7);
}

function monthNumber(date: string) {
  const [year, month] = monthKey(date).split("-").map(Number);
  return year * 12 + month;
}

function monthLabel(date: string, short = true) {
  return new Intl.DateTimeFormat("en", {
    month: short ? "short" : "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${monthKey(date)}-01T00:00:00Z`));
}

function dayLabel(date?: string) {
  if (!date) return "unknown date";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date.slice(0, 10)}T00:00:00Z`));
}

function formatUsd(value: number, digits = 1) {
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `$${(value / 1e12).toFixed(digits)}T`;
  if (absolute >= 1e9) return `$${(value / 1e9).toFixed(digits)}B`;
  if (absolute >= 1e6) return `$${(value / 1e6).toFixed(digits)}M`;
  if (absolute >= 1e3) return `$${(value / 1e3).toFixed(digits)}K`;
  return `$${value.toFixed(0)}`;
}

function formatCount(value: number) {
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function formatBtc(value: number, digits = 1) {
  if (Math.abs(value) >= 1e6) return `₿${(value / 1e6).toFixed(digits)}M`;
  if (Math.abs(value) >= 1e3) return `₿${(value / 1e3).toFixed(digits)}K`;
  return `₿${value.toFixed(digits)}`;
}

function formatPercent(value: number, digits = 1, compact = false) {
  return `${value.toLocaleString("en-US", { signDisplay: "exceptZero", maximumFractionDigits: digits, notation: compact ? "compact" : "standard" })}%`;
}

function formatShare(value: number, digits = 1) {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })}%`;
}

function formatMultiple(value: number, digits = 2) {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })}×`;
}

function firstObserved(points: Point[]) {
  return points.find((point) => point.value > 0) ?? points[0];
}

function correlationTone(value: number | null) {
  if (value == null) return "Unavailable";
  const absolute = Math.abs(value);
  const direction = value < 0 ? "opposite patterns" : "similar patterns";
  if (absolute < 0.2) return "No clear linear pattern";
  if (absolute < 0.4) return `Slightly ${direction}`;
  if (absolute < 0.7) return `Moderately ${direction}`;
  return `Strongly ${direction}`;
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(960);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(300, Math.floor(entry.contentRect.width)));
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function buildPath(
  points: Point[],
  x: (date: string) => number,
  y: (value: number) => number,
) {
  let previous: Point | undefined;
  return points.map((point) => {
    const gap = previous ? monthNumber(point.date) - monthNumber(previous.date) : 0;
    const command = !previous || gap > 1 ? "M" : "L";
    previous = point;
    return `${command}${x(point.date).toFixed(2)},${y(point.value).toFixed(2)}`;
  }).join(" ");
}

function exportSvgAsPng(
  svg: SVGSVGElement,
  fileName: string,
  background: string,
  width: number,
  height: number,
) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  const backdrop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  backdrop.setAttribute("x", "0");
  backdrop.setAttribute("y", "0");
  backdrop.setAttribute("width", "100%");
  backdrop.setAttribute("height", "100%");
  backdrop.setAttribute("fill", background);
  clone.insertBefore(backdrop, clone.firstChild);
  const source = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    URL.revokeObjectURL(url);
    const link = document.createElement("a");
    link.download = fileName;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };
  image.src = url;
}

function InteractiveChart({
  chartId,
  rangeKey,
  title,
  series,
  view,
  metric,
  defaultStart,
  completeThrough,
  generatedAt,
  theme,
  valueUnit = "usd",
  axisLabel,
  showMetricNotes = true,
  showPartialBand = true,
}: {
  chartId: string;
  // Stable across category/metric variants; required for remount persistence.
  rangeKey: string;
  title: string;
  series: DisplaySeries[];
  view: ViewMode;
  metric: string;
  defaultStart: string;
  completeThrough: string;
  generatedAt: string;
  theme: Theme;
  valueUnit?: ValueUnit;
  axisLabel?: string;
  showMetricNotes?: boolean;
  showPartialBand?: boolean;
}) {
  const chartRangeStore = useContext(ChartRangeContext);
  if (!chartRangeStore) throw new Error("InteractiveChart must be rendered inside ChartRangeProvider");
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const chartSeries = useMemo(() => series.map((item) => ({
    ...item,
    points: item.points.flatMap((point) => {
      if (metric !== "volume" || monthKey(point.date) <= completeThrough || point.isComplete !== false) return [point];
      const projected = {
        ...point,
        ...partialVolumeProjection(point, { metric, generatedAt, completeThrough }),
      } as Point;
      if (typeof projected.projectionValue !== "number" || !Number.isFinite(projected.projectionValue)) return [];
      return [{
        ...projected,
        actualValue: point.value,
        actualValueBtc: point.valueBtc,
        value: projected.projectionValue,
        valueBtc: projected.projectionValueBtc,
        isProjection: true,
      }];
    }),
  })), [series, metric, completeThrough, generatedAt]);
  const allDates = useMemo(
    () => [...new Set(series.flatMap((item) => item.points.map((point) => point.date)))].sort(),
    [series],
  );
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const selectedRange = chartRangeStore.ranges[rangeKey] ?? EMPTY_CHART_RANGE;
  const {
    fromIndex: safeFrom,
    toIndex: safeTo,
    rangeStart,
    rangeEnd,
  } = useMemo(
    () => resolveDateRange(allDates, selectedRange, defaultStart),
    [allDates, defaultStart, selectedRange],
  );
  const visibleSource = useMemo(
    () => chartSeries
      .filter((item) => !hidden.has(item.id))
      .map((item) => ({
        ...item,
        points: item.points.filter((point) => point.date >= rangeStart && point.date <= rangeEnd),
      })),
    [chartSeries, hidden, rangeStart, rangeEnd],
  );
  const transformed = useMemo(() => visibleSource.map((item) => ({
    ...item, points: displayPoints(item.points, view),
  })), [visibleSource, view]);
  const allHidden = series.every((item) => hidden.has(item.id));
  const hasPoints = transformed.some((item) => item.points.length > 0);

  const values = transformed.flatMap((item) => item.points.map((point) => point.value));
  const positive = values.filter((value) => value > 0);
  const maximum = Math.max(...values, 1);
  const minimumPositive = Math.min(...positive, maximum);
  const useLog = shouldUseLogScale(values, view);
  const height = width < 640 ? 360 : 430;
  const margin = { top: 28, right: 24, bottom: 50, left: width < 500 ? 66 : 78 };
  const plotWidth = Math.max(1, width - margin.left - margin.right);
  const plotHeight = Math.max(1, height - margin.top - margin.bottom);
  const startTime = Date.parse(`${monthKey(rangeStart)}-01T00:00:00Z`);
  const endTimeRaw = Date.parse(`${monthKey(rangeEnd)}-01T00:00:00Z`);
  const endTime = endTimeRaw === startTime ? startTime + 31 * 86400000 : endTimeRaw;
  const x = (date: string) => margin.left + ((Date.parse(`${monthKey(date)}-01T00:00:00Z`) - startTime) / (endTime - startTime)) * plotWidth;

  let yTicks: number[];
  let y: (value: number) => number;
  if (view === "share") {
    yTicks = [100, 75, 50, 25, 0];
    y = (value) => margin.top + ((100 - value) / 100) * plotHeight;
  } else if (view === "percent" && useLog) {
    const ratios = values.filter((value) => value > -100).map((value) => 1 + value / 100).filter((value) => value > 0);
    const lowPower = Math.floor(Math.log10(Math.min(...ratios)));
    const highPower = Math.ceil(Math.log10(Math.max(...ratios)));
    const zeroFloor = values.some((value) => value <= -100) ? lowPower - 1 : lowPower;
    const powers = Array.from({ length: highPower - lowPower + 1 }, (_, index) => lowPower + index);
    const stride = Math.max(1, Math.ceil(powers.length / 6));
    const tickPowers = [...new Set([
      lowPower,
      0,
      highPower,
      ...powers.filter((_, index) => index % stride === 0),
    ])].filter((power) => power >= lowPower && power <= highPower).sort((left, right) => right - left);
    yTicks = tickPowers.map((power) => 100 * (10 ** power - 1));
    if (values.some((value) => value <= -100)) yTicks.push(-100);
    y = (value) => {
      const logRatio = value <= -100 ? zeroFloor : Math.log10(1 + value / 100);
      return margin.top + ((highPower - logRatio) / Math.max(highPower - zeroFloor, 1)) * plotHeight;
    };
  } else if (view === "percent") {
    const [floor, ceiling] = percentBounds(values);
    const regularTicks = Array.from({ length: 5 }, (_, index) => ceiling - (ceiling - floor) * index / 4);
    // Give the zero baseline priority over nearby labels on asymmetric ranges.
    yTicks = [0, ...regularTicks.filter((tick) => Math.abs(tick) > (ceiling - floor) * 0.1)].sort((a, b) => b - a);
    y = (value) => margin.top + ((ceiling - value) / (ceiling - floor)) * plotHeight;
  } else if (useLog) {
    const lowPower = Math.floor(Math.log10(minimumPositive));
    const highPower = Math.ceil(Math.log10(maximum));
    const powers = Array.from({ length: highPower - lowPower + 1 }, (_, index) => lowPower + index);
    const stride = Math.max(1, Math.ceil(powers.length / 6));
    yTicks = powers.filter((_, index) => index % stride === 0 || index === powers.length - 1).map((power) => 10 ** power);
    const low = Math.log10(Math.min(...yTicks));
    const high = Math.log10(Math.max(...yTicks));
    y = (value) => value <= 0
      ? margin.top + plotHeight
      : margin.top + ((high - Math.log10(value)) / Math.max(high - low, 1)) * plotHeight;
  } else {
    const ceiling = maximum * 1.08;
    yTicks = Array.from({ length: 5 }, (_, index) => (ceiling * (4 - index)) / 4);
    y = (value) => margin.top + ((ceiling - value) / Math.max(ceiling, 1)) * plotHeight;
  }

  const chartColors = theme === "dark"
    ? { background: "#12161a", grid: "#252c33", muted: "#9099a4", text: "#f4f6f8", partial: "#20262c" }
    : { background: "#ffffff", grid: "#e6e9ee", muted: "#6f7681", text: "#17191d", partial: "#f0f2f5" };
  const ticksInRange = allDates.slice(safeFrom, safeTo + 1);
  const xTickCount = width < 500 ? 3 : width < 760 ? 4 : 6;
  const xTicks = [...new Set(Array.from({ length: Math.min(xTickCount, ticksInRange.length) }, (_, index) => {
    const position = Math.round((index / Math.max(Math.min(xTickCount, ticksInRange.length) - 1, 1)) * Math.max(ticksInRange.length - 1, 0));
    return ticksInRange[position];
  }))].filter(Boolean);
  const partialStart = `${Number(completeThrough.slice(5, 7)) === 12 ? Number(completeThrough.slice(0, 4)) + 1 : completeThrough.slice(0, 4)}-${String(Number(completeThrough.slice(5, 7)) % 12 + 1).padStart(2, "0")}-01`;
  const partialX = partialStart >= rangeStart && partialStart <= rangeEnd ? x(partialStart) : null;
  const hoverX = hoverDate ? x(hoverDate) : null;
  const hoverRows = hoverDate ? transformed.flatMap((item) => {
    const point = item.points.find((candidate) => candidate.date === hoverDate);
    return point ? [{ ...item, point }] : [];
  }) : [];
  const hoverProjections = hoverRows.filter((item) => item.point.isProjection);
  const hoverSnapshots = metric === "oi"
    ? hoverRows.filter((item) => item.point.isComplete === false && item.point.asOfDate)
    : [];

  function handlePointer(event: ReactPointerEvent<SVGRectElement>) {
    if (!svgRef.current || ticksInRange.length === 0) return;
    const bounds = svgRef.current.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * width;
    const time = startTime + ((svgX - margin.left) / plotWidth) * (endTime - startTime);
    const nearest = ticksInRange.reduce((best, date) => (
      Math.abs(Date.parse(`${monthKey(date)}-01T00:00:00Z`) - time)
        < Math.abs(Date.parse(`${monthKey(best)}-01T00:00:00Z`) - time) ? date : best
    ), ticksInRange[0]);
    setHoverDate(nearest);
  }

  function toggleSeries(id: string) {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const navigatorWidth = Math.max(width, 300);
  const navHeight = 58;
  const navX = (date: string) => {
    const index = allDates.indexOf(date);
    return (index / Math.max(allDates.length - 1, 1)) * navigatorWidth;
  };
  const navigatorPaths = chartSeries.map((item) => {
    const itemMaximum = Math.max(...item.points.map((point) => point.value), 1);
    return {
      id: item.id,
      color: item.color,
      path: buildPath(item.points, navX, (value) => navHeight - 7 - (value / itemMaximum) * (navHeight - 14)),
    };
  });

  return (
    <div className="interactive-chart" ref={containerRef}>
      <div className="chart-legend" aria-label="Chart series">
        <button
          type="button"
          className="bulk-toggle"
          onClick={() => setHidden((current) => toggleAllHidden(series.map((item) => item.id), current))}
        >{allHidden ? "Show all" : "Hide all"}</button>
        {series.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={!hidden.has(item.id)}
            className={hidden.has(item.id) ? "series-toggle is-muted" : "series-toggle"}
            onClick={() => toggleSeries(item.id)}
            title={item.definition}
          >
            <i style={{ background: item.color }} />
            <span>{item.label}</span>
            <small>{QUALITY_LABELS[item.quality]}</small>
          </button>
        ))}
        <button
          className="export-button"
          type="button"
          disabled={!hasPoints}
          onClick={() => svgRef.current && exportSvgAsPng(
            svgRef.current,
            `${chartId}-${metric}-${view}.png`,
            chartColors.background,
            width,
            height,
          )}
        >
          PNG export
        </button>
      </div>

      <div className="plot-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={`${title}, ${monthLabel(rangeStart)} to ${monthLabel(rangeEnd)}`}
        >
          <title>{title}</title>
          {showPartialBand && hasPoints && partialX != null && (
            <g>
              <rect x={Math.max(margin.left, partialX - 3)} y={margin.top} width={Math.max(3, width - margin.right - partialX + 3)} height={plotHeight} fill={chartColors.partial} />
              <text x={Math.max(margin.left + 6, partialX - 8)} y={margin.top + 13} textAnchor="end" fill={chartColors.muted} fontSize="11">PARTIAL</text>
            </g>
          )}
          {hasPoints && yTicks.map((tick) => {
            const yPosition = y(tick);
            return (
              <g key={tick}>
                <line x1={margin.left} x2={width - margin.right} y1={yPosition} y2={yPosition} stroke={(view === "percent" || view === "share") && tick === 0 ? chartColors.muted : chartColors.grid} strokeWidth={(view === "percent" || view === "share") && tick === 0 ? 1.4 : 1} />
                <text x={margin.left - 10} y={yPosition + 4} textAnchor="end" fill={chartColors.muted} fontSize="11" fontFamily="ui-monospace, SFMono-Regular, monospace">
                  {view === "percent" ? formatPercent(tick, 1, true) : view === "share" ? formatShare(tick, 0) : view === "btc" ? formatBtc(tick) : valueUnit === "multiple" ? formatMultiple(tick, 1) : valueUnit === "contracts" ? formatCount(tick) : formatUsd(tick, 0)}
                </text>
              </g>
            );
          })}
          {xTicks.map((tick) => (
            <g key={tick}>
              <line x1={x(tick)} x2={x(tick)} y1={margin.top + plotHeight} y2={margin.top + plotHeight + 5} stroke={chartColors.grid} />
              <text x={x(tick)} y={height - 16} textAnchor={tick === xTicks[0] ? "start" : tick === xTicks.at(-1) ? "end" : "middle"} fill={chartColors.muted} fontSize="11" fontFamily="ui-monospace, SFMono-Regular, monospace">
                {monthLabel(tick)}
              </text>
            </g>
          ))}
          <text x="13" y={margin.top + plotHeight / 2} transform={`rotate(-90 13 ${margin.top + plotHeight / 2})`} textAnchor="middle" fill={chartColors.muted} fontSize="11" fontFamily="ui-monospace, SFMono-Regular, monospace">
            {view === "share" ? "SHARE OF SELECTED BREAKDOWN" : view === "percent" ? `% CHANGE · FIRST POSITIVE = 0%${useLog ? " · MULTIPLICATIVE LOG" : ""}` : view === "btc" ? (metric.toLowerCase().includes("volume") ? "BTC EQUIVALENT" : "OI · BTC EQUIVALENT") : axisLabel ?? (valueUnit === "multiple" ? "VOLUME / OI" : metric === "volume" ? "MONTHLY USD NOTIONAL" : "MONTH-END / LATEST USD OI")}{useLog && view !== "percent" && view !== "share" ? " · LOG" : ""}
          </text>
          {transformed.flatMap((item) => item.points.slice(1).flatMap((point, index) => {
            const previous = item.points[index];
            if (monthNumber(point.date) - monthNumber(previous.date) > 1) return [];
            const partialSegment = previous.isComplete === false || point.isComplete === false;
            return [(
              <path
                key={`${item.id}-${previous.date}-${point.date}`}
                d={`M${x(previous.date).toFixed(2)},${y(previous.value).toFixed(2)} L${x(point.date).toFixed(2)},${y(point.value).toFixed(2)}`}
                fill="none"
                stroke={item.color}
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={partialSegment ? "7 6" : undefined}
                vectorEffect="non-scaling-stroke"
              />
            )];
          }))}
          {transformed.flatMap((item) => item.points.filter((point) => item.points.length === 1 || point.isSnapshot || point.isProjection).map((point) => (
            <circle key={`${item.id}-${point.date}`} cx={x(point.date)} cy={y(point.value)} r="4.5" fill={item.color} />
          )))}
          {!hasPoints && <text x={margin.left + plotWidth / 2} y={margin.top + plotHeight / 2} textAnchor="middle" fill={chartColors.muted} fontSize="13">{allHidden ? "All series hidden · select a venue or Show all" : "No observations in this range / currency"}</text>}
          {hoverX != null && (
            <g pointerEvents="none">
              <line x1={hoverX} x2={hoverX} y1={margin.top} y2={margin.top + plotHeight} stroke={chartColors.muted} strokeWidth="1" strokeDasharray="3 4" />
              {hoverRows.map((item) => (
                <circle key={item.id} cx={hoverX} cy={y(item.point.value)} r="4" fill={chartColors.background} stroke={item.color} strokeWidth="2.5" />
              ))}
            </g>
          )}
          <rect
            x={margin.left}
            y={margin.top}
            width={plotWidth}
            height={plotHeight}
            fill="transparent"
            onPointerMove={handlePointer}
            onPointerLeave={() => setHoverDate(null)}
          />
        </svg>
        {hoverDate && hoverRows.length > 0 && (
          <div
            className="chart-tooltip"
            role="tooltip"
            style={{ left: `${Math.min(82, Math.max(18, ((hoverX ?? 0) / width) * 100))}%` }}
          >
            <strong>{monthLabel(hoverDate, false)}{hoverProjections.length ? " · projected" : hoverRows.some((item) => item.point.isComplete === false) ? " · partial" : ""}</strong>
            {hoverRows.map((item) => (
              <span key={item.id}>
                <i style={{ background: item.color }} />
                <em>{item.label}</em>
                <b>{view === "absolute" ? (valueUnit === "multiple" ? formatMultiple(item.point.value) : valueUnit === "contracts" ? `${formatCount(item.point.value)} contracts` : formatUsd(item.point.value, 2)) : view === "btc" ? formatBtc(item.point.value, 2) : view === "share" ? formatShare(item.point.value) : formatPercent(item.point.value)}{item.point.isProjection ? "†" : item.point.isSnapshot ? "*" : ""}</b>
              </span>
            ))}
            {hoverProjections.map((item) => (
              <small key={`${item.id}-projection`}>
                † {item.label}: {view === "btc" && typeof item.point.actualValueBtc === "number" ? formatBtc(item.point.actualValueBtc, 2) : formatUsd(item.point.actualValue ?? 0, 2)} observed through {dayLabel(item.point.projectionCoverageEnd)} → {view === "btc" && typeof item.point.projectionValueBtc === "number" ? formatBtc(item.point.projectionValueBtc, 2) : formatUsd(item.point.projectionValue ?? 0, 2)} full-month run rate ({item.point.projectionCoveredDays}/{item.point.projectionDaysInMonth} days · ×{item.point.projectionMultiplier?.toFixed(2)}{item.point.projectionCoverageBasis === "assumed-through-prior-utc-day" ? " · cutoff assumed" : ""}).
              </small>
            ))}
            {hoverSnapshots.map((item) => <small key={`${item.id}-snapshot`}>{item.point.isSnapshot ? "* " : ""}{item.label}: {item.metric === "oi" ? "actual OI snapshot" : "observation"} as of {dayLabel(item.point.asOfDate)}; never extrapolated.</small>)}
          </div>
        )}
      </div>

      <div className="navigator" aria-label="Visible date range">
        <svg viewBox={`0 0 ${navigatorWidth} ${navHeight}`} preserveAspectRatio="none" aria-hidden="true">
          {navigatorPaths.map((item) => (
            <path key={item.id} d={item.path} fill="none" stroke={item.color} strokeWidth="1.2" opacity={hidden.has(item.id) ? 0 : 0.55} vectorEffect="non-scaling-stroke" />
          ))}
          <rect x="0" y="0" width={(safeFrom / Math.max(allDates.length - 1, 1)) * navigatorWidth} height={navHeight} className="nav-mask" />
          <rect x={(safeTo / Math.max(allDates.length - 1, 1)) * navigatorWidth} y="0" width={navigatorWidth - (safeTo / Math.max(allDates.length - 1, 1)) * navigatorWidth} height={navHeight} className="nav-mask" />
          <line x1={(safeFrom / Math.max(allDates.length - 1, 1)) * navigatorWidth} x2={(safeFrom / Math.max(allDates.length - 1, 1)) * navigatorWidth} y1="0" y2={navHeight} className="nav-handle" />
          <line x1={(safeTo / Math.max(allDates.length - 1, 1)) * navigatorWidth} x2={(safeTo / Math.max(allDates.length - 1, 1)) * navigatorWidth} y1="0" y2={navHeight} className="nav-handle" />
        </svg>
        <label className="sr-only" htmlFor={`${chartId}-from`}>Visible range start</label>
        <input
          id={`${chartId}-from`}
          className="range-input range-from"
          type="range"
          min="0"
          max={Math.max(0, allDates.length - 1)}
          value={safeFrom}
          onChange={(event) => {
            const nextIndex = Math.min(Number(event.target.value), Math.max(0, safeTo - 1));
            chartRangeStore.updateRange(rangeKey, { start: allDates[nextIndex] ?? null });
          }}
        />
        <label className="sr-only" htmlFor={`${chartId}-to`}>Visible range end</label>
        <input
          id={`${chartId}-to`}
          className="range-input range-to"
          type="range"
          min="0"
          max={Math.max(0, allDates.length - 1)}
          value={safeTo}
          onChange={(event) => {
            const lastIndex = Math.max(0, allDates.length - 1);
            const nextIndex = Math.max(Number(event.target.value), Math.min(lastIndex, safeFrom + 1));
            chartRangeStore.updateRange(rangeKey, { end: nextIndex === lastIndex ? null : allDates[nextIndex] ?? null });
          }}
        />
      </div>
      <div className="range-caption">
        <span>{monthLabel(rangeStart, false)}</span>
        <span>{monthLabel(rangeEnd, false)}</span>
      </div>
      <p className="scale-note">{view === "share" ? "Fixed 0–100% share axis." : useLog ? (view === "percent" ? "Adaptive multiplicative y-axis: doubling and halving occupy equal distance; labels remain true percentages." : "Adaptive log y-axis: equal vertical distance means equal proportional change.") : "Linear y-axis."} Navigator lines are normalized to each series’ own peak.</p>
      {showMetricNotes && metric === "volume" && <p className="display-note"><b>Dashed current month</b> = full-calendar-month run rate from reported MTD volume. Hover for the raw MTD value, cutoff, and multiplier. A source-zero current bucket is omitted, not shown as a collapse.</p>}
      {showMetricNotes && metric === "oi" && <p className="display-note"><b>Dashed latest segment</b> = actual incomplete-month OI snapshot. OI is a stock and is never time-extrapolated.</p>}
      {view === "percent" && <p className="display-note"><b>0%</b> = each line’s first positive USD value in this range. <b>+100%</b> means doubled; <b>−50%</b> means halved. Change from the baseline, not month-to-month change or market share. Moving the slider changes the baseline; start dates may differ. {useLog ? "Extreme ratios trigger a multiplicative axis; values are not capped." : "Linear scale, including declines."}</p>}
      {view === "btc" && <p className="display-note">BTC equivalent, not actual BTC contracts: volume ÷ monthly mean of completed daily BTC/USD closes; OI ÷ latest completed close on or before its observation date. Approximate conversion only. Correlations remain USD-based.</p>}
      {view === "share" && <p className="display-note">Each line is its share of the selected venue, dimension, metric and observation date. Shares sum to approximately 100%; rounding and unavailable labels may create small differences.</p>}
    </div>
  );
}

function MiniTrend({ series, completeThrough }: { series: Series; completeThrough: string }) {
  const points = series.points.filter((point) => monthKey(point.date) <= completeThrough);
  const width = 320;
  const height = 86;
  const maximum = Math.max(...points.map((point) => point.value), 1);
  const minimum = Math.min(...points.map((point) => point.value), 0);
  const x = (date: string) => 4 + ((monthNumber(date) - monthNumber(points[0]?.date ?? date)) / Math.max(monthNumber(points.at(-1)?.date ?? date) - monthNumber(points[0]?.date ?? date), 1)) * (width - 8);
  const y = (value: number) => 5 + ((maximum - value) / Math.max(maximum - minimum, 1)) * (height - 10);
  const latest = points.at(-1);
  return (
    <article className="context-card">
      <div>
        <p>{series.definition}</p>
        <strong>{latest ? formatCount(latest.value) : "—"}</strong>
        <small>{latest ? monthLabel(latest.date) : "No coverage"}</small>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={series.definition}>
        <path d={buildPath(points, x, y)} fill="none" stroke={CATEGORY_COLORS.prediction} strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
      </svg>
    </article>
  );
}

function MetricControls({
  metric,
  setMetric,
  view,
  setView,
  showView = true,
}: {
  metric: Metric;
  setMetric: (metric: Metric) => void;
  view: ViewMode;
  setView: (view: ViewMode) => void;
  showView?: boolean;
}) {
  return (
    <div className="control-row">
      <div className="segmented" role="group" aria-label="Metric">
        <button type="button" className={metric === "volume" ? "active" : ""} aria-pressed={metric === "volume"} onClick={() => setMetric("volume")}>Trading volume</button>
        <button type="button" className={metric === "oi" ? "active" : ""} aria-pressed={metric === "oi"} onClick={() => setMetric("oi")}>Open positions (OI)</button>
      </div>
      {showView && (
        <div className="segmented" role="group" aria-label="Value display">
          <button type="button" className={view === "absolute" ? "active" : ""} aria-pressed={view === "absolute"} onClick={() => setView("absolute")}>USD</button>
          <button type="button" className={view === "btc" ? "active" : ""} aria-pressed={view === "btc"} onClick={() => setView("btc")}>BTC</button>
          <button type="button" title="Change from each line’s first positive value in the selected range; 0% = baseline" className={view === "percent" ? "active" : ""} aria-pressed={view === "percent"} onClick={() => setView("percent")}>% change</button>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [staleSnapshot, setStaleSnapshot] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");
  const [mainMetric, setMainMetric] = useState<Metric>("volume");
  const [mainView, setMainView] = useState<ViewMode>("absolute");
  const [venueCategory, setVenueCategory] = useState<VenueCategory>("dex");
  const [venueMetric, setVenueMetric] = useState<Metric>("volume");
  const [venueView, setVenueView] = useState<ViewMode>("absolute");
  const [correlationMetric, setCorrelationMetric] = useState<Metric>("volume");
  const [compositionVenueId, setCompositionVenueId] = useState("hyperliquid");
  const [compositionDimension, setCompositionDimension] = useState("assetClass");
  const [compositionMetric, setCompositionMetric] = useState("volume24h");
  const [compositionView, setCompositionView] = useState<ViewMode>("absolute");

  useEffect(() => {
    const saved = window.localStorage.getItem("activity-atlas-theme") as Theme | null;
    const preferred = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    let disposed = false;
    let requestInFlight = false;
    const themeTimer = window.setTimeout(() => {
      setTheme(saved === "dark" || saved === "light" ? saved : preferred);
    }, 0);

    async function refreshData(initial = false) {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await fetch(`${PUBLIC_BASE_PATH}/data/activity-data.json?refresh=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error("Data unavailable");
        const payload = await response.json() as DashboardData;
        if (!payload?.meta?.generatedAt || !Array.isArray(payload.series)) throw new Error("Invalid data snapshot");
        if (!disposed) {
          setData((current) => !current || Date.parse(payload.meta.generatedAt) >= Date.parse(current.meta.generatedAt) ? payload : current);
          setLoadError(false);
          setRefreshWarning(false);
          setStaleSnapshot(Date.now() - Date.parse(payload.meta.generatedAt) > 36 * 60 * 60_000);
        }
      } catch {
        if (!disposed) {
          if (initial) setLoadError(true);
          else setRefreshWarning(true);
        }
      } finally {
        requestInFlight = false;
      }
    }

    void refreshData(true);
    const pollTimer = window.setInterval(() => void refreshData(), 5 * 60_000);
    const onFocus = () => void refreshData();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshData();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearTimeout(themeTimer);
      window.clearInterval(pollTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("activity-atlas-theme", theme);
  }, [theme]);

  const mainSeries = useMemo<DisplaySeries[]>(() => {
    if (!data) return [];
    return data.series
      .filter((series) => series.id.startsWith("category-") && series.metric === mainMetric)
      .map((series) => ({ ...series, color: CATEGORY_COLORS[series.category], label: series.category === "dex" && mainMetric === "oi" ? "Hyperliquid only" : CATEGORY_LABELS[series.category] }));
  }, [data, mainMetric]);

  const venueSeries = useMemo<DisplaySeries[]>(() => {
    if (!data) return [];
    const selected = data.series.filter((series) => (
      (venueCategory === "cex-hl" ? series.category === "cex" || series.venue === "Hyperliquid" : series.category === venueCategory)
      && series.metric === venueMetric
      && !series.id.startsWith("category-")
    ));
    const ordered = venueCategory === "dex" && venueMetric === "volume"
      ? data.rankings.displayedTopTen.flatMap((name) => selected.filter((series) => series.venue === name))
      : selected;
    return ordered.map((series, index) => ({ ...series, color: NAMED_VENUE_COLORS[series.venue] ?? VENUE_COLORS[index % VENUE_COLORS.length], label: series.venue }));
  }, [data, venueCategory, venueMetric]);

  const compositionVenue = data?.composition?.venues.find((item) => item.id === compositionVenueId)
    ?? data?.composition?.venues[0];
  const activeCompositionDimension = compositionVenue?.dimensions.some((item) => item.id === compositionDimension)
    ? compositionDimension
    : compositionVenue?.defaultDimension ?? "assetClass";
  const activeCompositionMetric = compositionVenue?.metrics.some((item) => item.id === compositionMetric)
    ? compositionMetric
    : compositionVenue?.defaultMetric ?? "monthlyVolume";
  const compositionMetricConfig = compositionVenue?.metrics.find((item) => item.id === activeCompositionMetric);
  const compositionSeries = useMemo<DisplaySeries[]>(() => {
    if (!data?.composition || !compositionVenue) return [];
    const semanticMetric = activeCompositionMetric === "monthlyVolume"
      ? "volume"
      : activeCompositionMetric.toLowerCase().includes("oi") ? "oi" : "snapshot";
    return data.composition.series
      .filter((item) => item.venue === compositionVenue.label && item.dimension === activeCompositionDimension && item.metric === activeCompositionMetric)
      .sort((left, right) => right.points.reduce((sum, point) => sum + point.value, 0) - left.points.reduce((sum, point) => sum + point.value, 0))
      .map((item, index) => ({
        id: item.id,
        category: "dex",
        venue: item.venue,
        metric: semanticMetric,
        quality: item.quality,
        sourceKey: "composition",
        definition: item.definition,
        points: item.points,
        color: VENUE_COLORS[index % VENUE_COLORS.length],
        label: item.group,
      }));
  }, [data, compositionVenue, activeCompositionDimension, activeCompositionMetric]);

  const compositionLatest = useMemo(() => {
    const latestDate = [...new Set(compositionSeries.flatMap((item) => item.points.map((point) => point.date)))].sort().at(-1);
    if (!latestDate) return null;
    const rows = compositionSeries.map((item) => ({ item, point: item.points.find((point) => point.date === latestDate) })).filter((row) => row.point);
    const total = rows.reduce((sum, row) => sum + (row.point?.value ?? 0), 0);
    const leader = rows.sort((left, right) => (right.point?.value ?? 0) - (left.point?.value ?? 0))[0];
    const unclassified = rows.filter((row) => /unclassified/i.test(row.item.label)).reduce((sum, row) => sum + (row.point?.value ?? 0), 0);
    return {
      date: latestDate,
      asOfDate: rows.map((row) => row.point?.asOfDate).filter((date): date is string => Boolean(date)).sort().at(-1),
      leader: leader?.item.label ?? "—",
      leaderShare: total > 0 ? 100 * (leader?.point?.value ?? 0) / total : 0,
      classifiedShare: total > 0 ? 100 * (total - unclassified) / total : 0,
    };
  }, [compositionSeries]);

  const categoryRows = data?.series.filter((series) => series.id.startsWith("category-")) ?? [];
  const contextSeries = data?.series.filter((series) => series.id.startsWith("context-")) ?? [];
  const correlations = data?.correlations[correlationMetric];
  const snapshotDate = data
    ? new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(data.meta.generatedAt))
    : "loading";
  const chartCaveat = mainMetric === "volume"
    ? "CEX aggregate = Binance perpetuals + Bybit and Kraken total futures. Coinbase is separate to avoid a changing historical universe."
    : "Not universe-matched: CEX = Binance, Bybit and Kraken BTC+ETH futures; DEX = Hyperliquid only. Coinbase’s collected OI snapshots are excluded from the aggregate.";

  function switchTheme() {
    setTheme((current) => current === "dark" ? "light" : "dark");
  }

  return (
    <ChartRangeProvider>
    <main>
      <header className="topbar">
        <a className="brand" href="#overview" aria-label="Activity Atlas home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Activity Atlas</span>
        </a>
        <nav aria-label="Dashboard sections">
          <a href="#overview">Overview</a>
          <a href="#breakdown">Inside a platform</a>
          <a href="#history">History</a>
          <a href="#correlation">Relationships</a>
          <a href="#sources">Data &amp; sources</a>
        </nav>
        <button className="theme-toggle" type="button" onClick={switchTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
          <span aria-hidden="true">{theme === "dark" ? "☀" : "◐"}</span>
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      </header>

      {data && <Freshness data={data} refreshWarning={refreshWarning} staleSnapshot={staleSnapshot} />}
      {data && <Overview data={data} />}
      {!data && !loadError && <div className="loading-state">Loading the market overview…</div>}
      {loadError && <div className="error-state">Could not load the dashboard data. Check your connection and reload this page.</div>}
      {data && <Breakdown data={data} />}
      <div className="chapter-heading" id="history"><span>GO DEEPER</span><h2>Follow the story over time.</h2><p>Choose platforms, explore the lines, and check what sits behind each number.</p></div>

      <section className="section-block comparison" aria-labelledby="comparison-title">
        <div className="section-head">
          <div>
            <p className="section-kicker">COMPARE THE GROUPS</p>
            <h2 id="comparison-title">How activity has changed</h2>
            <p>{mainView === "percent" ? "Percentage change from each line’s first positive visible value, not absolute market size." : mainView === "btc" ? "The same activity expressed in approximate BTC equivalents." : "Reported or derived USD values; source scope remains visible."}</p>
          </div>
          <MetricControls metric={mainMetric} setMetric={setMainMetric} view={mainView} setView={setMainView} />
        </div>

        {data && (
          <InteractiveChart
            key={`main-${mainMetric}`}
            chartId="category-comparison"
            rangeKey="category-comparison"
            title={`Category ${mainMetric === "volume" ? "monthly volume" : "month-end open interest"}`}
            series={mainSeries}
            view={mainView}
            metric={mainMetric}
            defaultStart="2023-01-01"
            completeThrough={data.meta.completeThrough}
            generatedAt={data.meta.generatedAt}
            theme={theme}
          />
        )}
        {!data && !loadError && <div className="loading-state">Loading sourced series…</div>}
        <div className="caveat-line"><b>Comparability note</b><span>{chartCaveat}</span></div>
      </section>

      <section className="section-block" id="venues" aria-labelledby="venues-title">
        <div className="section-head section-head-stacked">
          <div>
            <p className="section-kicker">PLATFORM DRILLDOWN</p>
            <h2 id="venues-title">Inside each category</h2>
            <p>{venueCategory === "dex" && venueMetric === "volume" ? "Top 10 by observed cumulative volume. Raw current MTD is included so new venues stay visible; ranking is provisional until month-end." : "Venue-level series using the best free history found."}</p>
          </div>
          <div className="venue-controls">
            <div className="segmented category-tabs" role="group" aria-label="Venue category">
              {(["cex", "dex", "cex-hl", "prediction"] as VenueCategory[]).map((category) => (
                <button key={category} type="button" className={venueCategory === category ? "active" : ""} aria-pressed={venueCategory === category} onClick={() => setVenueCategory(category)}>
                  {category === "cex" ? "CEX" : category === "dex" ? "Perp DEX" : category === "cex-hl" ? "CEX / Hyperliquid" : "Prediction"}
                </button>
              ))}
            </div>
            <MetricControls metric={venueMetric} setMetric={setVenueMetric} view={venueView} setView={setVenueView} />
          </div>
        </div>

        {data && venueSeries.length > 0 && (
          <InteractiveChart
            key={`venues-${venueCategory}-${venueMetric}`}
            chartId={`${venueCategory}-venues`}
            rangeKey="venue-drilldown"
            title={`${venueCategory === "cex-hl" ? "CEX / Hyperliquid" : CATEGORY_LABELS[venueCategory]} venue ${venueMetric}`}
            series={venueSeries}
            view={venueView}
            metric={venueMetric}
            defaultStart={venueCategory === "prediction" ? "2020-09-01" : "2023-01-01"}
            completeThrough={data.meta.completeThrough}
            generatedAt={data.meta.generatedAt}
            theme={theme}
          />
        )}
        {data && venueSeries.length === 0 && <div className="empty-state">No free historical series verified for this view.</div>}

        {data && venueCategory === "dex" && venueMetric === "volume" && (
          <div className="ranking-strip" aria-label="Perpetual DEX observed cumulative volume ranking">
            {data.rankings.perpDexByCumulativeVolume.slice(0, 10).map((item, index) => {
              const venue = data.series.find((series) => series.category === "dex" && series.metric === "volume" && series.venue === item.name);
              return (
                <div key={item.name}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <b>{item.name}</b>
                  <em>{formatUsd(item.cumulativeVolume, 1)}</em>
                  <small>{venue && firstObserved(venue.points) ? `${item.includesIncompleteMonth ? "includes current MTD · " : ""}since ${monthLabel(firstObserved(venue.points)!.date)}` : "coverage varies"}</small>
                </div>
              );
            })}
          </div>
        )}
        {venueCategory === "dex" && venueMetric === "oi" && (
          <div className="caveat-line"><b>Coverage gap</b><span>Only Hyperliquid L1 + HIP-3 historical OI was freely available. This is not global perp DEX OI.</span></div>
        )}
        {(venueCategory === "cex" || venueCategory === "cex-hl") && (
          <div className="caveat-line"><b>Scope matters</b><span>{venueMetric === "volume" ? "Binance and Hyperliquid: perpetuals. Bybit and Kraken: total futures, not verified perpetual-only. Coinbase: International exchange only; see its source definition below." : "Binance, Bybit and Kraken: BTC+ETH futures only. Hyperliquid: all covered L1 + HIP-3 OI. Coinbase International: collected all-perp snapshots only, with no pre-collection backfill."} These are not identical contract universes.</span></div>
        )}
        {data && (venueCategory === "cex" || venueCategory === "cex-hl") && (
          <details className="source-details venue-definitions">
            <summary>Definitions &amp; proxy limitations</summary>
            {venueSeries.map((item) => <p key={item.id}><b>{item.venue}</b> — {item.definition}</p>)}
            <p>“Proxy” means the source measures a different scope from the requested all-pair perpetuals. Bybit volume is copied from the vendor’s total-futures series; its OI is BTC futures OI + ETH futures OI at the last shared daily observation each month. No perpetual-only adjustment or independent reconciliation was made. The size of the mismatch is unknown.</p>
          </details>
        )}
      </section>

      <section className="section-block composition-section" id="composition" aria-labelledby="composition-title">
        <div className="section-head section-head-stacked">
          <div>
            <p className="section-kicker">BREAKDOWN HISTORY</p>
            <h2 id="composition-title">What the activity is made of</h2>
            <p>Explore individual asset types, market operators, or event categories. Current snapshots and full-month history are separate measures.</p>
          </div>
          {compositionVenue && (
            <div className="composition-controls">
              <div className="segmented category-tabs" role="group" aria-label="Composition venue">
                {data?.composition?.venues.map((venue) => (
                  <button
                    key={venue.id}
                    type="button"
                    className={compositionVenue.id === venue.id ? "active" : ""}
                    aria-pressed={compositionVenue.id === venue.id}
                    onClick={() => {
                      setCompositionVenueId(venue.id);
                      setCompositionDimension(venue.defaultDimension);
                      setCompositionMetric(venue.id === "hyperliquid" ? "volume24h" : venue.defaultMetric);
                      setCompositionView("absolute");
                    }}
                  >{venue.label}</button>
                ))}
              </div>
              <div className="segmented" role="group" aria-label="Breakdown dimension">
                {compositionVenue.dimensions.map((dimension) => (
                  <button key={dimension.id} type="button" className={activeCompositionDimension === dimension.id ? "active" : ""} aria-pressed={activeCompositionDimension === dimension.id} onClick={() => setCompositionDimension(dimension.id)}>{dimension.label}</button>
                ))}
              </div>
              <div className="segmented metric-tabs" role="group" aria-label="Composition metric">
                {compositionVenue.metrics.map((metric) => (
                  <button
                    key={metric.id}
                    type="button"
                    className={activeCompositionMetric === metric.id ? "active" : ""}
                    aria-pressed={activeCompositionMetric === metric.id}
                    onClick={() => {
                      setCompositionMetric(metric.id);
                      if (metric.unit === "multiple") setCompositionView("absolute");
                    }}
                  >{metric.label}</button>
                ))}
              </div>
              <div className="segmented" role="group" aria-label="Composition value display">
                <button type="button" className={compositionView === "absolute" ? "active" : ""} aria-pressed={compositionView === "absolute"} onClick={() => setCompositionView("absolute")}>{compositionMetricConfig?.unit === "multiple" ? "Multiple" : compositionMetricConfig?.unit === "contracts" ? "Contracts" : "USD"}</button>
                {compositionMetricConfig?.unit === "usd" && <button type="button" className={compositionView === "btc" ? "active" : ""} aria-pressed={compositionView === "btc"} onClick={() => setCompositionView("btc")}>BTC</button>}
                {compositionMetricConfig?.unit !== "multiple" && <button type="button" className={compositionView === "share" ? "active" : ""} aria-pressed={compositionView === "share"} onClick={() => setCompositionView("share")}>Share %</button>}
              </div>
            </div>
          )}
        </div>

        {data?.composition && compositionVenue && compositionSeries.length > 0 && (
          <>
            <div className="composition-facts">
              <div><span>Product</span><b>{compositionVenue.product}</b></div>
              <div><span>Latest observation</span><b>{compositionLatest ? (compositionLatest.asOfDate ? dayLabel(compositionLatest.asOfDate) : monthLabel(compositionLatest.date, false)) : "—"}</b></div>
              <div><span>Largest slice</span><b>{compositionLatest ? `${compositionLatest.leader} · ${formatShare(compositionLatest.leaderShare)}` : "—"}</b></div>
              <div><span>Classified share</span><b>{compositionLatest ? formatShare(compositionLatest.classifiedShare) : "—"}</b></div>
            </div>
            <InteractiveChart
              key={`composition-${compositionVenue.id}-${activeCompositionDimension}-${activeCompositionMetric}`}
              chartId="composition-analysis"
              rangeKey="composition-analysis"
              title={`${compositionVenue.label} · ${compositionMetricConfig?.label ?? activeCompositionMetric} by ${compositionVenue.dimensions.find((item) => item.id === activeCompositionDimension)?.label ?? activeCompositionDimension}`}
              series={compositionSeries}
              view={compositionMetricConfig?.unit === "multiple" ? "absolute" : compositionView}
              metric={compositionSeries[0]?.metric ?? "snapshot"}
              valueUnit={compositionMetricConfig?.unit ?? "usd"}
              axisLabel={compositionMetricConfig?.unit === "multiple" ? "TRADING / OPEN POSITIONS" : `${compositionMetricConfig?.label.toUpperCase() ?? "ACTIVITY"} · ${compositionMetricConfig?.unit === "contracts" ? "CONTRACTS" : "USD"}`}
              defaultStart="2023-01-01"
              completeThrough={data.meta.completeThrough}
              generatedAt={data.meta.generatedAt}
              theme={theme}
              showMetricNotes={false}
              showPartialBand={false}
            />
            <div className="composition-note-grid">
              <p><b>Coverage</b>{compositionVenue.coverageNote ?? "Coverage begins at the first verified public observation."}</p>
              <p><b>Classification</b>{compositionVenue.id === "hyperliquid" ? "Operator / deployer identifies who listed a HIP-3 market; it is not automatically the legal issuer of the referenced asset. Underlying labels are kept separately." : "Official taxonomy is used where available; deterministic mappings are disclosed, and unresolved labels stay Unclassified."}</p>
              <p><b>Current period</b>Incomplete calendar-month flows are dashed run-rate previews. OI and rolling snapshot metrics are never time-extrapolated.</p>
            </div>
            {data.composition.meta.warnings.length > 0 && (
              <details className="source-details composition-warnings">
                <summary>Refresh and fallback notes · {data.composition.meta.warnings.length}</summary>
                <div className="warning-grid">{data.composition.meta.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
              </details>
            )}
          </>
        )}
        {data?.composition && compositionVenue && compositionSeries.length === 0 && <div className="empty-state">No verified observations for this combination.</div>}
        {data && (!data.composition || data.composition.venues.length === 0) && <div className="empty-state">Composition data unavailable. The next refresh will retry public sources and retain any valid cache.</div>}
        {!data && !loadError && <div className="loading-state">Loading composition datasets…</div>}
      </section>

      <section className="section-block correlation-section" id="correlation" aria-labelledby="correlation-title">
        <div className="section-head">
          <div>
            <p className="section-kicker">EXPLORE THE RELATIONSHIP</p>
            <h2 id="correlation-title">Do these markets move together?</h2>
            <p>Compare their month-to-month changes—not their size. A similar pattern does not show that one market causes another to move.</p>
          </div>
          <MetricControls metric={correlationMetric} setMetric={setCorrelationMetric} view="absolute" setView={() => undefined} showView={false} />
        </div>
        {correlations && (
          <>
            <div className="correlation-grid">
              {Object.entries(correlations.pairs).map(([pair, result]) => (
                <article key={pair} className="correlation-card">
                  <div>
                    <p>{correlationMetric === "oi" ? PAIR_LABELS[pair].replace("Perp DEX", "Hyperliquid") : PAIR_LABELS[pair]}</p>
                  </div>
                  <h3 className="relationship-result">{correlationTone(result.pearson)}</h3>
                  <div className="relationship-scale" role="img" aria-label={`Correlation ${result.pearson?.toFixed(2) ?? "unavailable"}: ${correlationTone(result.pearson)}`}>
                    <span className="relationship-center" />
                    {result.pearson != null && <i style={{ left: `${(result.pearson + 1) * 50}%` }} />}
                  </div>
                  <div className="relationship-labels"><span>Opposite</span><span>No clear pattern</span><span>Similar</span></div>
                  <p className="relationship-period">{result.observations} monthly changes · {result.start && result.end ? `${monthLabel(result.start)} – ${monthLabel(result.end)}` : "Insufficient history"}</p>
                  <details className="relationship-details"><summary>Show exact statistics</summary><dl>
                    <div><dt>Pearson</dt><dd>{result.pearson?.toFixed(2) ?? "—"}</dd></div>
                    <div><dt>Spearman</dt><dd>{result.spearman?.toFixed(2) ?? "—"}</dd></div>
                    <div><dt>Months</dt><dd>{result.observations}</dd></div>
                  </dl></details>
                </article>
              ))}
            </div>
            <div className="finding-line">
              <span>READ</span>
              <p>{correlationMetric === "oi" ? "Open-position coverage differs: centralized exchanges include BTC + ETH futures only; the DEX comparison covers Hyperliquid only. " : "These comparisons use the covered groups, not the whole market. "}The full available overlapping history is used; the overview’s month selectors and chart sliders do not change this analysis. A value near the middle does not rule out other relationships.</p>
            </div>
            <details className="source-details"><summary>How this is calculated</summary><p className="method-line">{correlations.method} The marker shows Pearson correlation on a −1 to +1 scale, not a percentage or probability. Spearman provides a rank-based comparison. Descriptive labels use absolute thresholds of 0.2, 0.4 and 0.7; these are not statistical significance tests. Short histories are exploratory.</p></details>
          </>
        )}
      </section>

      {data && contextSeries.length > 0 && (
        <section className="section-block context-section" aria-labelledby="breadth-title">
          <div className="section-head simple">
            <div>
              <p className="section-kicker">PREDICTION-MARKET BREADTH</p>
              <h2 id="breadth-title">Activity beyond dollars</h2>
              <p>Supporting context only; units differ and are not combined.</p>
            </div>
          </div>
          <div className="context-grid">
            {contextSeries.map((series) => <MiniTrend key={series.id} series={series} completeThrough={data.meta.completeThrough} />)}
          </div>
        </section>
      )}

      <section className="section-block sources-section" id="sources" aria-labelledby="sources-title">
        <div className="section-head">
          <div>
            <p className="section-kicker">CHECK THE EVIDENCE</p>
            <h2 id="sources-title">What each line actually means</h2>
            <p>No interpolation or paid data. Missing coverage stays disclosed.</p>
          </div>
          <div className="download-links">
            <a href={`${PUBLIC_BASE_PATH}/data/activity-series.csv`} download>Download CSV</a>
            <a href={`${PUBLIC_BASE_PATH}/data/activity-data.json`} download>Download JSON</a>
          </div>
        </div>

        {data && (
          <>
            <DataHealth data={data} />
            <div className="coverage-table" role="table" aria-label="Category series coverage">
              <div className="coverage-row coverage-header" role="row">
                <span role="columnheader">Series</span><span role="columnheader">Measure</span><span role="columnheader">Coverage</span><span role="columnheader">Quality</span><span role="columnheader">Definition</span>
              </div>
              {categoryRows.map((series) => (
                <div className="coverage-row" role="row" key={series.id}>
                  <b role="cell">{CATEGORY_LABELS[series.category]}</b>
                  <span role="cell">{series.metric === "oi" ? "Month-end OI" : "Monthly volume"}</span>
                  <span role="cell">{firstObserved(series.points) ? monthLabel(firstObserved(series.points)!.date) : "—"} → {monthLabel(series.points.at(-1)?.date ?? "")}</span>
                  <span role="cell"><i className={`quality ${series.quality}`}>{QUALITY_LABELS[series.quality]}</i></span>
                  <p role="cell">{series.definition}</p>
                </div>
              ))}
            </div>

            <details className="source-details">
              <summary>Source catalog · {data.sources.length} public datasets</summary>
              <div className="source-list">
                {data.sources.map((source) => (
                  <a key={source.key} href={source.page} target="_blank" rel="noreferrer">
                    <span>{source.title}</span>
                    <small>{source.reportedFrequency} · direct: {source.publisher ?? "The Block"}{source.upstreamSources.filter((name) => name.toLowerCase() !== (source.publisher ?? "The Block").toLowerCase()).length ? ` · upstream: ${source.upstreamSources.filter((name) => name.toLowerCase() !== (source.publisher ?? "The Block").toLowerCase()).join(", ")}` : ""}</small>
                  </a>
                ))}
              </div>
            </details>

            <details className="source-details"><summary>Coverage limits and source notes</summary><div className="warning-grid">
              {data.meta.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div></details>
          </>
        )}
      </section>

      <footer>
        <span>Activity Atlas · public data, explained</span>
        <span>Generated {snapshotDate} · current month shown as partial</span>
      </footer>
    </main>
    </ChartRangeProvider>
  );
}
