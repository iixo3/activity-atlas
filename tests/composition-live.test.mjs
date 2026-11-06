import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compositionComparison } from "../lib/activity-insights.mjs";
import {
  buildHyperliquidLiveProvider,
  fetchPolymarketRecords,
  normalizeHyperliquidLiveSnapshot,
  restoreInstrumentSnapshot,
  retainSnapshotHistory,
} from "../scripts/composition-data.mjs";

function hyperliquidFixture() {
  return {
    perpDexs: [null, { name: "xyz", fullName: "XYZ" }, { name: "io", fullName: "EntropyIO" }],
    annotations: [
      ["xyz:TSLA", { category: "stocks" }],
      ["xyz:OPENAI", { category: "preipo", displayName: "OPENAI" }],
    ],
    dexPayloads: [
      {
        dex: "",
        payload: [
          { universe: [{ name: "BTC" }] },
          [{ dayNtlVlm: "100", openInterest: "2", markPx: "50" }],
        ],
      },
      {
        dex: "xyz",
        payload: [
          { collateralToken: 7, universe: [{ name: "xyz:TSLA" }, { name: "xyz:OPENAI" }] },
          [
            { dayNtlVlm: "80", openInterest: "3", markPx: "20" },
            { dayNtlVlm: "20", openInterest: "4", markPx: "10" },
          ],
        ],
      },
      {
        dex: "io",
        payload: [
          { collateralToken: 12, universe: [{ name: "io:EWY" }] },
          [{ dayNtlVlm: "10", openInterest: "1", markPx: "30" }],
        ],
      },
    ],
  };
}

test("Hyperliquid official snapshot validates complete venue coverage and classifies annotations", () => {
  const records = normalizeHyperliquidLiveSnapshot(hyperliquidFixture());
  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map(({ instrument, assetClass, operator, collateralToken }) => ({ instrument, assetClass, operator, collateralToken })),
    [
      { instrument: "BTC", assetClass: "Crypto", operator: "Hyperliquid Core", collateralToken: null },
      { instrument: "TSLA", assetClass: "Public equities", operator: "trade.xyz", collateralToken: 7 },
      { instrument: "OPENAI", assetClass: "Pre-IPO / private", operator: "trade.xyz", collateralToken: 7 },
      { instrument: "EWY", assetClass: "Unclassified", operator: "Entropy", collateralToken: 12 },
    ],
  );
  assert.equal(records.find((record) => record.instrument === "TSLA").oi, 60);
  assert.throws(
    () => normalizeHyperliquidLiveSnapshot({ ...hyperliquidFixture(), dexPayloads: hyperliquidFixture().dexPayloads.slice(0, 2) }),
    /did not cover every reported perp DEX/,
  );
});

test("Hyperliquid live provider keeps earlier snapshots in every dimension, paired by collection", () => {
  const records = normalizeHyperliquidLiveSnapshot(hyperliquidFixture());
  const september = buildHyperliquidLiveProvider({
    records,
    date: "2026-09-20",
    collectedAt: "2026-09-20T08:00:00.000Z",
  });
  const october = buildHyperliquidLiveProvider({
    records,
    date: "2026-10-22",
    collectedAt: "2026-10-22T08:00:00.000Z",
    previous: september,
  });
  const cryptoVolume = october.series.find((item) => item.dimension === "assetClass" && item.metric === "volume24h" && item.group === "Crypto");
  assert.deepEqual(cryptoVolume.points.map((point) => point.date), ["2026-09-01", "2026-10-01"]);
  assert.equal(cryptoVolume.points.at(-1).value, 100);
  assert.deepEqual(cryptoVolume.points.at(-1).collateralTokenIds, [null]);
  assert.ok(october.series.some((item) => item.dimension === "operator" && item.group === "trade.xyz" && item.metric === "oiSnapshot"));
  assert.ok(october.series.some((item) => item.metric === "turnover24h"));
  assert.ok(october.series.filter((item) => item.dimension === "instrument").every((item) => item.points.length === 2));
  assert.ok(october.series.filter((item) => ["volume24h", "oiSnapshot"].includes(item.metric)).every((item) => item.quality === "proxy"));
  const septemberCohort = compositionComparison(october.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-09-01");
  assert.equal(septemberCohort.reason, null);
  assert.equal(septemberCohort.observedAt, "2026-09-20T08:00:00.000Z");
  assert.equal(septemberCohort.volumeTotal, 210);
});

function liveRecords(rows) {
  return rows.map(([instrument, volume24h, oi]) => ({ assetClass: "Crypto", operator: "Hyperliquid Core", instrument, market: instrument, dex: "", collateralToken: null, volume24h, oi, score: volume24h + oi }));
}

test("top-10 reshuffles and disappearing groups keep each month's cohort intact and unmixed", () => {
  const octoberRows = Array.from({ length: 12 }, (_, index) => [`A${index}`, 120 - index, 60 - index]);
  const november = Array.from({ length: 12 }, (_, index) => [`B${index}`, 300 - index, 200 - index]);
  const octoberFirst = buildHyperliquidLiveProvider({ records: liveRecords(octoberRows.slice(0, 11)), date: "2026-10-10", collectedAt: "2026-10-10T08:00:00.000Z" });
  const octoberLatest = buildHyperliquidLiveProvider({ records: liveRecords(octoberRows), date: "2026-10-31", collectedAt: "2026-10-31T15:00:00.000Z", previous: octoberFirst });
  const next = buildHyperliquidLiveProvider({ records: liveRecords(november), date: "2026-11-01", collectedAt: "2026-11-01T07:00:00.000Z", previous: octoberLatest });

  const oct = compositionComparison(next.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-10-01");
  assert.equal(oct.reason, null);
  assert.equal(oct.observedAt, "2026-10-31T15:00:00.000Z");
  assert.deepEqual(oct.rows.map((row) => row.group).sort(), [...octoberRows.slice(0, 10).map(([name]) => name), "Other markets"].sort());
  assert.equal(oct.volumeTotal, octoberRows.reduce((sum, [, volume]) => sum + volume, 0));
  assert.equal(oct.oiTotal, octoberRows.reduce((sum, [, , oi]) => sum + oi, 0));
  assert.ok(Math.abs(oct.rows.reduce((sum, row) => sum + row.volumeShare, 0) - 100) < 1e-9);

  const nov = compositionComparison(next.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-11-01");
  assert.equal(nov.observedAt, "2026-11-01T07:00:00.000Z");
  assert.ok(nov.rows.every((row) => row.group.startsWith("B") || row.group === "Other markets"));
  // A group only in October keeps exactly its October point.
  const onlyOctober = next.series.find((item) => item.dimension === "instrument" && item.metric === "volume24h" && item.group === "A0");
  assert.deepEqual(onlyOctober.points.map((point) => point.collectedAt), ["2026-10-31T15:00:00.000Z"]);
  // Re-collecting within a month replaces that month; a vanished group leaves no stale slice.
  const again = buildHyperliquidLiveProvider({ records: liveRecords(november.slice(1)), date: "2026-11-02", collectedAt: "2026-11-02T07:00:00.000Z", previous: next });
  assert.equal(again.series.some((item) => item.group === "B0" && item.points.some((point) => point.date === "2026-11-01")), false);
  assert.equal(compositionComparison(again.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-11-01").observedAt, "2026-11-02T07:00:00.000Z");
});

test("retention drops a stale slice from another collection and leaves non-snapshot history alone", () => {
  const point = (date, collectedAt, value) => ({ date, asOfDate: collectedAt.slice(0, 10), collectedAt, isSnapshot: true, isComplete: false, value });
  const series = (id, group, metric, unit, points) => ({ id, venue: "Demo", dimension: "instrument", group, metric, unit, points });
  const previous = [
    series("fresh", "Fresh", "volume24h", "usd", [point("2026-10-01", "2026-10-31T00:00:00Z", 5)]),
    series("stale", "Stale", "volume24h", "usd", [point("2026-10-01", "2026-10-02T00:00:00Z", 9)]),
    { ...series("turnover-fresh", "Fresh", "turnover24h", "multiple", [{ date: "2026-10-01", asOfDate: "2026-10-31", value: 1 }]) },
    { ...series("turnover-stale", "Stale", "turnover24h", "multiple", [{ date: "2026-10-01", asOfDate: "2026-10-02", value: 2 }]) },
    { ...series("approx", "History", "monthlyVolumeApprox", "usd", [{ date: "2026-10-01", value: 3, isComplete: true }]) },
  ];
  const ids = retainSnapshotHistory([], previous, "2026-11-01").map((item) => item.id).sort();
  assert.deepEqual(ids, ["approx", "fresh", "turnover-fresh"]);
});

function restoreFixture() {
  const collectedAt = "2026-10-31T15:52:06.894Z";
  const at = (value, when = collectedAt) => ({ date: "2026-10-01", asOfDate: when.slice(0, 10), collectedAt: when, isSnapshot: true, isComplete: false, value });
  const make = (dimension, group, metric, point, unit = "usd") => ({ id: `${dimension}-${metric}-${group}`, venue: "Hyperliquid", dimension, group, metric, unit, points: [point] });
  return {
    make, at, collectedAt,
    target: [make("assetClass", "Crypto", "volume24h", at(100)), make("assetClass", "Crypto", "oiSnapshot", at(50))],
    source: [
      make("instrument", "BTC", "volume24h", at(70)), make("instrument", "Other markets", "volume24h", at(30)),
      make("instrument", "BTC", "oiSnapshot", at(40)), make("instrument", "Other markets", "oiSnapshot", at(10)),
      make("instrument", "BTC", "turnover24h", { date: "2026-10-01", asOfDate: "2026-10-31", value: 1.75 }, "multiple"),
    ],
  };
}
const restoreOptions = { month: "2026-10", aggregateDimension: "assetClass", valueMetrics: ["volume24h", "oiSnapshot"] };

test("recovered instrument snapshots keep their timestamps, tie to the cohort and are idempotent", () => {
  const { target, source, collectedAt } = restoreFixture();
  const first = restoreInstrumentSnapshot({ target, source, ...restoreOptions });
  assert.equal(first.changed, true);
  assert.equal(first.restored.length, 4);
  const cohort = compositionComparison(first.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-10-01");
  assert.equal(cohort.observedAt, collectedAt);
  assert.equal(cohort.volumeTotal, 100);
  assert.equal(cohort.oiTotal, 50);
  const second = restoreInstrumentSnapshot({ target: first.series, source, ...restoreOptions });
  assert.equal(second.changed, false);
  assert.equal(second.series, first.series);
});

test("recovery refuses a snapshot from another collection or one that does not sum to its cohort", () => {
  const { make, at, target, source } = restoreFixture();
  const otherCollection = target.map((item) => ({ ...item, points: [at(item.points[0].value, "2026-10-30T10:00:00.000Z")] }));
  assert.throws(() => restoreInstrumentSnapshot({ target: otherCollection, source, ...restoreOptions }), /cohort matches/);
  const wrongSum = [...source, make("instrument", "Extra", "volume24h", at(5))];
  assert.throws(() => restoreInstrumentSnapshot({ target, source: wrongSum, ...restoreOptions }), /does not sum/);
  const mixed = source.map((item) => item.group === "BTC" && item.metric === "volume24h" ? { ...item, points: [at(70, "2026-10-30T10:00:00.000Z")] } : item);
  assert.throws(() => restoreInstrumentSnapshot({ target, source: mixed, ...restoreOptions }), /single 2026-10 instrument collection/);
  const held = [...target, make("instrument", "ETH", "volume24h", at(1, "2026-10-30T10:00:00.000Z"))];
  assert.throws(() => restoreInstrumentSnapshot({ target: held, source, ...restoreOptions }), /different 2026-10/);
});

test("the persisted October individual-asset snapshot survives a simulated next refresh", async () => {
  const cache = JSON.parse(await readFile(new URL("../data/normalized/composition-cache.json", import.meta.url), "utf8"));
  const archive = JSON.parse(await readFile(new URL("../data/normalized/composition-observations.json", import.meta.url), "utf8"));
  const previous = cache.providers.hyperliquidLive;
  const before = compositionComparison(previous.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-10-01");
  assert.equal(before.reason, null);
  assert.equal(before.observedAt, "2026-10-31T15:52:06.894Z");
  assert.equal(before.rows.length, 11);
  const aggregate = compositionComparison(previous.series, "Hyperliquid", "assetClass", "volume24h", "oiSnapshot", "2026-10-01");
  assert.equal(aggregate.observedAt, before.observedAt);
  assert.ok(Math.abs(before.volumeTotal - aggregate.volumeTotal) <= aggregate.volumeTotal * 1e-9);
  assert.ok(Math.abs(before.oiTotal - aggregate.oiTotal) <= aggregate.oiTotal * 1e-9);

  const published = JSON.parse(await readFile(new URL("../public/data/activity-data.json", import.meta.url), "utf8"));
  const display = compositionComparison(published.composition.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-10-01");
  assert.ok(Math.abs(display.oiTotal - before.oiTotal / 2) <= before.oiTotal * 1e-9, "published OI counts each contract once");
  assert.equal(display.volumeTotal, before.volumeTotal);

  const records = liveRecords([["NEW", 10, 5], ["BTC", 20, 8]]);
  const refreshed = buildHyperliquidLiveProvider({ records, date: "2026-12-01", collectedAt: "2026-12-01T07:00:00.000Z", previous });
  const after = compositionComparison(refreshed.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-10-01");
  assert.equal(after.observedAt, before.observedAt);
  assert.deepEqual(after.rows, before.rows);
  assert.equal(compositionComparison(refreshed.series, "Hyperliquid", "instrument", "volume24h", "oiSnapshot", "2026-12-01").observedAt, "2026-12-01T07:00:00.000Z");

  for (const metric of ["volume24h", "oiSnapshot"]) {
    const rows = archive.observations.filter((row) => row.venue === "Hyperliquid" && row.dimension === "instrument" && row.metric === metric && row.collectedAt === before.observedAt);
    assert.equal(rows.length, 11, `archive lacks ${metric}`);
  }
});

test("Polymarket keyset pagination deduplicates and filters events locally", async () => {
  const urls = [];
  const pages = [
    {
      events: [
        { id: "1", active: true, closed: false, title: "First", volume1mo: "10", openInterest: "4" },
        { id: "x", active: false, closed: false, title: "Inactive", volume1mo: "999", openInterest: "999" },
      ],
      next_cursor: "cursor-1",
    },
    {
      events: [
        { id: "1", active: true, closed: false, title: "First updated", volume1mo: "11", openInterest: "5" },
        { id: "2", active: "true", closed: "false", title: "Second", volume1mo: "7", openInterest: "3" },
      ],
      next_cursor: "",
    },
  ];
  const records = await fetchPolymarketRecords(async (url) => {
    urls.push(String(url));
    return pages.shift();
  });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.instrument), ["First updated", "Second"]);
  assert.match(urls[0], /events\/keyset\?limit=100/);
  assert.match(urls[1], /after_cursor=cursor-1/);
});

test("Polymarket keyset pagination rejects a repeated cursor", async () => {
  await assert.rejects(
    fetchPolymarketRecords(async () => ({
      events: [{ id: "1", active: true, closed: false, title: "First" }],
      next_cursor: "same",
    })),
    /repeated a cursor/,
  );
});
