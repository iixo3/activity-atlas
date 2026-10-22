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
  const result = { dates, date, snapshot, rows: [], observedAt: null, volumeTotal: 0, oiTotal: 0, reason: "No matching trading and open-position observations for this period." };
  if (!date || !dates.includes(date)) return result;
  const get = (items) => new Map(items.flatMap((item) => {
    const point = item.points.find((point) => point.date === date && usable(point));
    return point ? [[item.group, point]] : [];
  }));
  const v = get(volumes);
  const o = get(interests);
  const groups = [...new Set([...v.keys(), ...o.keys()])];
  if (groups.some((group) => !v.has(group) || !o.has(group))) return { ...result, reason: "Some segments lack a matching measurement. Shares are withheld rather than treating missing data as zero." };
  const points = [...v.values(), ...o.values()];
  const observations = [...new Set(points.map((point) => point.collectedAt ?? point.asOfDate).filter(Boolean))];
  if (snapshot && observations.length !== 1) return { ...result, reason: "These snapshots were collected at different times. A matched breakdown is unavailable." };
  const volumeTotal = [...v.values()].reduce((sum, point) => sum + point.value, 0);
  const oiTotal = [...o.values()].reduce((sum, point) => sum + point.value, 0);
  if (!(volumeTotal > 0) || !(oiTotal > 0)) return { ...result, reason: "At least one total is zero; a meaningful share comparison is unavailable." };
  return {
    dates, date, snapshot, volumeTotal, oiTotal, observedAt: observations.sort()[0] ?? null, reason: null,
    rows: groups.map((group) => {
      const volume = v.get(group).value;
      const oi = o.get(group).value;
      const volumeShare = 100 * volume / volumeTotal;
      const oiShare = 100 * oi / oiTotal;
      return { group, volume, oi, volumeShare, oiShare, gap: volumeShare - oiShare, turnover: oi > 0 ? volume / oi : null };
    }).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)),
  };
}

function monthEnd(date) {
  const [year, month] = date.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function observationDate(point) {
  return point?.asOfDate?.slice(0, 10) ?? (point?.isComplete === true ? monthEnd(point.date) : null);
}

/** Evaluate against wall time, never the new file timestamp. Historical feeds
 * have a monthly deadline; current feeds get a 3-day publication grace period. */
export function dataHealth(data, now = new Date().toISOString()) {
  const previousMonth = new Date(`${now.slice(0, 7)}-01T00:00:00Z`);
  previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
  const expectedMonth = previousMonth.toISOString().slice(0, 7);
  const rows = [];
  const add = (id, label, series, historical = false) => {
    const latest = series.map((item) => item.points.at(-1)).filter(Boolean);
    const observed = latest.map(observationDate).filter(Boolean).sort()[0] ?? null;
    const complete = series.flatMap((item) => item.points.filter((point) => point.isComplete === true).map((point) => point.date)).sort().at(-1)?.slice(0, 7);
    const age = observed ? (Date.parse(`${now.slice(0, 10)}T00:00:00Z`) - Date.parse(`${observed}T00:00:00Z`)) / 86400000 : Infinity;
    const status = !observed ? "unknown" : (historical ? (complete ?? "") < expectedMonth : age > 3) ? "behind" : "current";
    rows.push({ id, label, observed, complete: complete ?? null, status, historical });
  };
  for (const item of data.series.filter((item) => item.id.startsWith("category-") || item.id === "cex-coinbase-oi")) {
    add(item.id, `${item.venue} · ${item.metric === "volume" ? "trading" : "open positions"}`, [item]);
  }
  const composition = data.composition?.series ?? [];
  for (const venue of data.composition?.venues ?? []) {
    const metrics = venue.id === "hyperliquid" ? ["volume24h", "monthlyVolume"] : [venue.qualityVolumeMetric];
    for (const metric of metrics) {
      const selected = composition.filter((item) => item.venue === venue.label && item.dimension === venue.defaultDimension && item.metric === metric);
      // Ignore segments that disappeared in older snapshots; evaluate the latest cohort.
      const last = selected.flatMap((item) => item.points.map((point) => point.date)).sort().at(-1);
      const current = selected.filter((item) => item.points.some((point) => point.date === last));
      add(`${venue.id}-${metric}`, `${venue.label} · ${metric === "monthlyVolume" ? "monthly breakdown" : "current breakdown"}`, current, metric === "monthlyVolume");
    }
  }
  return rows;
}
