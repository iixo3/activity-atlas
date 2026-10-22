import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { btcEquivalent } from "../lib/activity-math.mjs";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const NORMALIZED_DIR = path.join(ROOT, "data", "normalized");
const CACHE_FILE = path.join(NORMALIZED_DIR, "composition-cache.json");
const DUNE_CLI = process.env.ACTIVITY_ATLAS_DUNE_CLI || "dune";
const SKIP_DUNE = process.env.ACTIVITY_ATLAS_SKIP_DUNE === "1";
const REQUEST_HEADERS = { "user-agent": "ActivityAtlas/1.0 research dashboard" };
const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const HYPERLIQUID_OPERATOR_NAMES = {
  "": "Hyperliquid Core",
  xyz: "trade.xyz",
  flx: "Felix",
  vntl: "Ventuals",
  hyna: "hyENA",
  cash: "Dreamcash",
  km: "Markets",
  mkts: "Markets",
  para: "Paragon",
  io: "Entropy",
};
const HYPERLIQUID_ASSET_CLASSES = {
  crypto: "Crypto",
  stock: "Public equities",
  stocks: "Public equities",
  commodities: "Commodities",
  indices: "Equity indices / ETFs",
  preipo: "Pre-IPO / private",
  fx: "FX",
  rates: "Rates",
};

const HYPERLIQUID_VOLUME_SQL = `
WITH ranked AS (
  SELECT
    try_cast(day AS date) AS day,
    coalesce(nullif(venue, ''), 'Unclassified') AS operator,
    coalesce(nullif(market, ''), nullif(raw_market, ''), 'Unclassified') AS instrument,
    CASE
      WHEN sector LIKE 'Crypto%' OR sector = 'Other Crypto' THEN 'Crypto'
      WHEN sector = 'Equities' THEN 'Public equities'
      WHEN sector = 'Equity Indices / ETFs' THEN 'Equity indices / ETFs'
      WHEN sector = 'Private Markets' THEN 'Pre-IPO / private'
      WHEN sector = 'Commodities' THEN 'Commodities'
      WHEN sector = 'FX' THEN 'FX'
      WHEN sector = 'Rates' THEN 'Rates'
      ELSE coalesce(nullif(sector, ''), 'Unclassified')
    END AS asset_class,
    estimated_volume_usd AS value,
    row_number() OVER (
      PARTITION BY day, venue, market_type, raw_market
      ORDER BY market
    ) AS row_rank
  FROM dune."21sharesresearch".dataset_hyperliquid_volume_backbone_full
  WHERE try_cast(day AS date) >= DATE '2023-01-01'
    AND estimated_volume_usd IS NOT NULL
), base AS (
  SELECT day, operator, instrument, asset_class, value
  FROM ranked
  WHERE row_rank = 1 AND day IS NOT NULL AND value >= 0
), top_instruments AS (
  SELECT instrument
  FROM base
  GROUP BY 1
  ORDER BY sum(value) DESC
  LIMIT 10
), expanded AS (
  SELECT day, 'assetClass' AS dimension, asset_class AS label, value FROM base
  UNION ALL
  SELECT day, 'operator' AS dimension, operator AS label, value FROM base
  UNION ALL
  SELECT day, 'instrument' AS dimension,
    CASE WHEN instrument IN (SELECT instrument FROM top_instruments) THEN instrument ELSE 'Other instruments' END AS label,
    value
  FROM base
)
SELECT
  date_trunc('month', day) AS month_start,
  dimension,
  label,
  sum(value) AS volume_usd,
  count(DISTINCT day) AS observed_days,
  min(day) AS first_day,
  max(day) AS last_day
FROM expanded
GROUP BY 1,2,3
ORDER BY 1,2,3`;

const HYPERLIQUID_OI_SQL = `
WITH ranked AS (
  SELECT
    try_cast(day AS date) AS day,
    coalesce(nullif(venue, ''), 'Unclassified') AS operator,
    coalesce(nullif(canonical_market, ''), nullif(market, ''), 'Unclassified') AS instrument,
    CASE
      WHEN sector LIKE 'Crypto%' OR sector = 'Other Crypto' THEN 'Crypto'
      WHEN sector = 'Equities' THEN 'Public equities'
      WHEN sector = 'Equity Indices / ETFs' THEN 'Equity indices / ETFs'
      WHEN sector = 'Private Markets' THEN 'Pre-IPO / private'
      WHEN sector = 'Commodities' THEN 'Commodities'
      WHEN sector = 'FX' THEN 'FX'
      WHEN sector = 'Rates' THEN 'Rates'
      ELSE coalesce(nullif(sector, ''), 'Unclassified')
    END AS asset_class,
    open_interest_usd AS value,
    source,
    row_number() OVER (
      PARTITION BY day, venue, market_type, market
      ORDER BY CASE WHEN source LIKE 'official%' THEN 0 ELSE 1 END, source
    ) AS row_rank
  FROM dune."21sharesresearch".dataset_hyperliquid_oi_history
  WHERE try_cast(day AS date) >= DATE '2023-01-01'
    AND open_interest_usd IS NOT NULL
), base AS (
  SELECT day, operator, instrument, asset_class, value
  FROM ranked
  WHERE row_rank = 1 AND day IS NOT NULL AND value >= 0
), top_instruments AS (
  SELECT instrument
  FROM base
  GROUP BY 1
  ORDER BY sum(value) DESC
  LIMIT 10
), expanded AS (
  SELECT day, 'assetClass' AS dimension, asset_class AS label, value FROM base
  UNION ALL
  SELECT day, 'operator' AS dimension, operator AS label, value FROM base
  UNION ALL
  SELECT day, 'instrument' AS dimension,
    CASE WHEN instrument IN (SELECT instrument FROM top_instruments) THEN instrument ELSE 'Other instruments' END AS label,
    value
  FROM base
), daily AS (
  SELECT day, dimension, label, sum(value) AS value
  FROM expanded
  GROUP BY 1,2,3
)
SELECT
  date_trunc('month', day) AS month_start,
  dimension,
  label,
  avg(value) AS average_oi_usd,
  max_by(value, day) AS month_end_oi_usd,
  count(*) AS observed_days,
  min(day) AS first_day,
  max(day) AS last_day
FROM daily
GROUP BY 1,2,3
ORDER BY 1,2,3`;

const POLYMARKET_CATEGORY_SQL = `
WITH weekly AS (
  SELECT datetime, ARRAY[
    ROW('Climate and weather', climate_and_weather___spot_volume),
    ROW('Companies', companies___spot_volume),
    ROW('Crypto', crypto___spot_volume),
    ROW('Economics', economics___spot_volume),
    ROW('Elections', elections___spot_volume),
    ROW('Entertainment', entertainment___spot_volume),
    ROW('Health', health___spot_volume),
    ROW('Other', other___spot_volume),
    ROW('Politics', politics___spot_volume),
    ROW('Science and technology', science_and_technology___spot_volume),
    ROW('Sports', sports___spot_volume),
    ROW('World', world___spot_volume),
    ROW('Financials', financials___spot_volume)
  ] AS category_rows
  FROM dune.jjhatch3.dataset_polymarket_volume_by_cat
), normalized AS (
  SELECT substr(datetime, 1, 7) AS month, u.category, u.volume
  FROM weekly
  CROSS JOIN UNNEST(category_rows) AS u(category, volume)
)
SELECT
  month || '-01' AS month_start,
  category AS label,
  count(*) AS weekly_observations,
  sum(volume) AS volume_usd
FROM normalized
WHERE volume IS NOT NULL
GROUP BY 1,2
ORDER BY 1,2`;

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function monthKey(date) {
  return String(date).slice(0, 7);
}

function monthStart(date) {
  return `${monthKey(date)}-01`;
}

function daysInMonth(date) {
  const [year, month] = monthKey(date).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function lastDayOfMonth(date) {
  const [year, month] = monthKey(date).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, value);
  await rename(temporaryPath, filePath);
}

async function fetchJson(url, options = {}) {
  let latestError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...REQUEST_HEADERS, ...(options.headers ?? {}) },
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
      return await response.json();
    } catch (error) {
      latestError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw latestError;
}

function errorDetails(error) {
  const details = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = typeof current.code === "string" ? `${current.code}: ` : "";
    const message = typeof current.message === "string" ? current.message : String(current);
    const detail = `${code}${message}`;
    if (message && !details.includes(detail)) details.push(detail);
    current = current.cause;
  }
  return details.join(" <- ") || "unknown error";
}

async function postHyperliquidInfo(body) {
  return fetchJson(HYPERLIQUID_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function mapLimit(values, limit, task) {
  const results = Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await task(values[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function runDuneSql(sql) {
  const { stdout } = await execFileAsync(DUNE_CLI, ["query", "run-sql", "--sql", sql, "-o", "json"], {
    cwd: ROOT,
    timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const payload = JSON.parse(stdout);
  if (payload.state !== "QUERY_STATE_COMPLETED" || !Array.isArray(payload.result?.rows)) {
    throw new Error(payload.error?.message ?? `Dune query ended in ${payload.state ?? "unknown state"}`);
  }
  return payload.result.rows;
}

function createSeries(spec, points) {
  return {
    id: `composition-${slug(spec.venue)}-${slug(spec.dimension)}-${slug(spec.metric)}-${slug(spec.group)}`,
    venue: spec.venue,
    product: spec.product,
    dimension: spec.dimension,
    group: spec.group,
    metric: spec.metric,
    metricLabel: spec.metricLabel,
    unit: spec.unit,
    quality: spec.quality,
    classificationSource: spec.classificationSource,
    definition: spec.definition,
    points: [...points].sort((left, right) => left.date.localeCompare(right.date)),
  };
}

function upsertPoint(seriesMap, spec, point) {
  const key = [spec.venue, spec.dimension, spec.metric, spec.group].join("::");
  const existing = seriesMap.get(key) ?? createSeries(spec, []);
  const points = existing.points.filter((candidate) => candidate.date !== point.date);
  points.push(point);
  existing.points = points.sort((left, right) => left.date.localeCompare(right.date));
  seriesMap.set(key, existing);
}

function metricBtcKind(metric) {
  if (["monthlyVolume", "monthlyVolumeApprox"].includes(metric)) return "volume";
  if (["averageOi", "monthEndOi", "oiSnapshot", "volume24h", "volume30d"].includes(metric)) return "oi";
  return null;
}

function finalizeCompositionSeries(series, btcDailyPrices) {
  const totalByKey = new Map();
  for (const item of series) {
    if (item.unit !== "usd") continue;
    for (const point of item.points) {
      const key = [item.venue, item.dimension, item.metric, point.date].join("::");
      totalByKey.set(key, (totalByKey.get(key) ?? 0) + point.value);
    }
  }
  return series.map((item) => ({
    ...item,
    coverageStart: item.points[0]?.date ?? null,
    coverageEnd: item.points.at(-1)?.date ?? null,
    points: item.points.map((point) => {
      const total = totalByKey.get([item.venue, item.dimension, item.metric, point.date].join("::"));
      const btcKind = metricBtcKind(item.metric);
      return {
        ...point,
        share: item.unit === "usd" && total > 0 ? 100 * point.value / total : null,
        ...(btcKind ? btcEquivalent(point, btcKind, btcDailyPrices) : {}),
      };
    }),
  }));
}

function providerRetrievedAt(provider, fallback) {
  if (provider?.refreshedAt) return provider.refreshedAt;
  const points = provider?.series?.flatMap((item) => item.points ?? []) ?? [];
  const collectedAt = points.map((point) => point.collectedAt).filter(Boolean).sort().at(-1);
  if (collectedAt) return collectedAt;
  const asOfDate = points.map((point) => point.asOfDate).filter(Boolean).sort().at(-1);
  return asOfDate ? `${asOfDate}T23:59:59.000Z` : fallback;
}

function platformMap(points) {
  return new Map((points ?? []).map((point) => [monthKey(point.date), point]));
}

function reconcileRows(rows, valueKey, platformPoints) {
  const totals = new Map();
  for (const row of rows) {
    const key = [monthKey(row.month_start), row.dimension].join("::");
    totals.set(key, (totals.get(key) ?? 0) + asNumber(row[valueKey]));
  }
  const platform = platformMap(platformPoints);
  return rows.map((row) => {
    const month = monthKey(row.month_start);
    const total = totals.get([month, row.dimension].join("::"));
    const platformPoint = platform.get(month);
    const scale = platformPoint && total > 0 ? platformPoint.value / total : 1;
    return { ...row, reconciled_value: asNumber(row[valueKey]) * scale, reconciliationScale: scale };
  });
}

function buildHyperliquidProvider({ volumeRows, oiRows, platformVolume, platformOi, completeThrough }) {
  if (!volumeRows?.length && !oiRows?.length) throw new Error("No Hyperliquid composition rows available");
  const venue = "Hyperliquid";
  const product = "Perpetual futures";
  const map = new Map();
  const reconciledVolume = reconcileRows(volumeRows ?? [], "volume_usd", platformVolume);
  const reconciledOiEnd = reconcileRows(oiRows ?? [], "month_end_oi_usd", platformOi);
  const oiEndScale = new Map(reconciledOiEnd.map((row) => [[monthKey(row.month_start), row.dimension, row.label].join("::"), row.reconciliationScale]));
  const firstVolumeMonth = reconciledVolume[0] ? Math.min(...reconciledVolume.map((row) => Number(monthKey(row.month_start).replace("-", "")))) : Infinity;
  const firstOiMonth = reconciledOiEnd[0] ? Math.min(...reconciledOiEnd.map((row) => Number(monthKey(row.month_start).replace("-", "")))) : Infinity;

  const definitions = {
    volume: "Monthly classification shares use 21Shares Research daily market estimates from Hyperliquid's official API, reconciled to Activity Atlas's platform-level Hyperliquid volume.",
    oi: "Daily per-market Hyperliquid OI from 21Shares Research; category shares are reconciled to the platform-level month-end series. Average OI is the average of observed daily category totals.",
  };

  for (const row of reconciledVolume) {
    const date = monthStart(row.month_start);
    const isComplete = monthKey(date) <= completeThrough && asNumber(row.observed_days) >= daysInMonth(date);
    upsertPoint(map, {
      venue, product, dimension: row.dimension, group: row.label, metric: "monthlyVolume", metricLabel: "Monthly volume", unit: "usd",
      quality: "derived", classificationSource: "21Shares Research sector/operator mapping", definition: definitions.volume,
    }, {
      date,
      value: row.reconciled_value,
      asOfDate: row.last_day,
      observedDays: asNumber(row.observed_days),
      isComplete,
      reconciliationScale: row.reconciliationScale,
    });
  }

  for (const row of reconciledOiEnd) {
    const date = monthStart(row.month_start);
    const scale = oiEndScale.get([monthKey(row.month_start), row.dimension, row.label].join("::")) ?? 1;
    const common = {
      date,
      asOfDate: row.last_day,
      observedDays: asNumber(row.observed_days),
      isComplete: monthKey(date) <= completeThrough && row.last_day === lastDayOfMonth(date),
      reconciliationScale: scale,
    };
    upsertPoint(map, {
      venue, product, dimension: row.dimension, group: row.label, metric: "averageOi", metricLabel: "Average daily OI", unit: "usd",
      quality: "derived", classificationSource: "21Shares Research sector/operator mapping", definition: definitions.oi,
    }, { ...common, value: asNumber(row.average_oi_usd) * scale });
    upsertPoint(map, {
      venue, product, dimension: row.dimension, group: row.label, metric: "monthEndOi", metricLabel: "Month-end OI", unit: "usd",
      quality: "derived", classificationSource: "21Shares Research sector/operator mapping", definition: definitions.oi,
    }, { ...common, value: row.reconciled_value });
  }

  const granularVolumeMonths = new Set(reconciledVolume.map((row) => monthKey(row.month_start)));
  const granularOiMonths = new Set(reconciledOiEnd.map((row) => monthKey(row.month_start)));
  for (const point of platformVolume ?? []) {
    if (granularVolumeMonths.has(monthKey(point.date)) || Number(monthKey(point.date).replace("-", "")) >= firstVolumeMonth) continue;
    for (const [dimension, group] of [["assetClass", "Crypto"], ["operator", "Hyperliquid Core"], ["instrument", "Core aggregate"]]) {
      upsertPoint(map, {
        venue, product, dimension, group, metric: "monthlyVolume", metricLabel: "Monthly volume", unit: "usd",
        quality: "derived", classificationSource: "pre-HIP-3 platform classification", definition: "Before granular HIP-3 coverage, platform volume is classified as Hyperliquid Core crypto; instrument-level allocation is unavailable.",
      }, { ...point });
    }
  }
  for (const point of platformOi ?? []) {
    if (granularOiMonths.has(monthKey(point.date)) || Number(monthKey(point.date).replace("-", "")) >= firstOiMonth) continue;
    for (const [dimension, group] of [["assetClass", "Crypto"], ["operator", "Hyperliquid Core"], ["instrument", "Core aggregate"]]) {
      upsertPoint(map, {
        venue, product, dimension, group, metric: "monthEndOi", metricLabel: "Month-end OI", unit: "usd",
        quality: "derived", classificationSource: "pre-granular platform classification", definition: "Platform-level Hyperliquid OI before per-market coverage; classified as Core crypto without instrument allocation.",
      }, { ...point });
    }
  }

  addTurnoverSeries(map, venue, product, "monthlyVolume", "averageOi", "monthlyTurnover", "Monthly volume / average OI");
  return {
    series: [...map.values()],
    coverageNote: "Granular OI begins June 2023. Granular market-volume classification begins October 2025; earlier platform volume is Core crypto only.",
  };
}

function hyperliquidDexDefinitions(perpDexs) {
  if (!Array.isArray(perpDexs) || !perpDexs.length) throw new Error("Hyperliquid perpDexs returned no venues");
  const definitions = perpDexs.map((entry) => {
    if (entry === null) return { dex: "", fullName: "Hyperliquid Core" };
    if (!entry || typeof entry.name !== "string" || !entry.name) throw new Error("Hyperliquid perpDexs contained an invalid venue");
    return { dex: entry.name, fullName: entry.fullName || entry.name };
  });
  const names = definitions.map((entry) => entry.dex);
  if (!names.includes("")) throw new Error("Hyperliquid perpDexs omitted the core venue");
  if (new Set(names).size !== names.length) throw new Error("Hyperliquid perpDexs contained duplicate venue names");
  return definitions;
}

function nonNegativeNumber(value, label) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Hyperliquid ${label} is invalid`);
  return number;
}

export function normalizeHyperliquidLiveSnapshot({ perpDexs, annotations, dexPayloads }) {
  const definitions = hyperliquidDexDefinitions(perpDexs);
  if (!Array.isArray(annotations)) throw new Error("Hyperliquid perpConciseAnnotations response is invalid");
  if (!Array.isArray(dexPayloads)) throw new Error("Hyperliquid venue payloads are invalid");

  const annotationMap = new Map();
  for (const entry of annotations) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[1] || typeof entry[1] !== "object") continue;
    annotationMap.set(entry[0], entry[1]);
  }
  const payloadByDex = new Map(dexPayloads.map((entry) => [entry.dex, entry.payload]));
  if (payloadByDex.size !== definitions.length || definitions.some((entry) => !payloadByDex.has(entry.dex))) {
    throw new Error("Hyperliquid live snapshot did not cover every reported perp DEX");
  }

  const records = [];
  for (const definition of definitions) {
    const payload = payloadByDex.get(definition.dex);
    if (!Array.isArray(payload) || payload.length !== 2) throw new Error(`Hyperliquid ${definition.dex || "core"} metaAndAssetCtxs response is invalid`);
    const [meta, contexts] = payload;
    const universe = meta?.universe;
    if (!Array.isArray(universe) || !Array.isArray(contexts) || universe.length !== contexts.length) {
      throw new Error(`Hyperliquid ${definition.dex || "core"} market metadata/context lengths do not match`);
    }
    const operator = HYPERLIQUID_OPERATOR_NAMES[definition.dex] || definition.fullName;
    const collateralToken = meta.collateralToken ?? null;
    universe.forEach((market, index) => {
      if (!market || typeof market.name !== "string" || !market.name) throw new Error(`Hyperliquid ${definition.dex || "core"} market name is invalid`);
      const context = contexts[index] ?? {};
      const volume24h = nonNegativeNumber(context.dayNtlVlm, `${market.name} dayNtlVlm`);
      const openInterest = nonNegativeNumber(context.openInterest, `${market.name} openInterest`);
      const markPrice = nonNegativeNumber(context.markPx, `${market.name} markPx`);
      if (openInterest > 0 && markPrice <= 0) throw new Error(`Hyperliquid ${market.name} has positive OI without a positive mark price`);
      const annotation = annotationMap.get(market.name);
      const rawCategory = String(annotation?.category ?? "").toLowerCase();
      const assetClass = definition.dex === "" ? "Crypto" : HYPERLIQUID_ASSET_CLASSES[rawCategory] ?? "Unclassified";
      records.push({
        assetClass,
        operator,
        instrument: annotation?.displayName || market.name.replace(/^[^:]+:/, ""),
        market: market.name,
        dex: definition.dex,
        collateralToken,
        volume24h,
        oi: openInterest * markPrice,
        score: volume24h + openInterest * markPrice,
      });
    });
  }
  if (!records.length || !records.some((record) => record.volume24h > 0 || record.oi > 0)) {
    throw new Error("Hyperliquid official live snapshot contained no positive activity");
  }
  return records;
}

async function fetchHyperliquidLiveSnapshot() {
  const [perpDexs, annotations] = await Promise.all([
    postHyperliquidInfo({ type: "perpDexs" }),
    postHyperliquidInfo({ type: "perpConciseAnnotations" }),
  ]);
  const definitions = hyperliquidDexDefinitions(perpDexs);
  const results = await mapLimit(definitions, 4, async (definition) => ({
    dex: definition.dex,
    payload: await postHyperliquidInfo({ type: "metaAndAssetCtxs", dex: definition.dex }),
  }));
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw new Error(`Hyperliquid metaAndAssetCtxs refresh failed (${errorDetails(failed.reason)})`);
  return normalizeHyperliquidLiveSnapshot({
    perpDexs,
    annotations,
    dexPayloads: results.map((result) => result.value),
  });
}

function aggregateHyperliquidLive(records, dimension) {
  const buckets = new Map();
  for (const record of records) {
    const label = record[dimension] || "Unclassified";
    const bucket = buckets.get(label) ?? {
      label,
      volume24h: 0,
      oi: 0,
      score: 0,
      collateralTokenIds: new Set(),
      perpDexes: new Set(),
    };
    bucket.volume24h += record.volume24h;
    bucket.oi += record.oi;
    bucket.score += record.score;
    bucket.collateralTokenIds.add(record.collateralToken);
    bucket.perpDexes.add(record.dex || "core");
    buckets.set(label, bucket);
  }
  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    collateralTokenIds: [...bucket.collateralTokenIds].sort((left, right) => String(left).localeCompare(String(right))),
    perpDexes: [...bucket.perpDexes].sort(),
  }));
}

function topHyperliquidLiveRows(rows, limit = 10) {
  const sorted = [...rows].sort((left, right) => right.score - left.score);
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  if (rest.length) {
    top.push({
      label: "Other markets",
      volume24h: rest.reduce((sum, row) => sum + row.volume24h, 0),
      oi: rest.reduce((sum, row) => sum + row.oi, 0),
      score: rest.reduce((sum, row) => sum + row.score, 0),
      collateralTokenIds: [...new Set(rest.flatMap((row) => row.collateralTokenIds))].sort((left, right) => String(left).localeCompare(String(right))),
      perpDexes: [...new Set(rest.flatMap((row) => row.perpDexes))].sort(),
    });
  }
  return top;
}

export function buildHyperliquidLiveProvider({ records, date, collectedAt, previous }) {
  if (!Array.isArray(records) || !records.length) throw new Error("No Hyperliquid official live records available");
  const venue = "Hyperliquid";
  const product = "Perpetual futures";
  const map = new Map();
  const pointBase = { date: monthStart(date), asOfDate: date, collectedAt, isSnapshot: true, isComplete: false };
  const dimensions = [
    ["assetClass", aggregateHyperliquidLive(records, "assetClass")],
    ["operator", aggregateHyperliquidLive(records, "operator")],
    ["instrument", topHyperliquidLiveRows(aggregateHyperliquidLive(records, "instrument"))],
  ];
  const classificationSource = "Hyperliquid official perpConciseAnnotations; Core defaults to Crypto; missing HIP-3 annotations remain Unclassified";
  const notionalCaveat = "Official collateralToken IDs are retained on each point. Values are treated as nominal USD-equivalent for chart compatibility; no cross-collateral FX conversion is applied.";
  for (const [dimension, rows] of dimensions) {
    for (const row of rows) {
      const metadata = { collateralTokenIds: row.collateralTokenIds, perpDexes: row.perpDexes };
      upsertPoint(map, {
        venue, product, dimension, group: row.label, metric: "volume24h", metricLabel: "Rolling 24h volume", unit: "usd",
        quality: "proxy", classificationSource,
        definition: `Official dayNtlVlm at refresh time, grouped by ${dimension}. This is rolling 24h notional, not calendar-month volume. ${notionalCaveat}`,
      }, { ...pointBase, ...metadata, value: row.volume24h });
      upsertPoint(map, {
        venue, product, dimension, group: row.label, metric: "oiSnapshot", metricLabel: "Open-interest snapshot", unit: "usd",
        quality: "proxy", classificationSource,
        definition: `Official openInterest multiplied by markPx at refresh time, grouped by ${dimension}. ${notionalCaveat}`,
      }, { ...pointBase, ...metadata, value: row.oi });
    }
  }
  addTurnoverSeries(map, venue, product, "volume24h", "oiSnapshot", "turnover24h", "24h volume / OI");

  const current = [...map.values()];
  if (!previous?.series?.length) return { series: current };
  const merged = new Map(current.map((item) => [[item.venue, item.dimension, item.metric, item.group].join("::"), item]));
  for (const old of previous.series) {
    if (old.dimension === "instrument") continue;
    const key = [old.venue, old.dimension, old.metric, old.group].join("::");
    const historicalPoints = old.points.filter((point) => point.date !== pointBase.date);
    const next = merged.get(key);
    if (!next) {
      if (historicalPoints.length) merged.set(key, { ...old, points: historicalPoints });
      continue;
    }
    next.points = [...historicalPoints, ...next.points].sort((left, right) => left.date.localeCompare(right.date));
  }
  return { series: [...merged.values()] };
}

function dailyProviderRows(marketsWithCandles) {
  const rows = [];
  for (const { market, candles } of marketsWithCandles) {
    for (const candle of candles) {
      const date = new Date(asNumber(candle.end_period_ts) * 1000).toISOString().slice(0, 10);
      rows.push({
        date,
        assetClass: market.asset_class || "Unclassified",
        instrument: market.ticker.replace(/^KX/, "").replace(/PERP$/, ""),
        volume: asNumber(candle.volume_notional_value_dollars),
        oi: asNumber(candle.open_interest_notional_value_dollars),
      });
    }
  }
  return rows;
}

function aggregateDailyComposition(rows, dimension) {
  const map = new Map();
  for (const row of rows) {
    const label = dimension === "assetClass" ? row.assetClass : row.instrument;
    const key = [row.date, label].join("::");
    const bucket = map.get(key) ?? { date: row.date, label, volume: 0, oi: 0 };
    bucket.volume += row.volume;
    bucket.oi += row.oi;
    map.set(key, bucket);
  }
  return [...map.values()];
}

function buildKalshiPerpsProvider(marketsWithCandles, completeThrough) {
  const rows = dailyProviderRows(marketsWithCandles);
  if (!rows.length) throw new Error("Kalshi perps returned no historical candles");
  const venue = "Kalshi Perps";
  const product = "Perpetual futures";
  const map = new Map();
  for (const dimension of ["assetClass", "instrument"]) {
    const daily = aggregateDailyComposition(rows, dimension);
    const grouped = new Map();
    for (const row of daily) {
      const key = [monthKey(row.date), row.label].join("::");
      const bucket = grouped.get(key) ?? { month: monthKey(row.date), label: row.label, days: new Set(), volume: 0, oiSum: 0, last: row };
      bucket.days.add(row.date);
      bucket.volume += row.volume;
      bucket.oiSum += row.oi;
      if (row.date >= bucket.last.date) bucket.last = row;
      grouped.set(key, bucket);
    }
    for (const bucket of grouped.values()) {
      const date = `${bucket.month}-01`;
      const common = {
        date,
        asOfDate: bucket.last.date,
        observedDays: bucket.days.size,
        isComplete: bucket.month <= completeThrough && bucket.days.size >= daysInMonth(date),
      };
      const base = {
        venue, product, dimension, group: bucket.label, unit: "usd", quality: "observed",
        classificationSource: "Kalshi official margin-market asset_class and ticker",
      };
      upsertPoint(map, { ...base, metric: "monthlyVolume", metricLabel: "Monthly volume", definition: "Sum of official daily one-sided perpetual-futures notional volume." }, { ...common, value: bucket.volume });
      upsertPoint(map, { ...base, metric: "averageOi", metricLabel: "Average daily OI", definition: "Average of official daily end-of-period perpetual OI notional observations." }, { ...common, value: bucket.oiSum / bucket.days.size });
      upsertPoint(map, { ...base, metric: "monthEndOi", metricLabel: "Month-end OI", definition: "Last official daily perpetual OI notional observation in each calendar month." }, { ...common, value: bucket.last.oi });
    }
  }
  addTurnoverSeries(map, venue, product, "monthlyVolume", "averageOi", "monthlyTurnover", "Monthly volume / average OI");
  return {
    series: [...map.values()],
    coverageNote: "Official Kalshi margin-market candles from product launch; no pre-launch zeros are inferred.",
  };
}

function addTurnoverSeries(seriesMap, venue, product, volumeMetric, oiMetric, outputMetric, label) {
  const candidates = [...seriesMap.values()].filter((item) => item.venue === venue && item.metric === volumeMetric);
  for (const volume of candidates) {
    const oi = [...seriesMap.values()].find((item) => item.venue === venue && item.dimension === volume.dimension && item.group === volume.group && item.metric === oiMetric);
    if (!oi) continue;
    const oiByDate = new Map(oi.points.map((point) => [point.date, point]));
    const points = volume.points.flatMap((point) => {
      const denominator = oiByDate.get(point.date);
      if (!denominator || denominator.value <= 0) return [];
      return [{
        date: point.date,
        value: point.value / denominator.value,
        asOfDate: denominator.asOfDate ?? point.asOfDate,
        isComplete: point.isComplete !== false && denominator.isComplete !== false,
      }];
    });
    if (!points.length) continue;
    seriesMap.set([venue, volume.dimension, outputMetric, volume.group].join("::"), createSeries({
      venue, product, dimension: volume.dimension, group: volume.group, metric: outputMetric, metricLabel: label, unit: "multiple",
      quality: "derived", classificationSource: volume.classificationSource,
      definition: `${volume.metricLabel} divided by ${oi.metricLabel}. Screening signal only; high turnover does not prove manipulation.`,
    }, points));
  }
}

function aggregateSnapshot(records, dimension, valueKey) {
  const buckets = new Map();
  for (const record of records) {
    const label = record[dimension] || "Unclassified";
    buckets.set(label, (buckets.get(label) ?? 0) + asNumber(record[valueKey]));
  }
  return [...buckets.entries()].map(([label, value]) => ({ label, value }));
}

function topSnapshotRecords(records, scoreKey, limit = 10) {
  const sorted = [...records].sort((left, right) => asNumber(right[scoreKey]) - asNumber(left[scoreKey]));
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  if (rest.length) {
    top.push({
      instrument: "Other markets",
      volume24h: rest.reduce((sum, item) => sum + asNumber(item.volume24h), 0),
      volume30d: rest.reduce((sum, item) => sum + asNumber(item.volume30d), 0),
      oi: rest.reduce((sum, item) => sum + asNumber(item.oi), 0),
    });
  }
  return top;
}

function buildSnapshotProvider({ venue, product, records, date, categorySource, volumeMetric, volumeLabel, volumeKey, turnoverMetric, turnoverLabel, previous }) {
  const map = new Map();
  const pointBase = { date: monthStart(date), asOfDate: date, collectedAt: new Date().toISOString(), isSnapshot: true, isComplete: false };
  const dimensions = [
    ["category", aggregateSnapshot(records, "category", volumeKey), aggregateSnapshot(records, "category", "oi")],
    ["instrument", topSnapshotRecords(records, "score"), null],
  ];
  for (const [dimension, volumeRows, oiRows] of dimensions) {
    const normalizedVolume = dimension === "instrument" ? volumeRows.map((row) => ({ label: row.instrument, value: row[volumeKey] })) : volumeRows;
    const normalizedOi = dimension === "instrument" ? volumeRows.map((row) => ({ label: row.instrument, value: row.oi })) : oiRows;
    for (const row of normalizedVolume) {
      upsertPoint(map, {
        venue, product, dimension, group: row.label, metric: volumeMetric, metricLabel: volumeLabel, unit: "usd",
        quality: "observed", classificationSource: categorySource,
        definition: `${volumeLabel} at refresh time, grouped by ${dimension === "category" ? "category" : "market"}. This is a rolling/snapshot activity measure, not calendar-month volume.`,
      }, { ...pointBase, value: asNumber(row.value) });
    }
    for (const row of normalizedOi) {
      upsertPoint(map, {
        venue, product, dimension, group: row.label, metric: "oiSnapshot", metricLabel: "Open-interest snapshot", unit: "usd",
        quality: "observed", classificationSource: categorySource,
        definition: `Current open-interest notional grouped by ${dimension === "category" ? "category" : "market"}; monthly points are latest collected snapshots, not historical month-end reconstruction.`,
      }, { ...pointBase, value: asNumber(row.value) });
    }
  }
  addTurnoverSeries(map, venue, product, volumeMetric, "oiSnapshot", turnoverMetric, turnoverLabel);

  const current = [...map.values()];
  if (!previous?.series?.length) return { series: current };
  const merged = new Map(current.map((item) => [[item.venue, item.dimension, item.metric, item.group].join("::"), item]));
  for (const old of previous.series) {
    if (old.dimension !== "category") continue;
    const key = [old.venue, old.dimension, old.metric, old.group].join("::");
    const next = merged.get(key);
    if (!next) {
      merged.set(key, old);
      continue;
    }
    next.points = [...old.points.filter((point) => point.date !== pointBase.date), ...next.points].sort((left, right) => left.date.localeCompare(right.date));
  }
  return { series: [...merged.values()] };
}

function polymarketCategory(event) {
  const tags = (event.tags ?? []).map((tag) => typeof tag === "string" ? tag : tag.label ?? tag.slug).filter(Boolean);
  const normalized = tags.map((tag) => String(tag).toLowerCase());
  const priorities = [
    ["sports", "Sports"], ["politics", "Politics"], ["elections", "Elections"], ["crypto", "Crypto"],
    ["economics", "Economics"], ["business", "Companies"], ["finance", "Financials"], ["technology", "Science and technology"],
    ["science", "Science and technology"], ["weather", "Climate and weather"], ["climate", "Climate and weather"],
    ["entertainment", "Entertainment"], ["culture", "Entertainment"], ["health", "Health"], ["world", "World"],
  ];
  for (const [needle, label] of priorities) if (normalized.some((tag) => tag.includes(needle))) return label;
  return tags[0] || "Unclassified";
}

async function fetchKalshiPerps() {
  const url = "https://external-api.kalshi.com/trade-api/v2/margin/markets";
  const payload = await fetchJson(url);
  const markets = (payload.markets ?? []).filter((market) => asNumber(market.volume_notional_value_dollars) > 0 || market.status === "active");
  const startTs = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
  const endTs = Math.floor(Date.now() / 1000);
  const results = await mapLimit(markets, 5, async (market) => {
    const endpoint = new URL(`https://external-api.kalshi.com/trade-api/v2/margin/markets/${encodeURIComponent(market.ticker)}/candlesticks`);
    endpoint.search = new URLSearchParams({ start_ts: String(startTs), end_ts: String(endTs), period_interval: "1440" });
    const candles = await fetchJson(endpoint);
    return { market, candles: candles.candlesticks ?? [] };
  });
  const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (!fulfilled.length) throw new Error("No Kalshi perps candles could be retrieved");
  return { marketsWithCandles: fulfilled, failedMarkets: results.filter((result) => result.status === "rejected").length };
}

async function fetchKalshiPredictionRecords() {
  const events = [];
  let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const url = new URL("https://api.elections.kalshi.com/trade-api/v2/events");
    url.search = new URLSearchParams({ limit: "200", status: "open", with_nested_markets: "true", ...(cursor ? { cursor } : {}) });
    const payload = await fetchJson(url);
    events.push(...(payload.events ?? []));
    cursor = payload.cursor ?? "";
    if (!cursor) break;
  }
  if (!events.length) throw new Error("No open Kalshi prediction events returned");
  return events.map((event) => {
    const markets = event.markets ?? [];
    const volume24h = markets.reduce((sum, market) => sum + asNumber(market.volume_24h_fp), 0);
    const oi = markets.reduce((sum, market) => sum + asNumber(market.open_interest_fp), 0);
    return {
      category: event.category || "Unclassified",
      instrument: event.title || event.event_ticker,
      volume24h,
      oi,
      score: volume24h + oi,
    };
  });
}

function polymarketFlag(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
}

export async function fetchPolymarketRecords(fetcher = fetchJson) {
  const events = new Map();
  const seenCursors = new Set();
  let afterCursor = "";
  let finished = false;
  for (let pageNumber = 0; pageNumber < 500; pageNumber += 1) {
    const url = new URL("https://gamma-api.polymarket.com/events/keyset");
    url.search = new URLSearchParams({
      limit: "100",
      active: "true",
      closed: "false",
      ...(afterCursor ? { after_cursor: afterCursor } : {}),
    });
    const payload = await fetcher(url);
    if (!payload || !Array.isArray(payload.events)) throw new Error("Invalid Polymarket keyset events response");
    for (const event of payload.events) {
      if (polymarketFlag(event.active) !== true || polymarketFlag(event.closed) === true) continue;
      const key = String(event.id ?? event.slug ?? event.event_ticker ?? "");
      if (!key) throw new Error("Polymarket keyset event omitted its identifier");
      events.set(key, event);
    }
    const nextCursor = typeof payload.next_cursor === "string" ? payload.next_cursor : "";
    if (!nextCursor) {
      finished = true;
      break;
    }
    if (nextCursor === afterCursor || seenCursors.has(nextCursor)) throw new Error("Polymarket keyset pagination repeated a cursor");
    seenCursors.add(nextCursor);
    afterCursor = nextCursor;
  }
  if (!finished) throw new Error("Polymarket keyset pagination exceeded 500 pages");
  if (!events.size) throw new Error("No active Polymarket events returned");
  return [...events.values()].map((event) => {
    const volume24h = asNumber(event.volume24hr);
    const volume30d = asNumber(event.volume1mo);
    const oi = asNumber(event.openInterest);
    return {
      category: polymarketCategory(event),
      instrument: event.title || event.slug || event.id,
      volume24h,
      volume30d,
      oi,
      score: volume30d + oi,
    };
  });
}

function buildPolymarketHistorical(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    upsertPoint(map, {
      venue: "Polymarket", product: "Prediction markets", dimension: "category", group: row.label,
      metric: "monthlyVolumeApprox", metricLabel: "Monthly volume (weekly buckets)", unit: "usd", quality: "proxy",
      classificationSource: "Dune community category columns",
      definition: "Sum of weekly category-volume observations assigned to the calendar month containing each week's start. Weeks crossing month boundaries are not split, so this is not exact calendar-month volume.",
    }, {
      date: monthStart(row.month_start), value: asNumber(row.volume_usd), observedWeeks: asNumber(row.weekly_observations), isComplete: true,
    });
  }
  return [...map.values()];
}

function venueCatalog(providers) {
  const configs = [
    {
      id: "hyperliquid", label: "Hyperliquid", product: "Native + HIP-3 perpetuals", defaultDimension: "assetClass", defaultMetric: "monthlyVolume",
      dimensions: [{ id: "assetClass", label: "Asset class" }, { id: "operator", label: "Operator / deployer" }, { id: "instrument", label: "Underlying" }],
      qualityVolumeMetric: "monthlyVolume", qualityOiMetric: "averageOi", coverageNote: `${providers.hyperliquid?.coverageNote ?? ""} Monthly historical composition last refreshed ${providers.hyperliquid?.refreshedAt?.slice(0, 10) ?? "unknown"}. Official rolling 24h volume and OI snapshots are separate metrics; latest successful collection ${providers.hyperliquidLive?.refreshedAt?.slice(0, 10) ?? "unavailable"}.`,
    },
    {
      id: "kalshi-perps", label: "Kalshi Perps", product: "Perpetual futures", defaultDimension: "assetClass", defaultMetric: "monthlyVolume",
      dimensions: [{ id: "assetClass", label: "Asset class" }, { id: "instrument", label: "Underlying" }],
      qualityVolumeMetric: "monthlyVolume", qualityOiMetric: "averageOi", coverageNote: providers.kalshiPerps?.coverageNote,
    },
    {
      id: "kalshi-predictions", label: "Kalshi Predictions", product: "Event contracts", defaultDimension: "category", defaultMetric: "volume24h",
      dimensions: [{ id: "category", label: "Category" }, { id: "instrument", label: "Market" }],
      qualityVolumeMetric: "volume24h", qualityOiMetric: "oiSnapshot", coverageNote: "Current 24h volume and OI snapshots; category history accumulates from this dashboard's collection date.",
    },
    {
      id: "polymarket", label: "Polymarket", product: "Prediction markets", defaultDimension: "category", defaultMetric: "volume30d",
      dimensions: [{ id: "category", label: "Category" }, { id: "instrument", label: "Market" }],
      qualityVolumeMetric: "volume30d", qualityOiMetric: "oiSnapshot", coverageNote: "Rolling 30d volume and OI snapshots accumulate forward. Dune category history is weekly-bucket volume from Mar 2025 to Mar 2026.",
    },
  ];
  const allSeries = Object.values(providers).flatMap((provider) => provider?.series ?? []);
  return configs.flatMap((config) => {
    const label = config.label;
    const metrics = [...new Map(allSeries.filter((item) => item.venue === label).map((item) => [item.metric, {
      id: item.metric, label: item.metricLabel, unit: item.unit,
    }])).values()];
    return metrics.length ? [{ ...config, metrics }] : [];
  });
}

export async function buildCompositionData({ generatedAt, today, completeThrough, btcDailyPrices, hyperliquidVolume, hyperliquidOi }) {
  await mkdir(NORMALIZED_DIR, { recursive: true });
  const previous = await readJsonIfExists(CACHE_FILE) ?? { datasets: {}, providers: {} };
  const datasets = { ...(previous.datasets ?? {}) };
  const providers = { ...(previous.providers ?? {}) };
  const warnings = [];
  let duneRefreshedAt = previous.duneRefreshedAt ?? previous.generatedAt ?? null;
  let hyperliquidLiveRefreshedAt = previous.hyperliquidLiveRefreshedAt ?? providers.hyperliquidLive?.refreshedAt ?? null;

  const duneTasks = [
    ["hyperliquidVolume", HYPERLIQUID_VOLUME_SQL],
    ["hyperliquidOi", HYPERLIQUID_OI_SQL],
    ["polymarketCategories", POLYMARKET_CATEGORY_SQL],
  ];
  const hasDuneCache = duneTasks.every(([key]) => Array.isArray(datasets[key]) && datasets[key].length > 0);
  const duneCacheAge = duneRefreshedAt ? Date.parse(generatedAt) - Date.parse(duneRefreshedAt) : Infinity;
  if (!hasDuneCache || !Number.isFinite(duneCacheAge) || duneCacheAge >= 12 * 60 * 60_000) {
    if (SKIP_DUNE) {
      warnings.push("Dune refresh skipped by configuration; cached composition retained.");
    } else {
      const duneResults = await Promise.allSettled(duneTasks.map(([, sql]) => runDuneSql(sql)));
      let completeDuneRefresh = true;
      duneResults.forEach((result, index) => {
        const key = duneTasks[index][0];
        if (result.status === "fulfilled" && result.value.length) datasets[key] = result.value;
        else {
          completeDuneRefresh = false;
          warnings.push(`${key} refresh failed; cached composition retained${result.status === "rejected" ? ` (${result.reason.message})` : ""}.`);
        }
      });
      if (completeDuneRefresh) duneRefreshedAt = generatedAt;
    }
  }

  try {
    providers.hyperliquid = {
      ...buildHyperliquidProvider({
      volumeRows: datasets.hyperliquidVolume,
      oiRows: datasets.hyperliquidOi,
      platformVolume: hyperliquidVolume,
      platformOi: hyperliquidOi,
      completeThrough,
      }),
      refreshedAt: duneRefreshedAt,
    };
  } catch (error) {
    warnings.push(`Hyperliquid composition unavailable: ${error.message}`);
  }

  try {
    const records = await fetchHyperliquidLiveSnapshot();
    providers.hyperliquidLive = {
      ...buildHyperliquidLiveProvider({ records, date: today, collectedAt: generatedAt, previous: providers.hyperliquidLive }),
      coverageNote: "Official rolling 24h volume and OI snapshots collected across Core and every perp DEX reported by Hyperliquid.",
      refreshedAt: generatedAt,
    };
    hyperliquidLiveRefreshedAt = generatedAt;
  } catch (error) {
    warnings.push(`Hyperliquid official live composition refresh failed; cached live snapshot retained (${errorDetails(error)}).`);
  }

  try {
    const kalshiPerps = await fetchKalshiPerps();
    providers.kalshiPerps = {
      ...buildKalshiPerpsProvider(kalshiPerps.marketsWithCandles, completeThrough),
      refreshedAt: generatedAt,
    };
    if (kalshiPerps.failedMarkets) warnings.push(`${kalshiPerps.failedMarkets} Kalshi perp candle feeds failed; available markets were retained.`);
  } catch (error) {
    warnings.push(`Kalshi perps refresh failed; cached composition retained (${error.message}).`);
  }

  try {
    const records = await fetchKalshiPredictionRecords();
    providers.kalshiPredictions = {
      ...buildSnapshotProvider({
        venue: "Kalshi Predictions", product: "Event contracts", records, date: today,
        categorySource: "Kalshi official event category", volumeMetric: "volume24h", volumeLabel: "24h contract volume",
        volumeKey: "volume24h", turnoverMetric: "turnover24h", turnoverLabel: "24h volume / OI",
        previous: providers.kalshiPredictions,
      }),
      coverageNote: "Current 24h contract volume and OI snapshots; collected twice daily while the dashboard runner is active.",
      refreshedAt: generatedAt,
    };
  } catch (error) {
    warnings.push(`Kalshi prediction composition refresh failed; cached snapshots retained (${error.message}).`);
  }

  try {
    const records = await fetchPolymarketRecords();
    const current = buildSnapshotProvider({
      venue: "Polymarket", product: "Prediction markets", records, date: today,
      categorySource: "Derived from Polymarket Gamma event tags", volumeMetric: "volume30d", volumeLabel: "Rolling 30d volume",
      volumeKey: "volume30d", turnoverMetric: "turnover30d", turnoverLabel: "30d volume / OI",
      previous: providers.polymarket,
    });
    const historical = buildPolymarketHistorical(datasets.polymarketCategories);
    const currentKeys = new Set(current.series.map((item) => item.id));
    providers.polymarket = {
      series: [...current.series, ...historical.filter((item) => !currentKeys.has(item.id))],
      coverageNote: "Rolling 30d volume and OI are current snapshots. Historical category volume uses weekly Dune buckets assigned by week-start month.",
      refreshedAt: generatedAt,
    };
  } catch (error) {
    warnings.push(`Polymarket composition refresh failed; cached snapshots retained (${errorDetails(error)}).`);
  }

  const rawSeries = Object.values(providers).flatMap((provider) => provider?.series ?? []);
  const series = finalizeCompositionSeries(rawSeries, btcDailyPrices);
  const venues = venueCatalog(providers);
  const cache = { generatedAt, duneRefreshedAt, hyperliquidLiveRefreshedAt, datasets, providers };
  await writeAtomic(CACHE_FILE, `${JSON.stringify(cache)}\n`);

  return {
    meta: {
      generatedAt,
      duneRefreshedAt,
      hyperliquidLiveRefreshedAt,
      methodology: "Measured values remain separate from classifications. Unknown labels stay Unclassified; turnover is a screening signal, not proof of inflated activity.",
      warnings,
    },
    venues,
    series,
    sources: [
      {
        key: "hyperliquidCompositionVolume", publisher: "21Shares Research / Hyperliquid", title: "Hyperliquid daily per-market volume backbone",
        page: "https://dune.com", api: "dune.\"21sharesresearch\".dataset_hyperliquid_volume_backbone_full", retrievedAt: duneRefreshedAt ?? generatedAt,
        reportedFrequency: "Daily", upstreamSources: ["Hyperliquid official API"],
        body: "Per-market base volume converted to estimated USD by 21Shares Research. Activity Atlas uses classification shares and reconciles each month to its platform-level Hyperliquid volume.",
      },
      {
        key: "hyperliquidCompositionOi", publisher: "21Shares Research / Hyperliquid", title: "Hyperliquid daily per-market open interest history",
        page: "https://dune.com", api: "dune.\"21sharesresearch\".dataset_hyperliquid_oi_history", retrievedAt: duneRefreshedAt ?? generatedAt,
        reportedFrequency: "Daily", upstreamSources: ["Hyperliquid official metaAndAssetCtxs"],
        body: "Per-market USD OI with venue, builder and sector classifications. Month-end composition is reconciled to Activity Atlas's platform-level Hyperliquid OI series.",
      },
      ...(providers.hyperliquidLive?.series?.length ? [{
        key: "hyperliquidOfficialLiveComposition", publisher: "Hyperliquid", title: "Hyperliquid official live per-market composition",
        page: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint", api: HYPERLIQUID_INFO_URL,
        retrievedAt: providerRetrievedAt(providers.hyperliquidLive, hyperliquidLiveRefreshedAt ?? generatedAt),
        reportedFrequency: "At each dashboard refresh", upstreamSources: [],
        body: "Official Core and HIP-3 metaAndAssetCtxs plus perpConciseAnnotations. Rolling 24h volume uses dayNtlVlm; OI uses openInterest × markPx. Values are nominal USD-equivalent for chart compatibility. Official collateralToken IDs are retained on points; no cross-collateral FX conversion is applied.",
      }] : []),
      {
        key: "kalshiPerpsComposition", publisher: "Kalshi", title: "Kalshi perpetual-futures markets and daily candles",
        page: "https://docs.kalshi.com/margin.md", api: "https://external-api.kalshi.com/trade-api/v2/margin/markets", retrievedAt: providerRetrievedAt(providers.kalshiPerps, generatedAt),
        reportedFrequency: "Daily candles + live snapshots", upstreamSources: [],
        body: "Official one-sided notional volume and OI for public margin/perpetual markets, grouped by official asset_class and ticker.",
      },
      {
        key: "kalshiPredictionComposition", publisher: "Kalshi", title: "Kalshi open event and market snapshots",
        page: "https://docs.kalshi.com/api-reference/events/get-events", api: "https://api.elections.kalshi.com/trade-api/v2/events", retrievedAt: providerRetrievedAt(providers.kalshiPredictions, generatedAt),
        reportedFrequency: "Twice-daily collection", upstreamSources: [],
        body: "Open-event categories with nested market 24h volume and open interest. Contract volume uses the platform's $1 payout-notional convention.",
      },
      {
        key: "polymarketComposition", publisher: "Polymarket / Dune community", title: "Polymarket Gamma snapshots and weekly category history",
        page: "https://docs.polymarket.com/market-data/discover-markets", api: "https://gamma-api.polymarket.com/events/keyset", retrievedAt: providerRetrievedAt(providers.polymarket, duneRefreshedAt ?? generatedAt),
        reportedFrequency: "Live snapshots; weekly historical buckets", upstreamSources: ["dune.jjhatch3.dataset_polymarket_volume_by_cat"],
        body: "Current event OI and rolling volume are grouped through deterministic tag classification. Historical category volume is a community weekly series; weeks are assigned to the month of their start date.",
      },
    ],
  };
}
