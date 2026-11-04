/** @template {{date: string, value: number, valueBtc?: number | null, share?: number | null}} T
 * @param {T[]} points
 * @param {"absolute" | "btc" | "percent" | "share"} view
 * @returns {T[]}
 */
export function displayPoints(points, view) {
  if (view === "absolute") return points;
  if (view === "btc") {
    return points.flatMap((point) => Number.isFinite(point.valueBtc)
      ? [{ ...point, value: Number(point.valueBtc) }]
      : []);
  }
  if (view === "share") {
    return points.flatMap((point) => Number.isFinite(point.share)
      ? [{ ...point, value: Number(point.share) }]
      : []);
  }
  const baseline = points.find((point) => point.value > 0)?.value;
  return baseline ? points.map((point) => ({ ...point, value: 100 * (point.value / baseline - 1) })) : [];
}

/** Sum one latest snapshot per component and calendar month. Providers often
 * publish on different days, so exact-date joins can silently omit components.
 * The aggregate asOfDate is the oldest included component date: a conservative
 * freshness label for the mixed-date snapshot.
 * @param {{date: string, value: number, asOfDate?: string}[][]} seriesList
 * @param {{requireAll?: boolean}} options
 */
export function sumMonthlySnapshots(seriesList, { requireAll = false } = {}) {
  const maps = seriesList.map((series) => new Map(
    series.map((point) => [point.date.slice(0, 7), point]),
  ));
  const months = [...new Set(seriesList.flatMap((series) => series.map((point) => point.date.slice(0, 7))))].sort();
  return months.flatMap((month) => {
    const components = maps.map((map) => map.get(month));
    if (requireAll && components.some((point) => !point)) return [];
    const observed = components.filter(Boolean);
    if (!observed.length) return [];
    const asOfDates = observed.map((point) => point.asOfDate ?? point.date).sort();
    return [{
      date: `${month}-01`,
      value: observed.reduce((sum, point) => sum + point.value, 0),
      asOfDate: asOfDates[0],
      componentAsOfDates: observed.map((point) => point.asOfDate ?? point.date),
    }];
  });
}

function lastDayOfMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

/** Normalize a monthly flow source to one point per calendar month. Vendors can
 * change a "monthly" chart to daily rows without notice; taking one row as the
 * month would publish a single day as a monthly total. Daily buckets do not
 * overlap, so they sum. Only daily rows carry a real observation cutoff; monthly
 * buckets stay without asOfDate rather than receiving an invented one. A daily
 * month is complete only with a row for every calendar day: a later month's rows
 * never close it, and missing days stay missing rather than becoming zeros.
 * @param {{date: string, value: number}[]} rows
 */
export function monthlyFlowPoints(rows) {
  const months = new Map();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(row);
  }
  const isGranular = rows.some((row) => !row.date.endsWith("-01")) || [...months.values()].some((group) => group.length > 1);
  if (!isGranular) return rows.map((row) => ({ ...row }));
  const latestMonth = [...months.keys()].sort().at(-1);
  return [...months.keys()].sort().map((month) => {
    const group = months.get(month);
    const dates = group.map((row) => row.date).sort();
    const activeDates = group.filter((row) => row.value > 0).map((row) => row.date).sort();
    const asOfDate = activeDates.at(-1) ?? dates.at(-1);
    const observedDays = new Set(dates).size;
    const lastDay = lastDayOfMonth(month);
    // The newest month's last day must also be active: a zero there can be an unpublished bucket.
    const isCovered = observedDays === Number(lastDay.slice(8, 10)) && (month !== latestMonth || asOfDate === lastDay);
    return {
      date: `${month}-01`,
      value: group.reduce((sum, row) => sum + row.value, 0),
      asOfDate,
      observedDays,
      ...(isCovered ? {} : { isComplete: false }),
    };
  });
}

/** Sum monthly flow components per calendar month. The aggregate cutoff is the
 * oldest active component's cutoff, and it is omitted when any active component
 * has none. An incomplete component makes the aggregate incomplete.
 * @param {{date: string, value: number, asOfDate?: string, isComplete?: boolean}[][]} seriesList
 * @param {{requireAll?: boolean}} options
 */
export function sumMonthlyFlows(seriesList, { requireAll = false } = {}) {
  const maps = seriesList.map((series) => new Map(series.map((point) => [point.date, point])));
  const dates = [...new Set(seriesList.flatMap((series) => series.map((point) => point.date)))].sort();
  return dates.flatMap((date) => {
    const components = maps.map((map) => map.get(date));
    if (requireAll && components.some((point) => !point)) return [];
    const observed = components.filter(Boolean);
    const active = observed.filter((point) => point.value > 0);
    const cutoffs = active.length ? active.map((point) => point.asOfDate) : [];
    const known = cutoffs.length > 0 && cutoffs.every(Boolean);
    return [{
      date,
      value: observed.reduce((sum, point) => sum + point.value, 0),
      ...(known ? { asOfDate: [...cutoffs].sort()[0] } : {}),
      ...(observed.some((point) => point.isComplete === false) ? { isComplete: false } : {}),
    }];
  });
}

/** @param {number[]} values @param {"absolute" | "btc" | "percent" | "share"} view */
export function shouldUseLogScale(values, view) {
  if (view === "share") return false;
  const positive = view === "percent"
    ? values.filter((value) => value > -100).map((value) => 1 + value / 100).filter((value) => value > 0)
    : values.filter((value) => value > 0);
  const maximum = Math.max(...positive, 1);
  const minimum = Math.min(...positive, maximum);
  const decades = Math.log10(maximum) - Math.log10(Math.max(minimum, Number.EPSILON));
  return positive.length > 1 && decades >= 2 - 1e-12;
}

/** Linear percentage domain, always including zero and all observed changes.
 * @param {number[]} values
 * @returns {[number, number]}
 */
export function percentBounds(values) {
  const finite = values.filter(Number.isFinite);
  const low = Math.min(...finite, 0);
  const high = Math.max(...finite, 0);
  if (low === high) return [-1, 1];
  const padding = (high - low) * 0.08;
  return [low < 0 ? low - padding : 0, high > 0 ? high + padding : 0];
}

/** Build a transparent full-calendar-month run-rate for an incomplete monthly
 * volume flow. The observed value is never overwritten in the published data.
 * OI and other stock/count metrics return no projection.
 * @param {{date: string, value: number, valueBtc?: number | null, asOfDate?: string}} point
 * @param {{metric: string, generatedAt: string, completeThrough: string}} options
 */
export function partialVolumeProjection(point, { metric, generatedAt, completeThrough }) {
  const month = point.date.slice(0, 7);
  if (metric !== "volume" || month <= completeThrough) return {};
  if (!Number.isFinite(point.value) || point.value <= 0) {
    return { projectionUnavailableReason: "current-source-bucket-not-published" };
  }

  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const generatedDate = generatedAt.slice(0, 10);
  const priorUtcDay = new Date(Date.parse(`${generatedDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const explicitCoverage = point.asOfDate?.slice(0, 10);
  const coverageEnd = explicitCoverage?.startsWith(month) ? explicitCoverage : priorUtcDay;
  if (!coverageEnd.startsWith(month)) {
    return { projectionUnavailableReason: "no-completed-day-in-current-month" };
  }

  const coveredDays = Math.min(daysInMonth, Math.max(0, Number(coverageEnd.slice(8, 10))));
  if (!coveredDays) return { projectionUnavailableReason: "no-completed-day-in-current-month" };
  const multiplier = daysInMonth / coveredDays;
  return {
    projectionValue: point.value * multiplier,
    projectionValueBtc: Number.isFinite(point.valueBtc) ? Number(point.valueBtc) * multiplier : null,
    projectionCoveredDays: coveredDays,
    projectionDaysInMonth: daysInMonth,
    projectionMultiplier: multiplier,
    projectionCoverageEnd: coverageEnd,
    projectionCoverageBasis: explicitCoverage?.startsWith(month)
      ? "observed-source-date"
      : "assumed-through-prior-utc-day",
  };
}

/** @param {string[]} ids @param {Set<string>} hidden */
export function toggleAllHidden(ids, hidden) {
  return ids.every((id) => hidden.has(id)) ? new Set() : new Set(ids);
}

/** Resolve a user-selected calendar range against one chart's available dates.
 * The requested dates are never mutated: a chart with narrower coverage only
 * clamps its displayed boundaries, so another chart can restore the selection.
 * Null boundaries mean "use this chart's default start" and "follow latest".
 * @param {string[]} dates
 * @param {{start: string | null, end: string | null}} selection
 * @param {string} defaultStart
 */
export function resolveDateRange(dates, selection, defaultStart) {
  const available = [...new Set(dates)].sort();
  if (!available.length) {
    return { fromIndex: 0, toIndex: 0, rangeStart: defaultStart, rangeEnd: defaultStart };
  }

  const requestedDefaultIndex = available.findIndex((date) => date >= defaultStart);
  const defaultFromIndex = requestedDefaultIndex < 0 ? 0 : requestedDefaultIndex;
  const requestedStart = selection.start ?? available[defaultFromIndex];
  const requestedEnd = selection.end ?? available.at(-1);

  let fromIndex = available.findIndex((date) => date >= requestedStart);
  if (fromIndex < 0) fromIndex = available.length - 1;

  let toIndex = available.findLastIndex((date) => date <= requestedEnd);
  if (toIndex < 0) toIndex = 0;

  // A requested interval can fall entirely inside a gap in sparse coverage.
  // In that case, show the first observation after the gap as one clamped point.
  if (fromIndex > toIndex) toIndex = fromIndex;

  return {
    fromIndex,
    toIndex,
    rangeStart: available[fromIndex],
    rangeEnd: available[toIndex],
  };
}

/** Daily closes are completed UTC candles. Monthly volume conversion is an
 * equivalent-value approximation, not a reconstruction of traded BTC quantity.
 * @param {{date: string, value: number, asOfDate?: string}} point
 * @param {string} metric
 * @param {{date: string, close: number}[]} prices
 */
export function btcEquivalent(point, metric, prices) {
  if (!["volume", "oi"].includes(metric)) return {};
  const month = point.date.slice(0, 7);
  const asOfDate = point.asOfDate ?? (metric === "volume" ? `${month}-31` : point.date);
  const available = prices.filter((price) => price.date.slice(0, 7) === month
    && price.date <= asOfDate);
  const price = metric === "volume"
    ? available.reduce((sum, row) => sum + row.close, 0) / available.length
    : available.at(-1)?.close;
  if (!Number.isFinite(price) || !price || price <= 0) return { valueBtc: null };
  return {
    valueBtc: point.value / price,
    btcUsdPrice: price,
    btcPriceDate: available.at(-1)?.date,
    btcPriceMethod: metric === "volume" ? "mean-completed-daily-closes" : "last-completed-close-on-or-before-observation",
  };
}
