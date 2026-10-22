import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { btcEquivalent, displayPoints, partialVolumeProjection, percentBounds, resolveDateRange, shouldUseLogScale, sumMonthlySnapshots, toggleAllHidden } from "../lib/activity-math.mjs";
import { nextParisRefresh } from "../lib/refresh-schedule.mjs";

const snapshot = JSON.parse(await readFile(new URL("../public/data/activity-data.json", import.meta.url), "utf8"));
const byId = (id) => snapshot.series.find((item) => item.id === id);
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders Activity Atlas", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Activity Atlas/);
  assert.match(html, /Follow the story over time/);
  assert.match(html, /How activity has changed/i);
  assert.match(html, /CEX \/ Hyperliquid/);
  assert.match(html, /BREAKDOWN HISTORY/i);
  assert.match(html, /What the activity is made of/i);
  assert.match(html, />% change<\/button>/);
  assert.doesNotMatch(html, /Indexed|index-cue/);
  assert.match(html, />BTC<\/button>/);
});

test("snapshot contains complete, auditable comparison data", async () => {
  assert.equal(snapshot.meta.currency, "USD");
  const generated = new Date(snapshot.meta.generatedAt);
  const previousMonth = new Date(Date.UTC(generated.getUTCFullYear(), generated.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  assert.equal(snapshot.meta.completeThrough, previousMonth);
  assert.equal(snapshot.meta.currentMonthPartial, true);
  assert.ok(snapshot.series.length >= 34);
  assert.equal(snapshot.rankings.displayedTopTen.length, 10);
  assert.deepEqual(
    snapshot.rankings.displayedTopTen,
    snapshot.rankings.perpDexByCumulativeVolume.slice(0, 10).map((item) => item.name),
  );
  assert.ok(snapshot.rankings.perpDexByCumulativeVolume.every((item, index, values) => index === 0 || values[index - 1].cumulativeVolume >= item.cumulativeVolume));
  assert.ok(snapshot.rankings.perpDexByCumulativeVolume.every((item) => item.cumulativeVolume >= item.completeCumulativeVolume));

  for (const metric of ["volume", "oi"]) {
    assert.equal(Object.keys(snapshot.correlations[metric].pairs).length, 3);
    for (const result of Object.values(snapshot.correlations[metric].pairs)) {
      assert.ok(result.observations >= 12);
      assert.ok(result.end.slice(0, 7) <= snapshot.meta.completeThrough);
    }
  }

  const required = [
    "category-cex-volume",
    "category-dex-volume",
    "category-prediction-volume",
    "category-cex-oi",
    "category-dex-oi",
    "category-prediction-oi",
    "cex-kraken-volume",
    "cex-kraken-oi",
    "cex-coinbase-volume",
  ];
  for (const id of required) {
    const series = snapshot.series.find((item) => item.id === id);
    assert.ok(series, `missing ${id}`);
    assert.ok(series.points.length > 12, `insufficient ${id}`);
    assert.ok(series.points.some((point) => point.isComplete === false), `missing partial flag ${id}`);
  }

  for (const id of ["prediction-kalshi-volume", "prediction-polymarket-us-volume"]) {
    const series = snapshot.series.find((item) => item.id === id);
    assert.ok(series.points[0].value > 0, `${id} retains misleading pre-launch zeros`);
  }
});

test("one bulk action hides every series, then restores them; individual selection still works", () => {
  const ids = ["binance", "bybit", "hyperliquid"];
  const hidden = toggleAllHidden(ids, new Set());
  assert.deepEqual([...hidden], ids);
  hidden.delete("hyperliquid");
  assert.equal(hidden.has("hyperliquid"), false);
  assert.deepEqual([...toggleAllHidden(ids, hidden)], ids);
  assert.deepEqual([...toggleAllHidden(ids, new Set(ids))], []);
});

test("monthly snapshots aggregate components published on different days", () => {
  const result = sumMonthlySnapshots([
    [{ date: "2026-10-01", asOfDate: "2026-10-13", value: 10 }],
    [{ date: "2026-10-01", asOfDate: "2026-10-14", value: 20 }],
    [{ date: "2026-10-01", asOfDate: "2026-10-12", value: 30 }],
  ]);
  assert.deepEqual(result, [{
    date: "2026-10-01",
    value: 60,
    asOfDate: "2026-10-12",
    componentAsOfDates: ["2026-10-13", "2026-10-14", "2026-10-12"],
  }]);
});

test("calendar ranges survive chart changes and clamp without mutating the request", () => {
  const selected = { start: "2026-01-01", end: "2026-08-01" };
  const fullCoverage = Array.from({ length: 9 }, (_, index) => `2026-${String(index + 1).padStart(2, "0")}-01`);
  const narrowerCoverage = ["2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"];

  assert.deepEqual(resolveDateRange(fullCoverage, selected, "2023-01-01"), {
    fromIndex: 0,
    toIndex: 7,
    rangeStart: "2026-01-01",
    rangeEnd: "2026-08-01",
  });
  assert.deepEqual(resolveDateRange(narrowerCoverage, selected, "2023-01-01"), {
    fromIndex: 0,
    toIndex: 3,
    rangeStart: "2026-03-01",
    rangeEnd: "2026-06-01",
  });
  assert.deepEqual(selected, { start: "2026-01-01", end: "2026-08-01" });
  assert.equal(resolveDateRange(fullCoverage, selected, "2023-01-01").rangeStart, "2026-01-01");
});

test("unselected chart boundaries keep their own default start and follow latest", () => {
  const dates = ["2020-09-01", "2023-01-01", "2026-08-01", "2026-09-01"];
  assert.deepEqual(resolveDateRange(dates, { start: null, end: null }, "2023-01-01"), {
    fromIndex: 1,
    toIndex: 3,
    rangeStart: "2023-01-01",
    rangeEnd: "2026-09-01",
  });
});

test("percentage changes rebase to zero and leave USD/BTC values unchanged", () => {
  const points = [{ date: "2025-01-01", value: 1000, valueBtc: 0.01, share: 25 }, { date: "2025-02-01", value: 2000, valueBtc: null, share: 75 }];
  assert.deepEqual(displayPoints(points, "percent").map((point) => point.value), [0, 100]);
  assert.equal(displayPoints(points.slice(1), "percent")[0].value, 0);
  assert.deepEqual(displayPoints(points, "btc").map((point) => point.value), [0.01]);
  assert.deepEqual(displayPoints(points, "share").map((point) => point.value), [25, 75]);
  assert.equal(displayPoints(points, "absolute"), points);
  assert.deepEqual(points.map((point) => point.value), [1000, 2000]);
  assert.deepEqual(displayPoints([{ date: "2025-01-01", value: 0 }], "percent"), []);
  assert.deepEqual(displayPoints([], "percent"), []);
  const changes = [0, 100, 50, 200, 0].map((value, index) => ({ date: `2025-0${index + 1}-01`, value }));
  assert.deepEqual(displayPoints(changes, "percent").map((point) => point.value), [-100, 0, -50, 100, -100]);
  const snapshot = [{ date: "2026-09-01", value: 200, isSnapshot: true }];
  assert.deepEqual(displayPoints(snapshot, "percent"), [{ ...snapshot[0], value: 0 }]);
});

test("composition layer is classified, auditable and numerically coherent", () => {
  assert.ok(snapshot.composition);
  const venueIds = snapshot.composition.venues.map((venue) => venue.id);
  assert.deepEqual(venueIds, ["hyperliquid", "kalshi-perps", "kalshi-predictions", "polymarket"]);
  assert.ok(snapshot.composition.series.length > 100);
  assert.ok(snapshot.composition.series.some((item) => item.venue === "Hyperliquid" && item.dimension === "assetClass" && item.metric === "monthlyVolume" && item.group === "Pre-IPO / private"));
  assert.ok(snapshot.composition.series.some((item) => item.venue === "Kalshi Perps" && item.metric === "monthEndOi"));
  assert.ok(snapshot.composition.series.some((item) => item.venue === "Polymarket" && item.metric === "monthlyVolumeApprox"));

  const ids = snapshot.composition.series.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const shareSums = new Map();
  for (const item of snapshot.composition.series) {
    assert.ok(item.classificationSource);
    assert.ok(item.definition);
    assert.deepEqual(item.points.map((point) => point.date), [...item.points.map((point) => point.date)].sort());
    for (const point of item.points) {
      assert.ok(Number.isFinite(point.value) && point.value >= 0, `${item.id} has invalid value`);
      if (item.unit === "usd" && Number.isFinite(point.share)) {
        assert.ok(point.share >= 0 && point.share <= 100 + 1e-9);
        const key = [item.venue, item.dimension, item.metric, point.date].join("::");
        shareSums.set(key, (shareSums.get(key) ?? 0) + point.share);
      }
    }
  }
  assert.ok(shareSums.size > 100);
  for (const [key, sum] of shareSums) closeTo(sum, 100, key);
});

test("percentages use linear bounds normally and multiplicative scale for extreme ratios", () => {
  for (const values of [[], [0], [0, 0], [-100, 0], [0, 100], [-50, 0, 250]]) {
    assert.equal(shouldUseLogScale(values, "percent"), false);
    const [low, high] = percentBounds(values);
    assert.ok(low <= 0 && high >= 0 && high > low);
    assert.ok(values.every((value) => value >= low && value <= high));
  }
  assert.equal(shouldUseLogScale([0, 9_900], "percent"), true);
  assert.equal(shouldUseLogScale([-99, 0], "percent"), true);
  assert.equal(shouldUseLogScale([-100, 0, 1_000_000], "percent"), true);
  assert.equal(shouldUseLogScale([1, 1000], "absolute"), true);
  assert.equal(shouldUseLogScale([1, 1000], "btc"), true);
  assert.equal(shouldUseLogScale([1, 2], "absolute"), false);
  assert.equal(shouldUseLogScale([], "absolute"), false);
});

test("partial-month projection applies to volume flows only and preserves raw values", () => {
  const point = { date: "2026-09-01", asOfDate: "2026-09-08", value: 800, valueBtc: 8 };
  const options = { metric: "volume", generatedAt: "2026-09-09T12:00:00.000Z", completeThrough: "2026-08" };
  const projection = partialVolumeProjection(point, options);
  assert.equal(point.value, 800);
  assert.equal(projection.projectionCoveredDays, 8);
  assert.equal(projection.projectionDaysInMonth, 30);
  assert.equal(projection.projectionMultiplier, 3.75);
  assert.equal(projection.projectionValue, 3000);
  assert.equal(projection.projectionValueBtc, 30);
  assert.equal(projection.projectionCoverageBasis, "observed-source-date");

  const assumed = partialVolumeProjection({ date: "2026-09-01", value: 800 }, options);
  assert.equal(assumed.projectionCoverageEnd, "2026-09-08");
  assert.equal(assumed.projectionCoverageBasis, "assumed-through-prior-utc-day");
  assert.equal(partialVolumeProjection({ ...point, value: 0 }, options).projectionUnavailableReason, "current-source-bucket-not-published");
  assert.deepEqual(partialVolumeProjection(point, { ...options, metric: "oi" }), {});
  assert.deepEqual(partialVolumeProjection({ ...point, date: "2026-08-01" }, options), {});

  const leap = partialVolumeProjection(
    { date: "2024-02-01", asOfDate: "2024-02-10", value: 100 },
    { metric: "volume", generatedAt: "2024-02-11T12:00:00.000Z", completeThrough: "2024-01" },
  );
  assert.equal(leap.projectionDaysInMonth, 29);
  assert.equal(leap.projectionValue, 290);
});

test("refresh schedule follows Paris 08:00 and 16:00 across DST", () => {
  assert.equal(nextParisRefresh(new Date("2026-07-01T05:59:59.000Z")).toISOString(), "2026-07-01T06:00:00.000Z");
  assert.equal(nextParisRefresh(new Date("2026-07-01T06:00:00.000Z")).toISOString(), "2026-07-01T14:00:00.000Z");
  assert.equal(nextParisRefresh(new Date("2026-01-15T06:59:59.000Z")).toISOString(), "2026-01-15T07:00:00.000Z");
  assert.equal(nextParisRefresh(new Date("2026-01-15T07:00:00.000Z")).toISOString(), "2026-01-15T15:00:00.000Z");
  assert.equal(nextParisRefresh(new Date("2026-01-15T15:00:00.000Z")).toISOString(), "2026-01-16T07:00:00.000Z");
});

test("BTC uses the covered month mean for flows and the observed-date close for stocks", () => {
  const prices = [{ date: "2025-01-01", close: 10 }, { date: "2025-01-02", close: 20 }, { date: "2025-01-03", close: 30 }];
  const point = { date: "2025-01-01", asOfDate: "2025-01-02", value: 300 };
  assert.equal(btcEquivalent(point, "volume", prices).valueBtc, 20);
  assert.equal(btcEquivalent(point, "oi", prices).valueBtc, 15);
  assert.equal(btcEquivalent({ ...point, asOfDate: "2025-01-04" }, "oi", prices).btcPriceDate, "2025-01-03");
  assert.equal(btcEquivalent({ date: "2025-02-01", value: 300 }, "volume", prices).valueBtc, null);
  assert.deepEqual(btcEquivalent(point, "activeMarkets", prices), {});
});

test("CEX aggregates include Kraken, exclude Coinbase and preserve daily OI observation dates", async () => {
  const rawOi = await Promise.all(["bitcoinOi", "ethereumOi"].map(async (key) => JSON.parse(await readFile(new URL(`../data/raw/${key}.json`, import.meta.url), "utf8"))));
  const dailyMaps = rawOi.flatMap((raw) => ["Binance", "ByBit", "Kraken"].map((name) => new Map(raw.data.chart.jsonFile.Series[name].Data.map((row) => [new Date(row.Timestamp * 1000).toISOString().slice(0, 10), row.Result]))));
  for (const metric of ["volume", "oi"]) {
    for (const point of byId(`category-cex-${metric}`).points) {
      const components = ["binance", "bybit", "kraken"].map((name) => byId(`cex-${name}-${metric}`).points.find((row) => row.date === point.date));
      assert.ok(components.every(Boolean));
      if (metric === "oi") {
        // E.g. Dec 2024 Bybit ends Dec 30, while other venues have Dec 31.
        // The aggregate must align the underlying daily values, not mix dates.
        const commonDates = [...dailyMaps[0].keys()].filter((date) => date.startsWith(point.date.slice(0, 7)) && date <= snapshot.meta.generatedAt.slice(0, 10) && dailyMaps.every((map) => Number.isFinite(map.get(date)))).sort();
        assert.equal(point.asOfDate, commonDates.at(-1));
        closeTo(point.value, dailyMaps.reduce((sum, map) => sum + map.get(point.asOfDate), 0));
      } else {
        closeTo(point.value, components.reduce((sum, row) => sum + row.value, 0));
      }
    }
  }
});

test("prediction OI aggregate includes every available venue snapshot each month", () => {
  const aggregate = byId("category-prediction-oi");
  const components = ["prediction-polymarket-oi", "prediction-polymarket-us-oi", "prediction-kalshi-oi"].map(byId);
  for (const point of aggregate.points) {
    const observed = components.flatMap((series) => {
      const component = series.points.find((candidate) => candidate.date === point.date);
      return component ? [component] : [];
    });
    assert.ok(observed.length > 0, `no prediction OI components for ${point.date}`);
    closeTo(point.value, observed.reduce((sum, component) => sum + component.value, 0));
    assert.equal(point.asOfDate, observed.map((component) => component.asOfDate).sort()[0]);
  }
});

test("Coinbase volume excludes spot and OI uses collected snapshots without backfill", async () => {
  const raw = JSON.parse(await readFile(new URL("../data/raw/coinbaseVolume.json", import.meta.url), "utf8"));
  const sourceSeries = raw.data.chart.jsonFile.Series;
  assert.ok(Object.keys(sourceSeries).some((symbol) => !symbol.endsWith("-PERP")));
  const month = "2024-01";
  const expected = Object.entries(sourceSeries).filter(([symbol]) => symbol.endsWith("-PERP")).reduce((sum, [, item]) => sum + item.Data.filter((row) => new Date(row.Timestamp * 1000).toISOString().startsWith(month)).reduce((sum, row) => sum + row.Result, 0), 0);
  closeTo(byId("cex-coinbase-volume").points.find((point) => point.date.startsWith(month)).value, expected);
  assert.equal(byId("cex-coinbase-volume").points[0].date, "2023-06-01");
  assert.equal(byId("cex-coinbase-volume").points[0].isComplete, false);
  const oi = byId("cex-coinbase-oi");
  assert.ok(oi.points.length >= 1);
  assert.ok(oi.points.every((point) => point.isSnapshot === true));
  assert.deepEqual(oi.points.map((point) => point.date), [...oi.points.map((point) => point.date)].sort());
  const latestOi = oi.points.at(-1);
  assert.equal(latestOi.isComplete, false);
  const official = JSON.parse(await readFile(new URL("../data/raw/coinbaseInstruments.json", import.meta.url), "utf8"));
  const officialPerps = official.instruments.filter((item) => item.type === "PERP");
  const expectedOi = officialPerps.reduce((sum, item) => sum + Number(item.open_interest) * (Number(item.quote?.mark_price) || 0), 0);
  const validOfficialSnapshot = expectedOi > 0 && officialPerps.some((item) => Number(item.open_interest) > 0 && Number(item.quote?.mark_price) > 0);
  if (validOfficialSnapshot) {
    assert.equal(latestOi.asOfDate, snapshot.meta.generatedAt.slice(0, 10));
    closeTo(latestOi.value, expectedOi);
  } else {
    assert.ok(latestOi.value > 0);
    assert.ok(latestOi.asOfDate < snapshot.meta.generatedAt.slice(0, 10));
    assert.ok(snapshot.meta.warnings.some((warning) => warning.includes("Coinbase International") && warning.includes("rejected")));
  }
  const history = JSON.parse(await readFile(new URL("../data/normalized/coinbase-oi-history.json", import.meta.url), "utf8"));
  assert.ok(history.snapshots.length >= oi.points.length);
  assert.ok(history.snapshots.every((entry) => entry.value > 0));
  assert.ok(history.collectionStartedAt <= snapshot.meta.generatedAt);
});

test("published current-month volume carries transparent projections while OI never does", async () => {
  const currentMonth = snapshot.meta.generatedAt.slice(0, 7);
  for (const item of snapshot.series) {
    const current = item.points.find((point) => point.date.startsWith(currentMonth));
    if (!current) continue;
    if (item.metric === "volume") {
      if (current.value > 0) {
        assert.ok(current.projectionValue > 0, `missing projection ${item.id}`);
        assert.ok(current.projectionCoveredDays > 0, `missing coverage ${item.id}`);
      } else {
        assert.equal(current.projectionUnavailableReason, "current-source-bucket-not-published");
      }
    } else if (item.metric === "oi") {
      assert.equal(current.projectionValue, undefined, `OI projected ${item.id}`);
    }
  }
  const history = JSON.parse(await readFile(new URL("../data/normalized/partial-volume-history.json", import.meta.url), "utf8"));
  assert.equal(history.snapshots.at(-1).retrievedAt, snapshot.meta.generatedAt);
});

test("BTC equivalents are auditable and no future or incomplete daily candles enter prices", () => {
  const today = snapshot.meta.generatedAt.slice(0, 10);
  assert.ok(snapshot.btcPrices.dailyCloses.every((price) => price.date < today && price.close > 0));
  assert.equal(snapshot.btcPrices.dailyCloses.length, (Date.parse(today) - Date.parse(snapshot.btcPrices.start)) / 86400000, "missing completed BTC daily candles");
  for (const item of snapshot.series.filter((series) => ["volume", "oi"].includes(series.metric))) {
    for (const point of item.points) {
      assert.ok(point.date <= today);
      assert.ok(Number.isFinite(point.valueBtc), `missing BTC value ${item.id}/${point.date}`);
      closeTo(point.valueBtc, point.value / point.btcUsdPrice);
      if (item.metric === "oi") {
        assert.ok(point.asOfDate >= point.date);
        assert.ok(point.btcPriceDate <= point.asOfDate);
      }
    }
  }
});
