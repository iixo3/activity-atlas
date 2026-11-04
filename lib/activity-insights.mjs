/** Only compare matching, observed complete months. Never compare an MTD
 * projection with a full month, fill a missing value, or invent a zero baseline. */
export function completeComparison(series, metric, completeThrough, selection = {}) {
  const categories = ["cex", "dex", "prediction"];
  const items = categories.map((category) => series.find((item) => item.id === `category-${category}-${metric}`));
  const months = items.map((item) => new Map((item?.points ?? [])
    .filter((point) => point.isComplete !== false && point.date.slice(0, 7) <= completeThrough && Number.isFinite(point.value) && point.value >= 0)
    .map((point) => [point.date, point])));
  const dates = [...months[0].keys()].filter((date) => months.every((map) => map.has(date))).sort();
  const end = selection.end ?? dates.at(-1);
  const previous = end ? new Date(`${end.slice(0, 7)}-01T00:00:00Z`) : null;
  if (previous) previous.setUTCMonth(previous.getUTCMonth() - 1);
  const start = selection.start ?? previous?.toISOString().slice(0, 10);
  if (!start || !end || start >= end || !dates.includes(start) || !dates.includes(end)) return { dates, start, end, rows: [] };
  const rows = items.map((item, index) => {
    const before = months[index].get(start).value;
    const value = months[index].get(end).value;
    return { category: categories[index], venue: item.venue, before, value, change: before > 0 ? 100 * (value / before - 1) : null };
  });
  return { dates, start, end, rows };
}

export function relativeHistory(series, metric, numerator, denominator, start, end) {
  const a = series.find((item) => item.id === `category-${numerator}-${metric}`);
  const b = new Map((series.find((item) => item.id === `category-${denominator}-${metric}`)?.points ?? []).map((point) => [point.date, point]));
  return (a?.points ?? []).flatMap((point) => {
    const reference = b.get(point.date);
    if (point.date < start || point.date > end || point.isComplete === false || reference?.isComplete === false || !(reference?.value > 0)) return [];
    return [{ date: point.date, value: 100 * point.value / reference.value }];
  });
}

function adjacentMonth(previous, current) {
  const [prevYear, prevMonth] = previous.split("-").map(Number);
  const [year, month] = current.split("-").map(Number);
  return year * 12 + month - (prevYear * 12 + prevMonth) === 1;
}

/** Log changes between adjacent complete months inside an inclusive interval.
 * A gap, partial month or nonpositive value yields no change: nothing is bridged. */
export function logChanges(values, { start, completeThrough }) {
  const monthly = new Map(values
    .filter((row) => row.isComplete !== false && Number.isFinite(row.value))
    .map((row) => [row.date.slice(0, 7), row.value]));
  const months = [...monthly.keys()].filter((month) => month >= start && month <= completeThrough).sort();
  const result = [];
  for (let index = 1; index < months.length; index += 1) {
    const previousMonth = months[index - 1];
    const currentMonth = months[index];
    const previous = monthly.get(previousMonth);
    const current = monthly.get(currentMonth);
    if (!adjacentMonth(previousMonth, currentMonth) || previous <= 0 || current <= 0) continue;
    result.push({ date: `${currentMonth}-01`, value: Math.log(current / previous) });
  }
  return result;
}

function pearson(left, right) {
  if (left.length !== right.length || left.length < 3) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator === 0 ? null : numerator / denominator;
}

function ranks(values) {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const result = Array(values.length);
  let cursor = 0;
  while (cursor < sorted.length) {
    let end = cursor + 1;
    while (end < sorted.length && sorted[end].value === sorted[cursor].value) end += 1;
    const rank = (cursor + 1 + end) / 2;
    for (let index = cursor; index < end; index += 1) result[sorted[index].index] = rank;
    cursor = end;
  }
  return result;
}

function pairChanges(left, right, options) {
  const leftChanges = new Map(logChanges(left, options).map((row) => [row.date, row.value]));
  const rightChanges = new Map(logChanges(right, options).map((row) => [row.date, row.value]));
  const dates = [...leftChanges.keys()].filter((date) => rightChanges.has(date)).sort();
  return { dates, leftValues: dates.map((date) => leftChanges.get(date)), rightValues: dates.map((date) => rightChanges.get(date)) };
}

export function pairCorrelation(left, right, options) {
  const { dates, leftValues, rightValues } = pairChanges(left, right, options);
  return {
    pearson: pearson(leftValues, rightValues),
    spearman: pearson(ranks(leftValues), ranks(rightValues)),
    observations: dates.length,
    start: dates[0] ?? null,
    end: dates.at(-1) ?? null,
  };
}

/** Display guard, not a significance test: below this many monthly changes the
 * dashboard withholds the coefficient and says why. */
export const MIN_CORRELATION_CHANGES = 6;
export const CORRELATION_PAIRS = [["cex", "dex"], ["cex", "prediction"], ["dex", "prediction"]];

function previousMonthStart(date) {
  const previous = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  return previous.toISOString().slice(0, 10);
}

/** Correlate all three category pairs over exactly the selected inclusive
 * interval. Selection is never widened: the coverage floor can only narrow it,
 * and every result reports the changes it actually used. */
export function periodCorrelations(series, metric, { start, end, completeThrough, coverageStart = "", minChanges = MIN_CORRELATION_CHANGES }) {
  const from = [start?.slice(0, 7) ?? "", coverageStart.slice(0, 7)].sort().at(-1);
  const to = end ? [end.slice(0, 7), completeThrough].sort()[0] : "";
  const points = (category) => series.find((item) => item.id === `category-${category}-${metric}`)?.points ?? [];
  const results = Object.fromEntries(CORRELATION_PAIRS.map(([left, right]) => {
    const options = { start: from, completeThrough: to };
    const pair = start && end
      ? pairCorrelation(points(left), points(right), options)
      : { pearson: null, spearman: null, observations: 0, start: null, end: null };
    const withheld = pair.observations < minChanges ? "too-few-changes" : pair.pearson == null ? "no-variation" : null;
    return [`${left}__${right}`, {
      ...pair,
      pearson: withheld ? null : pair.pearson,
      spearman: withheld ? null : pair.spearman,
      baseMonth: pair.start ? previousMonthStart(pair.start) : null,
      changeMonths: start && end ? pairChanges(points(left), points(right), options).dates : [],
      withheld,
    }];
  }));
  return { start, end, from: from || null, to: to || null, floorApplied: Boolean(start && from !== start.slice(0, 7)), minChanges, pairs: results };
}

/** Explicit interval extensions for the shared overview selection. Each option
 * keeps the end month and only moves the start; nothing here runs automatically. */
export function correlationExtensions(dates, end, coverageStart = "") {
  if (!end) return [];
  const usable = dates.filter((date) => date.slice(0, 7) >= coverageStart.slice(0, 7) && date < end);
  if (!usable.length) return [];
  const yearEarlier = new Date(`${end.slice(0, 7)}-01T00:00:00Z`);
  yearEarlier.setUTCMonth(yearEarlier.getUTCMonth() - 12);
  const lastYear = yearEarlier.toISOString().slice(0, 10);
  const inside = (start) => dates.filter((date) => date >= start && date <= end);
  const changes = (start) => inside(start).filter((date, index, months) => index > 0 && adjacentMonth(months[index - 1], date)).length;
  return [
    ...(usable.includes(lastYear) && lastYear !== usable[0] ? [{ id: "last-12", start: lastYear, changes: changes(lastYear) }] : []),
    { id: "full-overlap", start: usable[0], changes: changes(usable[0]) },
  ];
}

const monthName = (date) => new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date.slice(0, 7)}-01T00:00:00Z`));

/** Pair within the same period AND collection. A missing slice is not zero. */
export function compositionComparison(series, venue, dimension, volumeMetric, oiMetric, requestedDate) {
  const relevant = series.filter((item) => item.venue === venue && item.dimension === dimension);
  const snapshot = ["volume24h", "volume30d"].includes(volumeMetric);
  const usable = (point) => Number.isFinite(point.value) && point.value >= 0 && (snapshot || point.isComplete !== false);
  const volumes = relevant.filter((item) => item.metric === volumeMetric);
  const interests = relevant.filter((item) => item.metric === oiMetric);
  const volumeDates = new Set(volumes.flatMap((item) => item.points.filter(usable).map((point) => point.date)));
  const oiDates = new Set(interests.flatMap((item) => item.points.filter(usable).map((point) => point.date)));
  const dates = [...volumeDates].filter((date) => oiDates.has(date)).sort();
  const date = requestedDate ?? dates.at(-1);
  const result = { dates, date, snapshot, rows: [], observedAt: null, volumeTotal: 0, oiTotal: 0, dateAvailable: dates.includes(date), reason: "No matching trading and open-interest observations for this period." };
  if (!date || !dates.includes(date)) return result;
  const get = (items) => new Map(items.flatMap((item) => {
    const point = item.points.find((point) => point.date === date && usable(point));
    return point ? [[item.group, point]] : [];
  }));
  const v = get(volumes);
  const o = get(interests);
  const groups = [...new Set([...v.keys(), ...o.keys()])];
  const noTrading = groups.filter((group) => !v.has(group));
  const noInterest = groups.filter((group) => !o.has(group));
  if (noTrading.length || noInterest.length) {
    const list = (names) => `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
    const detail = [noTrading.length ? `no trading measurement: ${list(noTrading)}` : "", noInterest.length ? `no open-interest measurement: ${list(noInterest)}` : ""].filter(Boolean).join("; ");
    return { ...result, reason: `Some segments lack a matching measurement (${detail}). Shares are withheld rather than treating missing data as zero.` };
  }
  const points = [...v.values(), ...o.values()];
  const observations = [...new Set(points.map((point) => point.collectedAt ?? point.asOfDate).filter(Boolean))];
  if (snapshot && observations.length !== 1) return { ...result, reason: "These snapshots were collected at different times. A matched breakdown is unavailable." };
  const volumeTotal = [...v.values()].reduce((sum, point) => sum + point.value, 0);
  const oiTotal = [...o.values()].reduce((sum, point) => sum + point.value, 0);
  if (!(volumeTotal > 0) || !(oiTotal > 0)) return { ...result, reason: "At least one total is zero; a meaningful share comparison is unavailable." };
  return {
    dates, date, snapshot, volumeTotal, oiTotal, dateAvailable: true, observedAt: observations.sort()[0] ?? null, reason: null,
    rows: groups.map((group) => {
      const volume = v.get(group).value;
      const oi = o.get(group).value;
      const volumeShare = 100 * volume / volumeTotal;
      const oiShare = 100 * oi / oiTotal;
      return { group, volume, oi, volumeShare, oiShare, gap: volumeShare - oiShare, turnover: oi > 0 ? volume / oi : null };
    }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)),
  };
}

export const BREAKDOWN_VIEW_LABELS = { snapshot: "Collected snapshot", month: "Full calendar month" };

/** Which views a platform can honestly offer, from the metrics it publishes.
 * Rolling windows and contract counts stay as published, not standardized. */
export function breakdownViews(venue) {
  const metrics = new Set((venue?.metrics ?? []).map((metric) => metric.id));
  const volumeWindow = metrics.has("volume24h") ? "volume24h" : metrics.has("volume30d") ? "volume30d" : null;
  return {
    snapshot: volumeWindow && metrics.has("oiSnapshot") ? { volumeMetric: volumeWindow, oiMetric: "oiSnapshot" } : null,
    month: metrics.has("monthlyVolume") && metrics.has("averageOi") ? { volumeMetric: "monthlyVolume", oiMetric: "averageOi" } : null,
  };
}

function breakdownViewNote(venue, views) {
  if (views.snapshot && views.month) return null;
  if (views.month) return `${venue.label} publishes full calendar months only, so it has no collected snapshot view.`;
  if (venue.metrics?.some((metric) => metric.id === "monthlyVolumeApprox")) return `${venue.label} has collected snapshots only. Its weekly-bucket category history is not an exact calendar month and has no matching open interest.`;
  return `${venue.label} has collected snapshots only, so it has no full-calendar-month view.`;
}

export const initialBreakdownState = { venueId: "hyperliquid", dimensionId: undefined, view: "snapshot", selectedDate: undefined, showAll: false };

/** Platform and Group by keep the chosen date and view. Only an explicit View
 * change may reset the date. A view a platform lacks stays remembered for the
 * platforms that do offer it. */
export function breakdownReducer(state, action) {
  switch (action.type) {
    case "platform": return { ...state, venueId: action.value, dimensionId: undefined, showAll: false };
    case "groupBy": return { ...state, dimensionId: action.value, showAll: false };
    case "view": return { ...state, view: action.value, selectedDate: undefined };
    case "date": return { ...state, selectedDate: action.value };
    case "showAll": return { ...state, showAll: !state.showAll };
    default: return state;
  }
}

/** Resolve state against one platform. The chosen month is never replaced: when
 * unsupported it stays selected and the result explains that it is unavailable. */
export function resolveBreakdown(composition, state) {
  const venue = composition?.venues.find((item) => item.id === state.venueId) ?? composition?.venues[0];
  if (!venue) return null;
  const dimension = venue.dimensions.find((item) => item.id === state.dimensionId)?.id ?? venue.defaultDimension;
  const views = breakdownViews(venue);
  const view = views[state.view] ? state.view : views.snapshot ? "snapshot" : "month";
  const metrics = views[view];
  if (!metrics) return null;
  const comparison = compositionComparison(composition.series, venue.label, dimension, metrics.volumeMetric, metrics.oiMetric, state.selectedDate);
  const { date, dates } = comparison;
  const dateOptions = [...new Set([...dates, ...(date ? [date] : [])])].sort().map((value) => ({ value, available: dates.includes(value) }));
  const collections = new Map(composition.series
    .filter((item) => item.venue === venue.label && item.dimension === dimension && item.metric === metrics.oiMetric)
    .flatMap((item) => item.points.filter((point) => point.collectedAt).map((point) => [point.date, point.collectedAt])));
  const reason = date && !comparison.dateAvailable
    ? `${venue.label} has no ${BREAKDOWN_VIEW_LABELS[view].toLowerCase()} for ${monthName(date)}${dates.length ? `. Available: ${monthName(dates[0])} to ${monthName(dates.at(-1))}` : ""}. Your month stays selected until you change it.`
    : comparison.reason;
  return {
    venue, dimension, views, view, ...metrics,
    viewNote: breakdownViewNote(venue, views),
    comparison: { ...comparison, reason },
    dateOptions,
    collectedAtByDate: Object.fromEntries(collections),
    isLatest: Boolean(date && date === dates.at(-1)),
    contracts: venue.id === "kalshi-predictions",
  };
}

function monthEnd(date) {
  const [year, month] = date.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function observationDate(point) {
  return point?.asOfDate?.slice(0, 10) ?? (point?.isComplete === true ? monthEnd(point.date) : null);
}

const SOURCE_KEYS = { "mixed-cex-volume": ["binancePerpVolume", "cexVolume"] };

function sourceUpdatedAt(data, sourceKey) {
  if (!sourceKey) return null;
  const keys = SOURCE_KEYS[sourceKey] ?? sourceKey.split("+");
  const stamps = keys.map((key) => data.sources?.find((source) => source.key === key)?.sourceUpdatedAt);
  return stamps.length && stamps.every(Boolean) ? [...stamps].sort()[0] : null;
}

/** Evaluate against wall time, never the new file timestamp. Three things stay
 * separate: when a feed was checked or retrieved, the observation cutoff the
 * source verifiably covers, and the latest complete period. Historical feeds
 * have a monthly deadline; current feeds get a 3-day publication grace period. */
export function dataHealth(data, now = new Date().toISOString()) {
  const previousMonth = new Date(`${now.slice(0, 7)}-01T00:00:00Z`);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  const expectedMonth = previousMonth.toISOString().slice(0, 7);
  const rows = [];
  const feeds = { ...data.meta?.feedStatus, ...data.composition?.meta?.feedStatus };
  const add = (id, label, series, { historical = false, feedKey = id, sourceKey = series[0]?.sourceKey } = {}) => {
    const latest = series.map((item) => item.points.at(-1)).filter(Boolean);
    const observed = latest.map(observationDate).filter(Boolean).sort()[0] ?? null;
    const complete = series.flatMap((item) => item.points.filter((point) => point.isComplete === true).map((point) => point.date)).sort().at(-1)?.slice(0, 7);
    const age = observed ? (Date.parse(`${now.slice(0, 10)}T00:00:00Z`) - Date.parse(`${observed}T00:00:00Z`)) / 86400000 : Infinity;
    const completeBehind = (complete ?? "") < expectedMonth;
    const status = historical
      ? (completeBehind ? "behind" : observed ? "current" : "unknown")
      : observed ? (age > 3 ? "behind" : "current") : (complete && completeBehind ? "behind" : "unknown");
    const feed = feeds[feedKey] ?? {};
    rows.push({
      id, label, observed, complete: complete ?? null, status, historical,
      checkedAt: feed.checkedAt ?? data.meta?.generatedAt ?? null,
      retrievedAt: feed.retrievedAt ?? data.meta?.generatedAt ?? null,
      sourceUpdatedAt: sourceUpdatedAt(data, sourceKey),
      failure: feed.failure ?? null,
      note: feed.note ?? null,
    });
  };
  for (const item of data.series.filter((item) => item.id.startsWith("category-") || item.id === "cex-coinbase-oi" || item.id === "cex-coinbase-volume")) {
    add(item.id, `${item.venue} · ${item.metric === "volume" ? "trading" : "open interest"}`, [item]);
  }
  const composition = data.composition?.series ?? [];
  const feedKeys = { hyperliquid: { volume24h: "hyperliquidLive", monthlyVolume: "hyperliquid" }, "kalshi-perps": { monthlyVolume: "kalshiPerps" }, "kalshi-predictions": { volume24h: "kalshiPredictions" }, polymarket: { volume30d: "polymarket" } };
  for (const venue of data.composition?.venues ?? []) {
    const metrics = venue.id === "hyperliquid" ? ["volume24h", "monthlyVolume"] : [venue.qualityVolumeMetric];
    for (const metric of metrics) {
      const selected = composition.filter((item) => item.venue === venue.label && item.dimension === venue.defaultDimension && item.metric === metric);
      // Ignore segments that disappeared in older snapshots; evaluate the latest cohort.
      const last = selected.flatMap((item) => item.points.map((point) => point.date)).sort().at(-1);
      const current = selected.filter((item) => item.points.some((point) => point.date === last));
      add(`${venue.id}-${metric}`, `${venue.label} · ${metric === "monthlyVolume" ? "monthly breakdown" : "current breakdown"}`, current, { historical: metric === "monthlyVolume", feedKey: feedKeys[venue.id]?.[metric], sourceKey: null });
    }
  }
  return rows;
}

/** Compare the vendor's Hyperliquid OI total with the official snapshot sum for
 * the closest shared observation. Disclosure only: neither source is adjusted. */
export function hyperliquidOiReconciliation(data) {
  const vendor = data.series.find((item) => item.id === "dex-hyperliquid-oi")?.points ?? [];
  const official = new Map();
  for (const item of data.composition?.series ?? []) {
    if (item.venue !== "Hyperliquid" || item.dimension !== "assetClass" || item.metric !== "oiSnapshot") continue;
    for (const point of item.points) {
      const entry = official.get(point.date) ?? { value: 0, asOfDate: point.asOfDate, collectedAt: point.collectedAt };
      entry.value += point.value;
      official.set(point.date, entry);
    }
  }
  const pairs = vendor.flatMap((point) => {
    const match = official.get(point.date);
    return match && point.value > 0 ? [{ vendorValue: point.value, vendorDate: point.asOfDate, officialValue: match.value, officialDate: match.asOfDate, collectedAt: match.collectedAt, ratio: match.value / point.value, sameDate: point.asOfDate === match.asOfDate }] : [];
  });
  return pairs.findLast((pair) => pair.sameDate) ?? pairs.at(-1) ?? null;
}
