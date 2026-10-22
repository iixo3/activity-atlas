import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { btcEquivalent, partialVolumeProjection, sumMonthlySnapshots } from "../lib/activity-math.mjs";
import { buildCompositionData } from "./composition-data.mjs";

const ROOT = process.cwd();
const RAW_DIR = path.join(ROOT, "data", "raw");
const NORMALIZED_DIR = path.join(ROOT, "data", "normalized");
const PUBLIC_DIR = path.join(ROOT, "public", "data");
const COINBASE_OI_HISTORY = path.join(NORMALIZED_DIR, "coinbase-oi-history.json");
const PARTIAL_VOLUME_HISTORY = path.join(NORMALIZED_DIR, "partial-volume-history.json");
const REFRESH_LOCK = path.join(NORMALIZED_DIR, ".refresh.lock");

const SOURCE_DEFS = {
  cexVolume: {
    api: "https://www.theblock.co/api/tbco/charts/chart/crypto-markets/futures/total-futures-volumes",
    page: "https://www.theblock.co/data/crypto-markets/futures/total-futures-volumes",
  },
  binancePerpVolume: {
    api: "https://www.theblock.co/api/tbco/charts/chart/decentralized-finance/derivatives/hyperliquid-vs-binance-monthly-perpetual-volumes",
    page: "https://www.theblock.co/data/decentralized-finance/derivatives/hyperliquid-vs-binance-monthly-perpetual-volumes",
  },
  coinbaseVolume: {
    api: "https://www.theblock.co/api/tbco/charts/chart/crypto-markets/futures/coinbase-international-daily-volume",
    page: "https://www.theblock.co/data/crypto-markets/futures/coinbase-international-daily-volume",
  },
  bitcoinOi: {
    api: "https://www.theblock.co/api/tbco/charts/chart/crypto-markets/futures/aggregated-open-interest-of-bitcoin-futures-daily",
    page: "https://www.theblock.co/data/crypto-markets/futures/aggregated-open-interest-of-bitcoin-futures-daily",
  },
  ethereumOi: {
    api: "https://www.theblock.co/api/tbco/charts/chart/crypto-markets/futures/aggregated-open-interest-of-ethereum-futures-daily",
    page: "https://www.theblock.co/data/crypto-markets/futures/aggregated-open-interest-of-ethereum-futures-daily",
  },
  dexVolume: {
    api: "https://www.theblock.co/api/tbco/charts/chart/decentralized-finance/derivatives/perpetual-protocol-trade-volume",
    page: "https://www.theblock.co/data/decentralized-finance/derivatives/perpetual-protocol-trade-volume",
  },
  hyperliquidOi: {
    api: "https://www.theblock.co/api/tbco/charts/chart/decentralized-finance/derivatives/hyperliquid-open-interest",
    page: "https://www.theblock.co/data/decentralized-finance/derivatives/hyperliquid-open-interest",
  },
  predictionVolume: {
    api: "https://www.theblock.co/api/tbco/charts/chart/decentralized-finance/prediction-markets/polymarket-and-kalshi-volume-monthly",
    page: "https://www.theblock.co/data/decentralized-finance/prediction-markets/polymarket-and-kalshi-volume-monthly",
  },
  predictionOi: {
    api: "https://www.theblock.co/api/tbco/charts/chart/decentralized-finance/prediction-markets/polymarket-and-kalshi-open-interest-daily",
    page: "https://www.theblock.co/data/decentralized-finance/prediction-markets/polymarket-and-kalshi-open-interest-daily",
  },
  polymarketTraders: {
    api: "https://www.theblock.co/api/tbco/charts/chart/decentralized-finance/prediction-markets/polymarket-active-traders-monthly",
    page: "https://www.theblock.co/data/decentralized-finance/prediction-markets/polymarket-active-traders-monthly",
  },
  polymarketMarkets: {
    api: "https://www.theblock.co/api/tbco/charts/chart/decentralized-finance/prediction-markets/polymarket-new-markets-monthly",
    page: "https://www.theblock.co/data/decentralized-finance/prediction-markets/polymarket-new-markets-monthly",
  },
  kalshiActiveMarkets: {
    api: "https://www.theblock.co/api/tbco/charts/chart/decentralized-finance/prediction-markets/kalshi-daily-active-markets",
    page: "https://www.theblock.co/data/decentralized-finance/prediction-markets/kalshi-daily-active-markets",
  },
};

const isoDate = (timestamp) =>
  new Date(timestamp * 1000).toISOString().slice(0, 10);

const monthKey = (date) => date.slice(0, 7);
const generatedAt = new Date().toISOString();
const today = generatedAt.slice(0, 10);

async function writeAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, value);
  await rename(temporaryPath, filePath);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function acquireRefreshLock() {
  try {
    const handle = await open(REFRESH_LOCK, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: generatedAt })}\n`);
    return handle;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const lockAge = Date.now() - (await stat(REFRESH_LOCK)).mtimeMs;
    if (lockAge <= 15 * 60_000) throw new Error("Another Activity Atlas refresh is already running");
    await unlink(REFRESH_LOCK);
    const handle = await open(REFRESH_LOCK, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: generatedAt, replacedStaleLock: true })}\n`);
    return handle;
  }
}

function chartSeries(payload) {
  const chart = payload?.data?.chart;
  if (!payload?.ok || !chart?.jsonFile?.Series) {
    throw new Error(`Invalid chart payload for ${chart?.title ?? "unknown chart"}`);
  }
  return chart.jsonFile.Series;
}

function points(series) {
  return (series?.Data ?? [])
    .filter((row) => Number.isFinite(row.Result))
    .map((row) => ({ date: isoDate(row.Timestamp), value: row.Result }))
    .filter((row) => row.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function filterFrom(values, start = "2023-01-01") {
  return values.filter((row) => row.date >= start);
}

function trimLeadingZeros(values) {
  const firstObserved = values.findIndex((row) => row.value > 0);
  return firstObserved < 0 ? [] : values.slice(firstObserved);
}

function sumAligned(seriesList, { requireAll = false } = {}) {
  const maps = seriesList.map(
    (series) => new Map(series.map((row) => [row.date, row.value])),
  );
  const dates = [...new Set(seriesList.flatMap((series) => series.map((row) => row.date)))].sort();
  return dates.flatMap((date) => {
    const values = maps.map((map) => map.get(date));
    if (requireAll && values.some((value) => value == null)) return [];
    return [{ date, value: values.reduce((sum, value) => sum + (value ?? 0), 0) }];
  });
}

function endOfMonth(values) {
  const byMonth = new Map();
  for (const row of values) byMonth.set(monthKey(row.date), row);
  return [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function toMonthStart(values) {
  return values.map((row) => ({ ...row, date: `${monthKey(row.date)}-01`, asOfDate: row.date }));
}

function monthlyVolume(daily) {
  const months = new Map();
  for (const row of daily) {
    const month = monthKey(row.date);
    const bucket = months.get(month) ?? { date: `${month}-01`, value: 0, days: new Set(), asOfDate: row.date };
    bucket.value += row.value;
    bucket.days.add(row.date);
    bucket.asOfDate = row.date;
    months.set(month, bucket);
  }
  return [...months.values()].map(({ days, ...row }) => {
    const [year, month] = row.date.split("-").map(Number);
    return { ...row, isComplete: days.size === new Date(Date.UTC(year, month, 0)).getUTCDate() };
  });
}

function previousMonthKey(now = new Date()) {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return previous.toISOString().slice(0, 7);
}

function cumulative(values, throughMonth = null) {
  return values
    .filter((row) => !throughMonth || monthKey(row.date) <= throughMonth)
    .reduce((sum, row) => sum + row.value, 0);
}

function adjacentMonth(previous, current) {
  const [prevYear, prevMonth] = previous.split("-").map(Number);
  const [year, month] = current.split("-").map(Number);
  return year * 12 + month - (prevYear * 12 + prevMonth) === 1;
}

function logChanges(values, { start, completeThrough }) {
  const monthly = new Map(values.map((row) => [monthKey(row.date), row.value]));
  const months = [...monthly.keys()]
    .filter((month) => month >= start && month <= completeThrough)
    .sort();
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

function pairCorrelation(left, right, options) {
  const leftChanges = new Map(logChanges(left, options).map((row) => [row.date, row.value]));
  const rightChanges = new Map(logChanges(right, options).map((row) => [row.date, row.value]));
  const dates = [...leftChanges.keys()].filter((date) => rightChanges.has(date)).sort();
  const leftValues = dates.map((date) => leftChanges.get(date));
  const rightValues = dates.map((date) => rightChanges.get(date));
  return {
    pearson: pearson(leftValues, rightValues),
    spearman: pearson(ranks(leftValues), ranks(rightValues)),
    observations: dates.length,
    start: dates[0] ?? null,
    end: dates.at(-1) ?? null,
  };
}

function csvEscape(value) {
  const string = String(value ?? "");
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function toCsv(series) {
  const rows = [["series_id", "category", "venue", "metric", "date", "value", "currency", "is_complete", "quality", "source_key", "definition", "as_of_date", "is_snapshot", "collected_at", "value_btc", "btc_usd_price", "btc_price_date", "btc_price_method", "projection_value", "projection_value_btc", "projection_covered_days", "projection_days_in_month", "projection_multiplier", "projection_coverage_end", "projection_coverage_basis", "projection_unavailable_reason"]];
  for (const item of series) {
    for (const point of item.points) {
      rows.push([
        item.id,
        item.category,
        item.venue,
        item.metric,
        point.date,
        point.value,
        ["volume", "oi"].includes(item.metric) ? "USD" : "count",
        point.isComplete,
        item.quality,
        item.sourceKey,
        item.definition,
        point.asOfDate,
        point.isSnapshot ?? false,
        point.collectedAt,
        point.valueBtc,
        point.btcUsdPrice,
        point.btcPriceDate,
        point.btcPriceMethod,
        point.projectionValue,
        point.projectionValueBtc,
        point.projectionCoveredDays,
        point.projectionDaysInMonth,
        point.projectionMultiplier,
        point.projectionCoverageEnd,
        point.projectionCoverageBasis,
        point.projectionUnavailableReason,
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "ActivityAtlas/1.0 research dashboard" },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function fetchBtcDailyCloses(start) {
  const rows = new Map();
  const dayMs = 86400000;
  const end = Date.parse(`${today}T00:00:00Z`);
  // Coinbase caps each response at 300 candles. Filter inclusive API bounds,
  // de-duplicate, and never use today's incomplete candle as a daily close.
  for (let cursor = Date.parse(`${start}T00:00:00Z`); cursor < end; cursor += 299 * dayMs) {
    const until = Math.min(cursor + 299 * dayMs, end);
    const url = new URL("https://api.exchange.coinbase.com/products/BTC-USD/candles");
    url.search = new URLSearchParams({ granularity: "86400", start: new Date(cursor).toISOString(), end: new Date(until).toISOString() });
    const candles = await fetchJson(url);
    if (!Array.isArray(candles)) throw new Error("Invalid BTC/USD candles response");
    for (const [timestamp, , , , close] of candles) {
      if (timestamp * 1000 >= cursor && timestamp * 1000 < until && Number.isFinite(close) && close > 0) {
        rows.set(isoDate(timestamp), { date: isoDate(timestamp), close });
      }
    }
  }
  if (!rows.size) throw new Error("No BTC/USD prices found");
  return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date));
}

await Promise.all([RAW_DIR, NORMALIZED_DIR, PUBLIC_DIR].map((directory) => mkdir(directory, { recursive: true })));
const refreshLock = await acquireRefreshLock();

try {

const fetched = Object.fromEntries(
  await Promise.all(
    Object.entries(SOURCE_DEFS).map(async ([key, source]) => {
      const payload = await fetchJson(source.api);
      await writeAtomic(path.join(RAW_DIR, `${key}.json`), `${JSON.stringify(payload, null, 2)}\n`);
      return [key, payload];
    }),
  ),
);

const completeThrough = previousMonthKey();
const coinbaseOiApi = "https://api.international.coinbase.com/api/v1/instruments";
const [btcDailyPrices, coinbaseInstruments] = await Promise.all([
  fetchBtcDailyCloses("2020-09-01"),
  fetchJson(coinbaseOiApi),
]);
await writeAtomic(path.join(RAW_DIR, "btcUsdDaily.json"), `${JSON.stringify({ retrievedAt: generatedAt, prices: btcDailyPrices }, null, 2)}\n`);
await writeAtomic(path.join(RAW_DIR, "coinbaseInstruments.json"), `${JSON.stringify({ retrievedAt: generatedAt, instruments: coinbaseInstruments }, null, 2)}\n`);

const cexVolumeSeries = chartSeries(fetched.cexVolume);
const binancePerpSeries = chartSeries(fetched.binancePerpVolume);
const btcOiSeries = chartSeries(fetched.bitcoinOi);
const ethOiSeries = chartSeries(fetched.ethereumOi);
const dexVolumeSeries = chartSeries(fetched.dexVolume);
const hyperliquidOiSeries = chartSeries(fetched.hyperliquidOi);
const predictionVolumeSeries = chartSeries(fetched.predictionVolume);
const predictionOiSeries = chartSeries(fetched.predictionOi);

const binanceVolume = filterFrom(points(binancePerpSeries["Binance Volume"]));
const bybitVolume = filterFrom(points(cexVolumeSeries.ByBit));
const krakenVolume = filterFrom(points(cexVolumeSeries.Kraken));
const cexVolume = sumAligned([binanceVolume, bybitVolume, krakenVolume], { requireAll: true });
const coinbasePerpEntries = Object.entries(chartSeries(fetched.coinbaseVolume)).filter(([symbol]) => symbol.endsWith("-PERP"));
if (!coinbasePerpEntries.length) throw new Error("No Coinbase PERP series found");
const coinbaseDaily = sumAligned(coinbasePerpEntries.map(([, series]) => points(series))).filter((row) => row.date < today);
const lastCoinbaseActivity = coinbaseDaily.findLast((row) => row.value > 0)?.date;
const coinbaseVolume = monthlyVolume(coinbaseDaily.filter((row) => row.date <= lastCoinbaseActivity));
const coinbasePerps = coinbaseInstruments.filter((instrument) => instrument.type === "PERP");
if (!coinbasePerps.length) throw new Error("No Coinbase perpetual instruments found");
const coinbaseOiValue = coinbasePerps.reduce((sum, instrument) => {
  const quantity = Number(instrument.open_interest);
  const markPrice = Number(instrument.quote?.mark_price);
  if (!Number.isFinite(quantity) || quantity < 0 || (quantity > 0 && (!Number.isFinite(markPrice) || markPrice <= 0))) {
    throw new Error(`Invalid Coinbase OI for ${instrument.symbol}`);
  }
  return sum + (quantity === 0 ? 0 : quantity * markPrice);
}, 0);
const coinbaseOiSnapshotAccepted = coinbaseOiValue > 0 && coinbasePerps.some((instrument) => (
  Number(instrument.open_interest) > 0 && Number(instrument.quote?.mark_price) > 0
));
const existingCoinbaseHistory = await readJsonIfExists(COINBASE_OI_HISTORY);
const previousSnapshot = await readJsonIfExists(path.join(PUBLIC_DIR, "activity-data.json"));
const seededSnapshots = Array.isArray(existingCoinbaseHistory?.snapshots)
  ? existingCoinbaseHistory.snapshots
  : (previousSnapshot?.series?.find((item) => item.id === "cex-coinbase-oi")?.points ?? []).map((point) => ({
      retrievedAt: point.collectedAt ?? previousSnapshot.meta?.generatedAt ?? `${point.asOfDate}T23:59:59.000Z`,
      asOfDate: point.asOfDate,
      value: point.value,
      instrumentCount: null,
    }));
// Zero all-PERP OI with no priced open contract is an invalid/redacted API
// response, not evidence that every Coinbase perpetual position disappeared.
const coinbaseOiSnapshots = [
  ...seededSnapshots.filter((snapshot) => Number.isFinite(snapshot?.value) && snapshot.value > 0),
  ...(coinbaseOiSnapshotAccepted ? [{
    retrievedAt: generatedAt,
    asOfDate: today,
    value: coinbaseOiValue,
    instrumentCount: coinbasePerps.length,
  }] : []),
]
  .filter((snapshot) => snapshot?.retrievedAt && snapshot?.asOfDate)
  .filter((snapshot, index, snapshots) => snapshots.findIndex((candidate) => candidate.retrievedAt === snapshot.retrievedAt) === index)
  .sort((left, right) => left.retrievedAt.localeCompare(right.retrievedAt));
if (!coinbaseOiSnapshots.length) throw new Error("Coinbase returned no valid OI snapshot and no prior valid snapshot exists");
const latestCoinbaseOiByMonth = new Map();
for (const snapshot of coinbaseOiSnapshots) latestCoinbaseOiByMonth.set(monthKey(snapshot.asOfDate), snapshot);
const coinbaseOiCollectionStartedAt = coinbaseOiSnapshots[0]?.retrievedAt ?? generatedAt;
const latestCoinbaseOiSnapshot = coinbaseOiSnapshots.at(-1);
const coinbaseOi = [...latestCoinbaseOiByMonth.entries()].map(([month, snapshot]) => {
  const [year, monthNumber] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return {
    date: `${month}-01`,
    asOfDate: snapshot.asOfDate,
    collectedAt: snapshot.retrievedAt,
    value: snapshot.value,
    isSnapshot: true,
    isComplete: month <= completeThrough && snapshot.asOfDate === monthEnd,
  };
});
await writeAtomic(COINBASE_OI_HISTORY, `${JSON.stringify({
  description: "Coinbase International all-PERP OI snapshots collected by Activity Atlas; USD/USDC notional at retrieval time.",
  collectionStartedAt: coinbaseOiCollectionStartedAt,
  snapshots: coinbaseOiSnapshots,
}, null, 2)}\n`);

const binanceOiDaily = sumAligned(
  [points(btcOiSeries.Binance), points(ethOiSeries.Binance)],
  { requireAll: true },
);
const bybitOiDaily = sumAligned(
  [points(btcOiSeries.ByBit), points(ethOiSeries.ByBit)],
  { requireAll: true },
);
const krakenOiDaily = sumAligned(
  [points(btcOiSeries.Kraken), points(ethOiSeries.Kraken)],
  { requireAll: true },
);
const binanceOi = toMonthStart(endOfMonth(filterFrom(binanceOiDaily)));
const bybitOi = toMonthStart(endOfMonth(filterFrom(bybitOiDaily)));
const krakenOi = toMonthStart(endOfMonth(filterFrom(krakenOiDaily)));
const cexOi = toMonthStart(endOfMonth(filterFrom(sumAligned([binanceOiDaily, bybitOiDaily, krakenOiDaily], { requireAll: true }))));

const dexVenueEntries = Object.entries(dexVolumeSeries).map(([name, series]) => ({
  name,
  points: filterFrom(points(series)),
}));
const dexRanking = dexVenueEntries
  .map((entry) => ({
    name: entry.name,
    // Rank on observed values, including raw current MTD. This keeps a new
    // high-activity venue visible in the drilldown that explains category totals.
    // Projections are display-only and never enter this sum.
    cumulativeVolume: cumulative(entry.points),
    completeCumulativeVolume: cumulative(entry.points, completeThrough),
    includesIncompleteMonth: entry.points.some((row) => monthKey(row.date) > completeThrough && row.value > 0),
    coverageStart: entry.points.find((row) => row.value > 0)?.date ?? entry.points[0]?.date ?? null,
    coveredMonths: entry.points.filter((row) => monthKey(row.date) <= completeThrough && row.value > 0).length,
  }))
  .sort((left, right) => right.cumulativeVolume - left.cumulativeVolume);
const dexTopTen = dexRanking.slice(0, 10).map((entry) => entry.name);
const dexVolume = sumAligned(dexVenueEntries.map((entry) => entry.points));
const dexOi = toMonthStart(endOfMonth(filterFrom(points(hyperliquidOiSeries.Total))));

const polymarketVolumeRaw = points(predictionVolumeSeries.Polymarket);
const polymarketUsVolumeRaw = points(predictionVolumeSeries["Polymarket US"]);
const kalshiVolumeRaw = points(predictionVolumeSeries.Kalshi);
const predictionVolume = filterFrom(
  sumAligned([polymarketVolumeRaw, polymarketUsVolumeRaw, kalshiVolumeRaw]),
);
const polymarketVolume = trimLeadingZeros(polymarketVolumeRaw);
const polymarketUsVolume = trimLeadingZeros(polymarketUsVolumeRaw);
const kalshiVolume = trimLeadingZeros(kalshiVolumeRaw);

const polymarketOi = toMonthStart(endOfMonth(points(predictionOiSeries.Polymarket)));
const polymarketUsOi = toMonthStart(endOfMonth(points(predictionOiSeries["Polymarket US"])));
const kalshiOi = toMonthStart(endOfMonth(points(predictionOiSeries.Kalshi)));
const predictionOi = filterFrom(sumMonthlySnapshots([polymarketOi, polymarketUsOi, kalshiOi]));

const polymarketTraders = points(chartSeries(fetched.polymarketTraders).Traders);
const polymarketMarkets = points(chartSeries(fetched.polymarketMarkets).Markets);
const kalshiActiveMarkets = toMonthStart(
  endOfMonth(points(chartSeries(fetched.kalshiActiveMarkets)["Daily Active Markets"])),
);

const sourceCatalog = Object.entries(SOURCE_DEFS).map(([key, source]) => {
  const chart = fetched[key].data.chart;
  return {
    key,
    publisher: "The Block",
    title: chart.title,
    page: source.page,
    api: source.api,
    retrievedAt: generatedAt,
    reportedFrequency: key === "dexVolume" ? "Monthly points (vendor metadata: Daily)" : chart.jsonFile.Frequency,
    upstreamSources: (chart.customFields?.data_sources ?? []).map((item) => item["source-text"]),
    body: chart.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace("Open Interesting", "Open Interest").trim(),
  };
});
sourceCatalog.push({
  key: "coinbaseOi", publisher: "Coinbase", title: "Coinbase International perpetual instruments · collected OI snapshots",
  page: "https://docs.cdp.coinbase.com/api-reference/international-exchange-api/rest-api/instruments/list-instruments",
  api: coinbaseOiApi, retrievedAt: latestCoinbaseOiSnapshot.retrievedAt, reportedFrequency: "Twice-daily collection while the local runner is active", upstreamSources: [],
  body: `PERP instruments only (${coinbasePerps.length}); sum base open_interest × mark_price. USDC treated as USD at 1:1. Collection began ${coinbaseOiCollectionStartedAt}; no pre-collection history inferred.${coinbaseOiSnapshotAccepted ? "" : ` The ${today} API response contained no priced open contract, so the prior valid snapshot from ${latestCoinbaseOiSnapshot.asOfDate} was retained.`}`,
}, {
  key: "btcUsdDaily", publisher: "Coinbase", title: "BTC/USD completed daily closing prices",
  page: "https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles",
  api: "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400",
  retrievedAt: generatedAt, reportedFrequency: "Daily", upstreamSources: [],
  body: "Completed UTC daily closes. Volume uses monthly mean daily closes; OI uses the last completed close on or before its observation date. BTC equivalents are approximate, not traded BTC quantities.",
});

const series = [
  {
    id: "category-cex-volume",
    category: "cex",
    venue: "Binance + Bybit + Kraken",
    metric: "volume",
    quality: "derived",
    sourceKey: "mixed-cex-volume",
    definition: "Binance perpetual volume + Bybit and Kraken total-futures volume proxies; monthly USD notional. Fixed three-venue universe; Coinbase kept separate because its history starts later.",
    points: cexVolume,
  },
  {
    id: "category-dex-volume",
    category: "dex",
    venue: "Covered perp DEXs",
    metric: "volume",
    quality: "derived",
    sourceKey: "dexVolume",
    definition: "Sum of every perp protocol in the covered DeFiLlama/The Block series; monthly USD notional.",
    points: dexVolume,
  },
  {
    id: "category-prediction-volume",
    category: "prediction",
    venue: "Polymarket + Kalshi",
    metric: "volume",
    quality: "derived",
    sourceKey: "predictionVolume",
    definition: "Covered taker notional in monthly USD; Polymarket throughout, Kalshi from Jul 2024, Polymarket US from Oct 2025.",
    points: predictionVolume,
  },
  {
    id: "category-cex-oi",
    category: "cex",
    venue: "Binance + Bybit + Kraken",
    metric: "oi",
    quality: "proxy",
    sourceKey: "bitcoinOi+ethereumOi",
    definition: "Last shared daily BTC + ETH futures OI each month for Binance, Bybit and Kraken; not all-pair perpetual OI. Coinbase excluded: current snapshot only.",
    points: cexOi,
  },
  {
    id: "category-dex-oi",
    category: "dex",
    venue: "Hyperliquid",
    metric: "oi",
    quality: "proxy",
    sourceKey: "hyperliquidOi",
    definition: "Month-end Hyperliquid OI only; partial proxy for global perp DEX OI.",
    points: dexOi,
  },
  {
    id: "category-prediction-oi",
    category: "prediction",
    venue: "Polymarket + Kalshi",
    metric: "oi",
    quality: "derived",
    sourceKey: "predictionOi",
    definition: "Sum of each covered venue's latest vendor-compiled USD OI snapshot in the month; component dates may differ. Kalshi begins Jul 2024 and Polymarket US begins Oct 2025.",
    points: predictionOi,
  },
  {
    id: "cex-binance-volume",
    category: "cex",
    venue: "Binance",
    metric: "volume",
    quality: "observed",
    sourceKey: "binancePerpVolume",
    definition: "Monthly Binance perpetual volume in USD notional.",
    points: binanceVolume,
  },
  {
    id: "cex-bybit-volume",
    category: "cex",
    venue: "Bybit",
    metric: "volume",
    quality: "proxy",
    sourceKey: "cexVolume",
    definition: "Monthly Bybit total-futures USD volume copied from The Block without perpetual-only filtering. Broader contract scope than requested; no estimate of the mismatch or independent reconciliation.",
    points: bybitVolume,
  },
  {
    id: "cex-kraken-volume", category: "cex", venue: "Kraken", metric: "volume", quality: "proxy", sourceKey: "cexVolume",
    definition: "Monthly Kraken total-futures USD volume from The Block; not verified perpetual-only. No spot volume included.",
    points: krakenVolume,
  },
  {
    id: "cex-coinbase-volume", category: "cex", venue: "Coinbase International", metric: "volume", quality: "derived", sourceKey: "coinbaseVolume",
    definition: `Monthly sum of daily USD notional across ${coinbasePerpEntries.length} reported -PERP contracts; all non-PERP symbols excluded. Source: The Block. History begins 21 Jun 2023 (incomplete month), not inception. No Coinbase spot, US futures or Deribit. Missing contract rows contribute zero to this covered-universe sum.`,
    points: coinbaseVolume,
  },
  {
    id: "cex-kraken-oi", category: "cex", venue: "Kraken", metric: "oi", quality: "proxy", sourceKey: "bitcoinOi+ethereumOi",
    definition: "Month-end Kraken BTC + ETH futures OI; major-asset futures proxy, not all-pair perpetual OI.",
    points: krakenOi,
  },
  {
    id: "cex-coinbase-oi", category: "cex", venue: "Coinbase International", metric: "oi", quality: "derived", sourceKey: "coinbaseOi",
    definition: `Collected all-perp OI snapshots from ${coinbaseOiCollectionStartedAt}: sum open_interest × mark_price for current PERP instruments. USDC treated as USD at 1:1. No pre-collection history inferred; excluded from category totals and correlations.`,
    points: coinbaseOi,
  },
  {
    id: "cex-binance-oi",
    category: "cex",
    venue: "Binance",
    metric: "oi",
    quality: "proxy",
    sourceKey: "bitcoinOi+ethereumOi",
    definition: "Month-end Binance BTC + ETH futures OI.",
    points: binanceOi,
  },
  {
    id: "cex-bybit-oi",
    category: "cex",
    venue: "Bybit",
    metric: "oi",
    quality: "proxy",
    sourceKey: "bitcoinOi+ethereumOi",
    definition: "Month-end Bybit BTC + ETH futures OI.",
    points: bybitOi,
  },
  ...dexVenueEntries
    .filter((entry) => dexTopTen.includes(entry.name))
    .map((entry) => ({
      id: `dex-${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-volume`,
      category: "dex",
      venue: entry.name,
      metric: "volume",
      quality: "observed",
      sourceKey: "dexVolume",
      definition: "Monthly reported perpetual-protocol volume in USD notional.",
      points: entry.points,
    })),
  {
    id: "dex-hyperliquid-oi",
    category: "dex",
    venue: "Hyperliquid",
    metric: "oi",
    quality: "observed",
    sourceKey: "hyperliquidOi",
    definition: "Month-end Hyperliquid L1 + HIP-3 OI in USD.",
    points: dexOi,
  },
  {
    id: "prediction-polymarket-volume",
    category: "prediction",
    venue: "Polymarket",
    metric: "volume",
    quality: "observed",
    sourceKey: "predictionVolume",
    definition: "Polymarket taker notional volume; monthly USD.",
    points: polymarketVolume,
  },
  {
    id: "prediction-polymarket-us-volume",
    category: "prediction",
    venue: "Polymarket US",
    metric: "volume",
    quality: "observed",
    sourceKey: "predictionVolume",
    definition: "Polymarket US taker notional volume; monthly USD.",
    points: polymarketUsVolume,
  },
  {
    id: "prediction-kalshi-volume",
    category: "prediction",
    venue: "Kalshi",
    metric: "volume",
    quality: "observed",
    sourceKey: "predictionVolume",
    definition: "Kalshi taker notional volume; monthly USD.",
    points: kalshiVolume,
  },
  {
    id: "prediction-polymarket-oi",
    category: "prediction",
    venue: "Polymarket",
    metric: "oi",
    quality: "observed",
    sourceKey: "predictionOi",
    definition: "Month-end Polymarket USD OI as compiled by The Block.",
    points: polymarketOi,
  },
  {
    id: "prediction-polymarket-us-oi",
    category: "prediction",
    venue: "Polymarket US",
    metric: "oi",
    quality: "observed",
    sourceKey: "predictionOi",
    definition: "Month-end Polymarket US USD OI as compiled by The Block.",
    points: polymarketUsOi,
  },
  {
    id: "prediction-kalshi-oi",
    category: "prediction",
    venue: "Kalshi",
    metric: "oi",
    quality: "observed",
    sourceKey: "predictionOi",
    definition: "Month-end Kalshi USD OI as compiled by The Block.",
    points: kalshiOi,
  },
  {
    id: "context-polymarket-traders",
    category: "prediction",
    venue: "Polymarket",
    metric: "activeTraders",
    quality: "observed",
    sourceKey: "polymarketTraders",
    definition: "Monthly active Polymarket traders under The Block's published series definition.",
    points: polymarketTraders,
  },
  {
    id: "context-polymarket-new-markets",
    category: "prediction",
    venue: "Polymarket",
    metric: "newMarkets",
    quality: "observed",
    sourceKey: "polymarketMarkets",
    definition: "New Polymarket markets created per month.",
    points: polymarketMarkets,
  },
  {
    id: "context-kalshi-active-markets",
    category: "prediction",
    venue: "Kalshi",
    metric: "activeMarkets",
    quality: "observed",
    sourceKey: "kalshiActiveMarkets",
    definition: "End-of-month observation of Kalshi daily active markets.",
    points: kalshiActiveMarkets,
  },
];

const finalizedSeries = series.map((item) => ({
  ...item,
  coverageStart: item.points.find((row) => row.value > 0)?.date ?? item.points[0]?.date ?? null,
  coverageEnd: item.points.at(-1)?.date ?? null,
  points: item.points.map((point) => {
    const converted = {
      ...point,
      isComplete: monthKey(point.date) <= completeThrough && point.isComplete !== false,
      ...btcEquivalent(point, item.metric, btcDailyPrices),
    };
    return {
      ...converted,
      ...partialVolumeProjection(converted, { metric: item.metric, generatedAt, completeThrough }),
    };
  }),
}));

const priorPartialHistory = await readJsonIfExists(PARTIAL_VOLUME_HISTORY);
const currentPartialSnapshot = {
  retrievedAt: generatedAt,
  month: monthKey(today),
  series: Object.fromEntries(finalizedSeries
    .filter((item) => item.metric === "volume")
    .flatMap((item) => {
      const point = item.points.find((candidate) => monthKey(candidate.date) === monthKey(today));
      return point ? [[item.id, {
        value: point.value,
        asOfDate: point.asOfDate ?? null,
        projectionValue: point.projectionValue ?? null,
        projectionCoveredDays: point.projectionCoveredDays ?? null,
        projectionCoverageBasis: point.projectionCoverageBasis ?? null,
        projectionUnavailableReason: point.projectionUnavailableReason ?? null,
      }]] : [];
    })),
};
const partialSnapshots = [...(Array.isArray(priorPartialHistory?.snapshots) ? priorPartialHistory.snapshots : []), currentPartialSnapshot]
  .filter((snapshot, index, snapshots) => snapshots.findIndex((candidate) => candidate.retrievedAt === snapshot.retrievedAt) === index)
  .sort((left, right) => left.retrievedAt.localeCompare(right.retrievedAt));
await writeAtomic(PARTIAL_VOLUME_HISTORY, `${JSON.stringify({
  description: "Observed incomplete-month volume values captured before projection; retained to backtest completion curves.",
  snapshots: partialSnapshots,
}, null, 2)}\n`);

const categorySeries = Object.fromEntries(finalizedSeries.filter((item) => item.id.startsWith("category-")).map((item) => [item.id, item.points]));

const correlations = {
  volume: {
    method: "USD monthly log changes; Pearson and Spearman; incomplete current month excluded. Fixed Binance + Bybit + Kraken CEX universe; Coinbase excluded.",
    coverageStart: "2024-07",
    pairs: {
      "cex__dex": pairCorrelation(categorySeries["category-cex-volume"], categorySeries["category-dex-volume"], {
        start: "2024-07",
        completeThrough,
      }),
      "cex__prediction": pairCorrelation(categorySeries["category-cex-volume"], categorySeries["category-prediction-volume"], {
        start: "2024-07",
        completeThrough,
      }),
      "dex__prediction": pairCorrelation(categorySeries["category-dex-volume"], categorySeries["category-prediction-volume"], {
        start: "2024-07",
        completeThrough,
      }),
    },
  },
  oi: {
    method: "USD month-end OI log changes; Pearson and Spearman; proxy scope disclosed. Fixed Binance + Bybit + Kraken CEX universe; Coinbase snapshot excluded.",
    coverageStart: "2024-12",
    pairs: {
      "cex__dex": pairCorrelation(categorySeries["category-cex-oi"], categorySeries["category-dex-oi"], {
        start: "2024-12",
        completeThrough,
      }),
      "cex__prediction": pairCorrelation(categorySeries["category-cex-oi"], categorySeries["category-prediction-oi"], {
        start: "2024-12",
        completeThrough,
      }),
      "dex__prediction": pairCorrelation(categorySeries["category-dex-oi"], categorySeries["category-prediction-oi"], {
        start: "2024-12",
        completeThrough,
      }),
    },
  },
};

const composition = await buildCompositionData({
  generatedAt,
  today,
  completeThrough,
  btcDailyPrices,
  hyperliquidVolume: dexVenueEntries.find((entry) => entry.name === "Hyperliquid")?.points ?? [],
  hyperliquidOi: dexOi,
});
sourceCatalog.push(...composition.sources);

const output = {
  meta: {
    title: "Activity Atlas",
    generatedAt,
    requestedDefaultStart: "2023-01-01",
    completeThrough,
    currentMonthPartial: finalizedSeries.some((item) => item.points.some((point) => monthKey(point.date) > completeThrough)),
    currency: "USD",
    dexVenueCount: dexVenueEntries.length,
    refreshSchedule: "08:00 and 16:00 Europe/Paris locally and through GitHub Actions",
    partialVolumeMethod: "Observed MTD × calendar days ÷ covered days; source-zero current buckets are omitted from charts",
    warnings: [
      "Current-month volume is shown as a dashed calendar run-rate estimate when MTD data is positive; raw MTD values remain in JSON/CSV and tooltips. Source-zero current buckets are omitted rather than plotted as activity collapses.",
      "Current-month OI is a dashed latest snapshot and is never extrapolated. Incomplete-month data is excluded from correlations; raw current MTD volume is included in the provisional venue ranking so new activity is not hidden.",
      "Bybit and Kraken volume are total-futures proxies, not verified perpetual-only. Bybit values are not adjusted or independently reconciled; the scope mismatch is unquantified.",
      "CEX OI is a BTC + ETH futures proxy, not all-pair perpetual OI.",
      `CEX category totals use a fixed Binance + Bybit + Kraken universe. Coinbase International stays separate: volume starts 21 June 2023 and OI snapshot collection starts ${coinbaseOiCollectionStartedAt}.`,
      "Coinbase International OI is USDC notional treated as USD at 1:1. Its collected observations must not be read as a verified pre-collection or exact month-end history.",
      ...(coinbaseOiSnapshotAccepted ? [] : [`Coinbase International's ${today} all-PERP response contained no priced open contract; it was rejected and the ${latestCoinbaseOiSnapshot.asOfDate} valid OI snapshot was retained.`]),
      "BTC display is an approximate equivalent-value conversion using Coinbase BTC/USD daily closes, not actual BTC contract quantities. Correlations remain in USD to avoid shared-denominator effects.",
      "Perp DEX OI history covers Hyperliquid only; no free global historical series was verified.",
      "Prediction-market aggregates before July 2024 cover Polymarket only; Kalshi starts July 2024 and Polymarket US starts October 2025.",
      "Absent protocol observations are treated as zero inside aggregate volume sums; source gaps can therefore resemble pre-launch inactivity.",
      "Top-10 perp DEX ranking uses observed cumulative volume including raw current MTD (never the projected run rate), so it is provisional until month-end and still favors longer-lived venues.",
      ...(dexVenueEntries.some((entry) => entry.name === "PaperTrade" && entry.points.some((row) => monthKey(row.date) > completeThrough && row.value > 0))
        ? ["PaperTrade first appears in the vendor series during the current incomplete month. Its reported notional is included and visible in the provisional ranking, but Activity Atlas has not independently reconciled that venue's economic volume."]
        : []),
      "Protocol labels follow the vendor source; infrastructure or routed-liquidity attribution may overlap at the source level.",
      "Correlation describes co-movement, not causation; small OI samples are exploratory.",
    ],
  },
  rankings: {
    perpDexByCumulativeVolume: dexRanking,
    displayedTopTen: dexTopTen,
  },
  correlations,
  btcPrices: { sourceKey: "btcUsdDaily", start: btcDailyPrices[0].date, end: btcDailyPrices.at(-1).date, dailyCloses: btcDailyPrices },
  sources: sourceCatalog,
  series: finalizedSeries,
  composition,
};

const normalizedCsv = toCsv(finalizedSeries);
await writeAtomic(path.join(NORMALIZED_DIR, "activity-series.csv"), normalizedCsv);
await writeAtomic(path.join(PUBLIC_DIR, "activity-series.csv"), normalizedCsv);
// Publish JSON last: this timestamp is the dashboard's commit point.
await writeAtomic(path.join(PUBLIC_DIR, "activity-data.json"), `${JSON.stringify(output)}\n`);

console.log(
  JSON.stringify(
    {
      generatedAt,
      completeThrough,
      series: finalizedSeries.length,
      compositionSeries: composition.series.length,
      topTen: dexTopTen,
      correlations,
    },
    null,
    2,
  ),
);
} finally {
  await refreshLock.close();
  await unlink(REFRESH_LOCK).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
