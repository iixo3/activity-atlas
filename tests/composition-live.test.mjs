import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHyperliquidLiveProvider,
  fetchPolymarketRecords,
  normalizeHyperliquidLiveSnapshot,
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

test("Hyperliquid live provider adds separate snapshots while retaining only compact historical dimensions", () => {
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
  assert.ok(october.series.filter((item) => item.dimension === "instrument").every((item) => item.points.length === 1));
  assert.ok(october.series.filter((item) => ["volume24h", "oiSnapshot"].includes(item.metric)).every((item) => item.quality === "proxy"));
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
