import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { completeComparison, compositionComparison, dataHealth, relativeHistory } from "../lib/activity-insights.mjs";
import { fetchJsonWithRetry, fetchOptionalJson } from "../lib/fetch-json.mjs";
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
