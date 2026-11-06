import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { MIN_CORRELATION_CHANGES, breakdownReducer, breakdownViews, completeComparison, compositionComparison, correlationExtensions, dataHealth, hyperliquidOiReconciliation, initialBreakdownState, pairCorrelation, periodCorrelations, relativeHistory, resolveBreakdown } from "../lib/activity-insights.mjs";
import { monthlyFlowPoints, sumMonthlyFlows } from "../lib/activity-math.mjs";
import { fetchJsonWithRetry, fetchOptionalJson } from "../lib/fetch-json.mjs";
import { workflowResult } from "../lib/workflow-result.mjs";
import { fetchKalshiPredictionRecords } from "../scripts/composition-data.mjs";

const fixture = ["cex", "dex", "prediction"].map((category, index) => ({
  id: `category-${category}-volume`, category, metric: "volume", venue: category,
  points: [
    { date: "2026-08-01", value: [100, 20, 0][index], isComplete: true },
    { date: "2026-09-01", value: [120, 30, 10][index], isComplete: true },
    { date: "2026-10-01", value: 1e9, isComplete: false, projectionValue: 1e10 },
  ],
}));

test("overview uses identical full months, excludes projections and never invents zero-baseline growth", () => {
  const result = completeComparison(fixture, "volume", "2026-09");
  assert.equal(result.start, "2026-08-01");
  assert.equal(result.end, "2026-09-01");
  assert.ok(Math.abs(result.rows[0].change - 20) < 1e-9);
  assert.equal(result.rows[1].change, 50);
  assert.equal(result.rows[2].change, null);
  assert.deepEqual(completeComparison(fixture, "volume", "2026-09", { start: "2026-07-01" }).rows, []);
  assert.deepEqual(completeComparison(fixture, "volume", "2026-09", { end: "2026-10-01" }).rows, []);
  const missing = structuredClone(fixture);
  missing[1].points.splice(0, 1);
  assert.equal(completeComparison(missing, "volume", "2026-09").rows.length, 0);
});

test("relative size is numerator per 100 reference dollars, can exceed 100 and excludes partial months", () => {
  assert.deepEqual(relativeHistory(fixture, "volume", "dex", "cex", "2026-08-01", "2026-10-01"), [
    { date: "2026-08-01", value: 20 }, { date: "2026-09-01", value: 25 },
  ]);
  assert.equal(relativeHistory(fixture, "volume", "cex", "dex", "2026-09-01", "2026-09-01")[0].value, 400);
});

function breakdownFixture() {
  return ["Crypto", "Equities"].flatMap((group, i) => ["volume24h", "oiSnapshot"].map((metric) => ({
    venue: "Demo", group, dimension: "assetClass", metric,
    points: [{ date: "2026-10-01", asOfDate: "2026-10-22", collectedAt: "2026-10-22T08:00:00Z", isComplete: false, value: metric === "volume24h" ? [90, 10][i] : [50, 50][i] }],
  })));
}

test("share comparison aligns collection time, gives explicit gaps, and rejects missing counterparts", () => {
  const series = breakdownFixture();
  const result = compositionComparison(series, "Demo", "assetClass", "volume24h", "oiSnapshot");
  assert.equal(result.rows[0].gap, 40);
  assert.equal(result.volumeTotal, 100);
  assert.equal(result.rows.reduce((sum, row) => sum + row.oiShare, 0), 100);
  const missing = series.slice(0, -1);
  assert.match(compositionComparison(missing, "Demo", "assetClass", "volume24h", "oiSnapshot").reason, /lack a matching/);
  series[0].points[0].collectedAt = "2026-10-21T08:00:00Z";
  assert.match(compositionComparison(series, "Demo", "assetClass", "volume24h", "oiSnapshot").reason, /different times/);
});

test("fresh file timestamp cannot disguise stale observations, and unknown cutoffs stay unknown", () => {
  const data = { meta: { generatedAt: "2026-10-22T12:00:00Z" }, series: [
    { ...fixture[0], points: [{ date: "2026-10-01", value: 100, asOfDate: "2026-10-10", isComplete: false }] },
    fixture[1],
  ] };
  assert.equal(dataHealth(data, "2026-10-22T12:00:00Z")[0].status, "behind");
  assert.equal(dataHealth(data, "2026-10-22T12:00:00Z")[1].status, "unknown");
  data.series[0].points[0].asOfDate = "2026-10-22";
  assert.equal(dataHealth(data, "2026-10-22T12:00:00Z")[0].status, "current");
  assert.equal(dataHealth(data, "2026-10-26T12:00:00Z")[0].status, "behind");
});

test("temporary fetch failures retry but permanent denials do not", async () => {
  let calls = 0;
  const value = await fetchJsonWithRetry("https://example.com", { sleep: async () => {}, fetcher: async () => {
    calls++;
    return calls < 3 ? { ok: false, status: 503, statusText: "Unavailable" } : { ok: true, json: async () => ({ valid: true }) };
  } });
  assert.equal(calls, 3);
  assert.deepEqual(value, { valid: true });
  calls = 0;
  await assert.rejects(fetchJsonWithRetry("https://example.com", { sleep: async () => {}, fetcher: async () => { calls++; return { ok: false, status: 403, statusText: "Forbidden" }; } }), /403/);
  assert.equal(calls, 1);
});

test("Kalshi incomplete pagination is rejected rather than published as a full snapshot", async () => {
  await assert.rejects(fetchKalshiPredictionRecords(async () => ({ events: [], cursor: "repeated" })), /repeated a cursor/);
  let calls = 0;
  await assert.rejects(fetchKalshiPredictionRecords(async () => ({ events: [], cursor: String(++calls) })), /exceeded 100 pages/);
});

test("an optional Coinbase HTTP failure is explicit and does not abort other feed requests", async () => {
  const [otherFeed, coinbase] = await Promise.all([
    Promise.resolve({ current: true }),
    fetchOptionalJson("https://example.com/instruments", async () => { throw new Error("404 Not Found"); }),
  ]);
  assert.deepEqual(otherFeed, { current: true });
  assert.deepEqual(coinbase, { data: null, error: "404 Not Found" });
  assert.deepEqual(await fetchOptionalJson("https://example.com/instruments", async () => [{ type: "PERP" }]), { data: [{ type: "PERP" }], error: null });
});

test("published Hyperliquid current breakdown has matched volume and OI", async () => {
  const data = JSON.parse(await readFile(new URL("../public/data/activity-data.json", import.meta.url)));
  const result = compositionComparison(data.composition.series, "Hyperliquid", "assetClass", "volume24h", "oiSnapshot");
  assert.equal(result.reason, null);
  assert.ok(result.rows.length > 2);
  assert.ok(result.observedAt);
});

const months = (start, count) => Array.from({ length: count }, (_, index) => {
  const date = new Date(`${start}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + index);
  return date.toISOString().slice(0, 10);
});

function correlationFixture(count, values = (i, category) => 100 + (category + 1) * i + (i % 3) * 7 * (category === 1 ? -1 : 1)) {
  return ["cex", "dex", "prediction"].map((category, categoryIndex) => ({
    id: `category-${category}-oi`, category, metric: "oi",
    points: [...months("2025-01", count).map((date, index) => ({ date, value: values(index, categoryIndex), isComplete: true })), { date: months("2025-01", count + 1).at(-1), value: 1e9, isComplete: false }],
  }));
}

test("correlation covers only adjacent complete months inside the selected interval", () => {
  const series = correlationFixture(12);
  const result = periodCorrelations(series, "oi", { start: "2025-02-01", end: "2025-11-01", completeThrough: "2025-12" });
  for (const pair of Object.values(result.pairs)) {
    assert.equal(pair.observations, 9, "10 months give at most 9 changes");
    assert.equal(pair.baseMonth, "2025-02-01");
    assert.equal(pair.start, "2025-03-01");
    assert.equal(pair.end, "2025-11-01");
    assert.equal(pair.changeMonths.length, 9);
    assert.equal(pair.withheld, null);
    assert.ok(pair.pearson >= -1 && pair.pearson <= 1);
  }
  assert.notEqual(result.pairs.cex__dex.pearson, periodCorrelations(series, "oi", { start: "2025-01-01", end: "2025-12-01", completeThrough: "2025-12" }).pairs.cex__dex.pearson);
});

test("too few changes withhold the coefficient and never widen the selection", () => {
  const series = correlationFixture(14);
  const latestTwo = periodCorrelations(series, "oi", { start: "2026-01-01", end: "2026-02-01", completeThrough: "2026-02" });
  assert.equal(withheldPair(latestTwo.pairs.cex__dex).observations, 1);
  const five = periodCorrelations(series, "oi", { start: "2025-09-01", end: "2026-02-01", completeThrough: "2026-02" });
  assert.equal(withheldPair(five.pairs.cex__dex).observations, 5);
  assert.equal(five.from, "2025-09");
  const six = periodCorrelations(series, "oi", { start: "2025-08-01", end: "2026-02-01", completeThrough: "2026-02" }).pairs.cex__dex;
  assert.equal(six.observations, MIN_CORRELATION_CHANGES);
  assert.equal(six.withheld, null);
  assert.equal(typeof six.pearson, "number");
});

function withheldPair(pair) {
  assert.equal(pair.withheld, "too-few-changes");
  assert.equal(pair.pearson, null);
  assert.equal(pair.spearman, null);
  return pair;
}

test("gaps, partial months and nonpositive baselines produce no change and are not bridged", () => {
  const series = correlationFixture(12);
  series[0].points.splice(5, 1); // Missing Jun 2025 removes two changes for its pairs.
  series[1].points[8].value = 0; // Zero Sep 2025 removes two more.
  series[2].points[3].isComplete = false; // Partial Apr 2025 removes two.
  const result = periodCorrelations(series, "oi", { start: "2025-01-01", end: "2025-12-01", completeThrough: "2025-12" });
  assert.equal(result.pairs.cex__dex.observations, 11 - 2 - 2);
  assert.equal(result.pairs.cex__dex.changeMonths.includes("2025-06-01"), false);
  assert.equal(result.pairs.cex__dex.changeMonths.includes("2025-07-01"), false);
  assert.equal(result.pairs.cex__prediction.observations, 11 - 2 - 2);
  assert.equal(result.pairs.dex__prediction.observations, 11 - 2 - 2);
  const end = periodCorrelations(series, "oi", { start: "2025-01-01", end: "2026-01-01", completeThrough: "2026-01" });
  assert.equal(end.pairs.cex__dex.end, "2025-12-01", "the partial month never counts");
});

test("the coverage floor only narrows the interval and reports it", () => {
  const series = correlationFixture(20);
  const result = periodCorrelations(series, "oi", { start: "2025-01-01", end: "2026-08-01", completeThrough: "2026-08", coverageStart: "2025-06" });
  assert.equal(result.floorApplied, true);
  assert.equal(result.from, "2025-06");
  assert.equal(result.pairs.cex__dex.baseMonth, "2025-06-01");
  const inside = periodCorrelations(series, "oi", { start: "2025-08-01", end: "2026-08-01", completeThrough: "2026-08", coverageStart: "2025-06" });
  assert.equal(inside.floorApplied, false);
  assert.equal(inside.pairs.cex__dex.baseMonth, "2025-08-01");
});

test("extending the period is an explicit option that keeps the end month", () => {
  const dates = months("2024-01", 34);
  const end = dates.at(-1);
  const options = correlationExtensions(dates, end, "2024-07");
  assert.deepEqual(options.map((option) => option.id), ["last-12", "full-overlap"]);
  assert.equal(options[0].start, dates.at(-13));
  assert.equal(options[0].changes, 12);
  assert.equal(options[1].start, "2024-07-01");
  assert.equal(options[1].changes, 27);
  assert.deepEqual(correlationExtensions(months("2025-07", 8), months("2025-07", 8).at(-1)).map((option) => option.id), ["full-overlap"]);
  assert.deepEqual(correlationExtensions(["2026-10-01"], "2026-10-01"), []);
});

test("interactive correlation over the full overlap reproduces the published coefficient", async () => {
  const data = JSON.parse(await readFile(new URL("../public/data/activity-data.json", import.meta.url)));
  for (const metric of ["volume", "oi"]) {
    const { coverageStart, pairs } = data.correlations[metric];
    const dates = completeComparison(data.series, metric, data.meta.completeThrough).dates;
    const result = periodCorrelations(data.series, metric, { start: `${coverageStart}-01`, end: dates.at(-1), completeThrough: data.meta.completeThrough, coverageStart });
    for (const [key, published] of Object.entries(pairs)) {
      assert.equal(result.pairs[key].observations, published.observations, `${metric} ${key}`);
      assert.equal(result.pairs[key].pearson, published.pearson, `${metric} ${key}`);
      assert.equal(result.pairs[key].spearman, published.spearman, `${metric} ${key}`);
      assert.deepEqual(pairCorrelation(data.series.find((item) => item.id === `category-${key.split("__")[0]}-${metric}`).points, data.series.find((item) => item.id === `category-${key.split("__")[1]}-${metric}`).points, { start: coverageStart, completeThrough: data.meta.completeThrough }), published);
    }
  }
});

test("published data honors the audited default: latest two months are withheld for every pair", async () => {
  const data = JSON.parse(await readFile(new URL("../public/data/activity-data.json", import.meta.url)));
  for (const metric of ["volume", "oi"]) {
    const overview = completeComparison(data.series, metric, data.meta.completeThrough);
    const result = periodCorrelations(data.series, metric, { start: overview.start, end: overview.end, completeThrough: data.meta.completeThrough, coverageStart: data.correlations[metric].coverageStart });
    for (const pair of Object.values(result.pairs)) {
      assert.equal(pair.withheld, "too-few-changes");
      assert.equal(pair.observations, 1);
      assert.equal(pair.pearson, null);
    }
  }
});

test("a daily vendor series becomes monthly totals, with no single day published as a month", () => {
  const daily = [
    ...months("2026-09", 1).flatMap(() => Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, value: 2 }))),
    ...Array.from({ length: 31 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, value: 3 })),
    { date: "2026-11-01", value: 5 }, { date: "2026-11-02", value: 4 },
  ];
  assert.deepEqual(monthlyFlowPoints(daily), [
    { date: "2026-09-01", value: 60, asOfDate: "2026-09-30", observedDays: 30 },
    { date: "2026-10-01", value: 93, asOfDate: "2026-10-31", observedDays: 31 },
    { date: "2026-11-01", value: 9, asOfDate: "2026-11-02", observedDays: 2, isComplete: false },
  ]);
  const lagged = monthlyFlowPoints(daily.filter((row) => row.date <= "2026-10-29"));
  assert.equal(lagged.at(-1).isComplete, false, "a closed month without its last day is partial");
  // A monthly vendor series stays as published and receives no invented cutoff.
  const monthly = [{ date: "2026-09-01", value: 60 }, { date: "2026-10-01", value: 93 }];
  assert.deepEqual(monthlyFlowPoints(monthly), monthly);
  assert.deepEqual(sumMonthlyFlows([monthly, monthly]), [{ date: "2026-09-01", value: 120 }, { date: "2026-10-01", value: 186 }]);
});

const dailyRows = (month, { from = 1, through, skip = [], value = 1 } = {}) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const last = through ?? new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: last - from + 1 }, (_, index) => from + index)
    .filter((day) => !skip.includes(day))
    .map((day) => ({ date: `${month}-${String(day).padStart(2, "0")}`, value }));
};

test("a later month never closes a sparse daily month, and gaps are not filled with zeros", () => {
  const points = monthlyFlowPoints([
    ...dailyRows("2026-03", { skip: [15] }),
    ...dailyRows("2026-04", { from: 3 }),
    ...dailyRows("2026-05", { through: 29 }),
    ...dailyRows("2026-06"),
    ...dailyRows("2026-07", { through: 2 }),
  ]);
  assert.deepEqual(points, [
    { date: "2026-03-01", value: 30, asOfDate: "2026-03-31", observedDays: 30, isComplete: false },
    { date: "2026-04-01", value: 28, asOfDate: "2026-04-30", observedDays: 28, isComplete: false },
    { date: "2026-05-01", value: 29, asOfDate: "2026-05-29", observedDays: 29, isComplete: false },
    { date: "2026-06-01", value: 30, asOfDate: "2026-06-30", observedDays: 30 },
    { date: "2026-07-01", value: 2, asOfDate: "2026-07-02", observedDays: 2, isComplete: false },
  ]);
  // Full-month rows, including zero rows, count as coverage; only the newest month needs an active last day.
  const zeros = monthlyFlowPoints([...dailyRows("2026-05", { value: 0 }), ...dailyRows("2026-06"), ...dailyRows("2026-07", { through: 30 }), { date: "2026-07-31", value: 0 }]);
  assert.equal(zeros[0].isComplete, undefined);
  assert.equal(zeros[0].value, 0);
  assert.equal(zeros[2].isComplete, false);
  assert.equal(zeros[2].asOfDate, "2026-07-30");
  // Monthly buckets keep their behavior: no cutoff, no completeness claim either way.
  const monthly = [{ date: "2026-05-01", value: 9 }, { date: "2026-07-01", value: 8 }];
  assert.deepEqual(monthlyFlowPoints(monthly), monthly);
});

test("sparse daily months stay out of comparison and correlation, with no bridged change", () => {
  const completeThrough = "2026-12";
  const finalize = (points) => points.map((point) => ({ ...point, isComplete: point.date.slice(0, 7) <= completeThrough && point.isComplete !== false }));
  const fullYear = months("2026-01", 12);
  const monthlyFlow = (offset) => fullYear.map((date, index) => ({ date, value: 100 + offset * (index + 1) + (index % 3) * 9 }));
  const dailyFlow = fullYear.flatMap((date, index) => dailyRows(date.slice(0, 7), {
    value: 3 + (index % 4),
    ...(date === "2026-03-01" ? { skip: [15] } : date === "2026-07-01" ? { from: 2 } : date === "2026-10-01" ? { through: 30 } : {}),
  }));
  const prediction = sumMonthlyFlows([monthlyFlowPoints(dailyFlow), monthlyFlowPoints(dailyFlow.map((row) => ({ ...row, value: 0 })))]);
  assert.equal(prediction.find((point) => point.date === "2026-03-01").isComplete, false, "the aggregate inherits a sparse component");
  const series = [["cex", monthlyFlow(1)], ["dex", monthlyFlow(-2)], ["prediction", prediction]]
    .map(([category, points]) => ({ id: `category-${category}-volume`, category, metric: "volume", venue: category, points: finalize(points) }));
  const sparse = ["2026-03-01", "2026-07-01", "2026-10-01"];

  const overview = completeComparison(series, "volume", completeThrough);
  assert.deepEqual(overview.dates, fullYear.filter((date) => !sparse.includes(date)));
  assert.deepEqual(completeComparison(series, "volume", completeThrough, { start: "2026-02-01", end: "2026-03-01" }).rows, []);
  assert.deepEqual(completeComparison(series, "volume", completeThrough, { start: "2026-03-01", end: "2026-04-01" }).rows, []);

  const result = periodCorrelations(series, "volume", { start: "2026-01-01", end: "2026-12-01", completeThrough });
  const expected = ["2026-02-01", "2026-05-01", "2026-06-01", "2026-09-01", "2026-12-01"];
  assert.deepEqual(result.pairs.cex__prediction.changeMonths, expected);
  assert.deepEqual(result.pairs.dex__prediction.changeMonths, expected);
  assert.equal(result.pairs.cex__prediction.withheld, "too-few-changes");
  assert.equal(result.pairs.cex__dex.observations, 11, "a pair without the sparse series keeps its months");
  assert.deepEqual(relativeHistory(series, "volume", "prediction", "cex", "2026-02-01", "2026-04-01").map((row) => row.date), ["2026-02-01", "2026-04-01"]);
});

test("aggregate flows use the oldest active cutoff, and only when every active component has one", () => {
  const a = [{ date: "2026-11-01", value: 5, asOfDate: "2026-11-03", isComplete: false }];
  const b = [{ date: "2026-11-01", value: 7, asOfDate: "2026-11-02", isComplete: false }];
  const inactive = [{ date: "2026-11-01", value: 0, asOfDate: "2026-11-01", isComplete: false }];
  const unknown = [{ date: "2026-11-01", value: 7 }];
  assert.deepEqual(sumMonthlyFlows([a, b, inactive]), [{ date: "2026-11-01", value: 12, asOfDate: "2026-11-02", isComplete: false }]);
  assert.equal(sumMonthlyFlows([a, unknown])[0].asOfDate, undefined);
  assert.deepEqual(sumMonthlyFlows([a, []], { requireAll: true }), []);
});

test("published monthly volume series hold one point per month and reconcile to their components", async () => {
  const data = JSON.parse(await readFile(new URL("../public/data/activity-data.json", import.meta.url)));
  for (const item of data.series.filter((series) => series.metric === "volume")) {
    assert.ok(item.points.every((point) => point.date.endsWith("-01")), `${item.id} has non-monthly points`);
    assert.equal(new Set(item.points.map((point) => point.date)).size, item.points.length, item.id);
  }
  const aggregate = data.series.find((item) => item.id === "category-prediction-volume");
  const components = ["prediction-polymarket-volume", "prediction-polymarket-us-volume", "prediction-kalshi-volume"].map((id) => data.series.find((item) => item.id === id));
  for (const point of aggregate.points.filter((row) => row.date >= "2026-01-01")) {
    const sum = components.reduce((total, series) => total + (series.points.find((row) => row.date === point.date)?.value ?? 0), 0);
    assert.ok(Math.abs(sum - point.value) <= Math.max(1e-6, point.value * 1e-9), point.date);
  }
  for (const series of [aggregate, ...components]) {
    for (const point of series.points) {
      if (!Number.isFinite(point.observedDays)) continue;
      const [year, month] = point.date.split("-").map(Number);
      if (point.observedDays < new Date(Date.UTC(year, month, 0)).getUTCDate()) assert.equal(point.isComplete, false, `${series.id} ${point.date}`);
    }
  }
  for (const point of aggregate.points.filter((row) => row.isComplete === true)) {
    for (const series of components) {
      const component = series.points.find((row) => row.date === point.date);
      if (component) assert.equal(component.isComplete, true, `${series.id} ${point.date}`);
    }
  }
});

test("health separates check time, verified cutoff and complete period, and monitors Coinbase volume", () => {
  const data = {
    meta: {
      generatedAt: "2026-11-04T16:33:00.000Z",
      feedStatus: {
        "cex-coinbase-oi": { checkedAt: "2026-11-04T16:33:00.000Z", retrievedAt: "2026-10-15T10:36:02.066Z", failure: "502 Bad Gateway" },
        "cex-coinbase-volume": { checkedAt: "2026-11-04T16:33:00.000Z", retrievedAt: "2026-11-04T16:33:00.000Z", failure: null, note: "Source rows run through 2026-10-22." },
      },
    },
    sources: [{ key: "cexVolume", sourceUpdatedAt: "2026-11-04T01:00:00.000Z" }, { key: "binancePerpVolume", sourceUpdatedAt: "2026-11-03T06:00:00.000Z" }],
    series: [
      { id: "category-cex-volume", venue: "CEX", metric: "volume", sourceKey: "mixed-cex-volume", points: [{ date: "2026-10-01", value: 1, isComplete: true }, { date: "2026-11-01", value: 1, isComplete: false }] },
      { id: "cex-coinbase-volume", venue: "Coinbase International", metric: "volume", points: [{ date: "2026-09-01", value: 1, asOfDate: "2026-09-30", isComplete: true }, { date: "2026-10-01", value: 1, asOfDate: "2026-10-19", isComplete: false }] },
      { id: "cex-coinbase-oi", venue: "Coinbase International", metric: "oi", points: [{ date: "2026-10-01", value: 1, asOfDate: "2026-10-15", isComplete: false }] },
      { id: "category-stale-volume", venue: "Stale", metric: "volume", points: [{ date: "2026-08-01", value: 1, isComplete: true }, { date: "2026-11-01", value: 1, isComplete: false }] },
    ],
  };
  const rows = dataHealth(data, "2026-11-04T18:00:00.000Z");
  const row = (id) => rows.find((item) => item.id === id);
  assert.deepEqual([row("category-cex-volume").status, row("category-cex-volume").observed, row("category-cex-volume").complete], ["unknown", null, "2026-10"]);
  assert.equal(row("category-cex-volume").checkedAt, data.meta.generatedAt);
  assert.equal(row("category-cex-volume").sourceUpdatedAt, "2026-11-03T06:00:00.000Z", "oldest vendor stamp, and never used as a cutoff");
  assert.deepEqual([row("cex-coinbase-volume").status, row("cex-coinbase-volume").observed, row("cex-coinbase-volume").complete], ["behind", "2026-10-19", "2026-09"]);
  assert.match(row("cex-coinbase-volume").note, /2026-10-22/);
  assert.deepEqual([row("cex-coinbase-oi").status, row("cex-coinbase-oi").observed, row("cex-coinbase-oi").failure], ["behind", "2026-10-15", "502 Bad Gateway"]);
  assert.equal(row("cex-coinbase-oi").retrievedAt, "2026-10-15T10:36:02.066Z");
  assert.equal(row("category-stale-volume").status, "behind", "unknown cutoff with an old complete month is behind");
});

test("Hyperliquid vendor and official open interest are compared on a shared date without changing either", () => {
  const data = {
    series: [{ id: "dex-hyperliquid-oi", points: [{ date: "2026-10-01", asOfDate: "2026-10-31", value: 100 }, { date: "2026-11-01", asOfDate: "2026-11-01", value: 110 }] }],
    composition: { series: [
      { venue: "Hyperliquid", dimension: "assetClass", metric: "oiSnapshot", points: [{ date: "2026-10-01", asOfDate: "2026-10-31", collectedAt: "2026-10-31T15:00:00Z", value: 150 }, { date: "2026-11-01", asOfDate: "2026-11-04", collectedAt: "2026-11-04T15:00:00Z", value: 300 }] },
      { venue: "Hyperliquid", dimension: "assetClass", metric: "oiSnapshot", points: [{ date: "2026-10-01", asOfDate: "2026-10-31", collectedAt: "2026-10-31T15:00:00Z", value: 50 }] },
    ] },
  };
  const result = hyperliquidOiReconciliation(data);
  assert.equal(result.vendorDate, "2026-10-31");
  assert.equal(result.officialValue, 200);
  assert.equal(result.ratio, 2);
  assert.equal(result.sameDate, true);
});

const metricList = (...ids) => ids.map((id) => ({ id, label: id, unit: "usd" }));
function selectionFixture() {
  const venues = [
    { id: "hyperliquid", label: "Hyperliquid", defaultDimension: "assetClass", dimensions: [{ id: "assetClass" }, { id: "operator" }, { id: "instrument" }], metrics: metricList("monthlyVolume", "averageOi", "volume24h", "oiSnapshot"), qualityVolumeMetric: "monthlyVolume", qualityOiMetric: "averageOi" },
    { id: "kalshi-perps", label: "Kalshi Perps", defaultDimension: "assetClass", dimensions: [{ id: "assetClass" }, { id: "instrument" }], metrics: metricList("monthlyVolume", "averageOi"), qualityVolumeMetric: "monthlyVolume", qualityOiMetric: "averageOi" },
    { id: "kalshi-predictions", label: "Kalshi Predictions", defaultDimension: "category", dimensions: [{ id: "category" }, { id: "instrument" }], metrics: metricList("volume24h", "oiSnapshot"), qualityVolumeMetric: "volume24h", qualityOiMetric: "oiSnapshot" },
    { id: "polymarket", label: "Polymarket", defaultDimension: "category", dimensions: [{ id: "category" }, { id: "instrument" }], metrics: metricList("volume30d", "oiSnapshot", "monthlyVolumeApprox"), qualityVolumeMetric: "volume30d", qualityOiMetric: "oiSnapshot" },
  ];
  const series = (venue, dimension, metric, group, points) => ({ venue, dimension, metric, group, points });
  const snap = (date, day, value) => ({ date, asOfDate: `${date.slice(0, 8)}${day}`, collectedAt: `${date.slice(0, 8)}${day}T08:00:00Z`, isSnapshot: true, isComplete: false, value });
  const full = (date, value) => ({ date, value, isComplete: true });
  return { venues, series: [
    ...["volume24h", "oiSnapshot"].flatMap((metric) => [
      series("Hyperliquid", "assetClass", metric, "Crypto", [snap("2026-10-01", "31", 5), snap("2026-11-01", "04", 6)]),
      series("Hyperliquid", "operator", metric, "Core", [snap("2026-10-01", "31", 5), snap("2026-11-01", "04", 6)]),
      series("Hyperliquid", "instrument", metric, "BTC", [snap("2026-11-01", "04", 6)]),
      series("Kalshi Predictions", "category", metric, "Sports", [snap("2026-10-01", "30", 9), snap("2026-11-01", "03", 9)]),
    ]),
    ...["monthlyVolume", "averageOi"].flatMap((metric) => [
      series("Hyperliquid", "assetClass", metric, "Crypto", [full("2026-07-01", 7), full("2026-08-01", 8), { date: "2026-09-01", value: 1, isComplete: false }]),
      series("Kalshi Perps", "assetClass", metric, "Crypto", [full("2026-09-01", 3), full("2026-10-01", 4), { date: "2026-11-01", value: 1, isComplete: false }]),
    ]),
    ...["volume30d", "oiSnapshot"].map((metric) => series("Polymarket", "category", metric, "Sports", [snap("2026-10-01", "31", 2), snap("2026-11-01", "04", 3)])),
  ] };
}

test("Platform and Group by keep the chosen date and view; only View resets the date", () => {
  let state = { ...initialBreakdownState };
  state = breakdownReducer(state, { type: "date", value: "2026-10-01" });
  state = breakdownReducer(state, { type: "groupBy", value: "operator" });
  assert.equal(state.selectedDate, "2026-10-01");
  assert.equal(state.view, "snapshot");
  state = breakdownReducer(state, { type: "platform", value: "polymarket" });
  assert.equal(state.selectedDate, "2026-10-01");
  assert.equal(state.view, "snapshot");
  assert.equal(state.dimensionId, undefined, "Group by returns to the new platform's own default");
  state = breakdownReducer(state, { type: "view", value: "month" });
  assert.equal(state.selectedDate, undefined);
  assert.equal(state.view, "month");
});

test("an unsupported month stays selected with an explicit reason instead of jumping to latest", () => {
  const composition = selectionFixture();
  let state = breakdownReducer({ ...initialBreakdownState, view: "month" }, { type: "date", value: "2026-08-01" });
  assert.equal(resolveBreakdown(composition, state).comparison.date, "2026-08-01");
  assert.equal(resolveBreakdown(composition, state).comparison.reason, null);

  state = breakdownReducer(state, { type: "platform", value: "polymarket" });
  const unsupported = resolveBreakdown(composition, state);
  assert.equal(unsupported.view, "snapshot", "Polymarket offers snapshots only");
  assert.equal(unsupported.comparison.date, "2026-08-01");
  assert.deepEqual(unsupported.comparison.rows, []);
  assert.match(unsupported.comparison.reason, /Polymarket has no usable collected snapshot for Aug 2026\. Latest available: Nov 2026/);
  assert.deepEqual(unsupported.dateOptions, [
    { value: "2026-08-01", available: false },
    { value: "2026-10-01", available: true },
    { value: "2026-11-01", available: true },
  ]);

  state = breakdownReducer(state, { type: "platform", value: "hyperliquid" });
  const back = resolveBreakdown(composition, state);
  assert.equal(back.view, "month", "the remembered view returns where it applies");
  assert.equal(back.comparison.date, "2026-08-01");
  assert.equal(back.comparison.reason, null);
});

test("a group lacking the chosen snapshot month reports it and keeps the month", () => {
  const composition = selectionFixture();
  let state = breakdownReducer(initialBreakdownState, { type: "date", value: "2026-10-01" });
  state = breakdownReducer(state, { type: "groupBy", value: "instrument" });
  const result = resolveBreakdown(composition, state);
  assert.equal(result.comparison.date, "2026-10-01");
  assert.deepEqual(result.dateOptions.map((option) => [option.value, option.available]), [["2026-10-01", false], ["2026-11-01", true]]);
  assert.match(result.comparison.reason, /Hyperliquid has no usable collected snapshot for Oct 2026/);
});

test("views stay honest per platform, and an unchosen date follows that platform's latest", () => {
  const composition = selectionFixture();
  const views = Object.fromEntries(composition.venues.map((venue) => [venue.id, breakdownViews(venue)]));
  assert.deepEqual(views.hyperliquid.snapshot, { volumeMetric: "volume24h", oiMetric: "oiSnapshot" });
  assert.deepEqual(views.hyperliquid.month, { volumeMetric: "monthlyVolume", oiMetric: "averageOi" });
  assert.equal(views["kalshi-perps"].snapshot, null);
  assert.equal(views["kalshi-predictions"].month, null);
  assert.deepEqual(views.polymarket.snapshot, { volumeMetric: "volume30d", oiMetric: "oiSnapshot" });
  assert.equal(views.polymarket.month, null, "weekly buckets without matched open interest are not a calendar month");

  const perps = resolveBreakdown(composition, { ...initialBreakdownState, venueId: "kalshi-perps" });
  assert.equal(perps.view, "month");
  assert.equal(perps.comparison.date, "2026-10-01", "the partial month is not offered as complete");
  assert.deepEqual(Object.keys(perps.views), ["month"]);
  const predictions = resolveBreakdown(composition, { ...initialBreakdownState, venueId: "kalshi-predictions" });
  assert.equal(predictions.contracts, true);
  assert.equal(predictions.volumeMetric, "volume24h");
  assert.equal(predictions.collectedAtByDate["2026-10-01"], "2026-10-30T08:00:00Z");
  assert.deepEqual(Object.keys(resolveBreakdown(composition, { ...initialBreakdownState, venueId: "polymarket" }).views), ["snapshot"]);
  assert.equal(resolveBreakdown(composition, initialBreakdownState).viewNote, null);
});

test("a failed stage marks the run failed and names it; skipped never counts as passing", () => {
  const all = { refresh: "success", lint: "success", test: "success", pages: "success", persist: "success", artifact: "success" };
  assert.equal(workflowResult(all).ok, true);
  const cases = [
    [{ ...all, refresh: "failure", lint: "skipped", test: "skipped", pages: "skipped", persist: "skipped", artifact: "skipped" }, "refresh"],
    [{ ...all, lint: "failure", test: "skipped", pages: "skipped", persist: "skipped", artifact: "skipped" }, "lint"],
    [{ ...all, test: "failure", pages: "skipped", persist: "skipped", artifact: "skipped" }, "test"],
    [{ ...all, pages: "failure", persist: "skipped", artifact: "skipped" }, "pages"],
    [{ ...all, persist: "failure", artifact: "skipped" }, "persist"],
    [{ ...all, artifact: "" }, "artifact"],
  ];
  for (const [outcomes, stage] of cases) {
    const result = workflowResult(outcomes);
    assert.equal(result.ok, false);
    assert.equal(result.stage, stage);
    assert.match(result.message, /last good site stays online/);
  }
});

test("the workflow preserves the last good site, then fails visibly with the schedule intact", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "0 7,15 \* \* \*"/);
  assert.match(workflow, /cron: "37 \* \* \* \*"/);
  assert.match(workflow, /ACTIVITY_ATLAS_SKIP_DUNE: "1"/);
  assert.match(workflow, /publish: \$\{\{ steps\.pages\.outcome == 'success' \}\}/);
  assert.match(workflow, /if: needs\.build\.outputs\.publish == 'true'/);
  const finalStep = workflow.slice(workflow.indexOf("Mark the run failed"));
  assert.match(finalStep, /if: always\(\)/);
  assert.match(finalStep, /node scripts\/report-workflow-result\.mjs/);
  assert.doesNotMatch(finalStep, /continue-on-error/);
  for (const stage of ["refresh", "lint", "test", "pages", "persist", "artifact"]) assert.ok(finalStep.includes(`steps.${stage}.outcome`), stage);
  assert.ok(workflow.indexOf("Mark the run failed") < workflow.indexOf("  deploy:"));
});
