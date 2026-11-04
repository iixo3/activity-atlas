// Restore one month's instrument snapshots from a public ancestor commit into the
// tracked continuity files, keeping original collection timestamps. Safe to rerun:
// a month that already holds the same collection is left alone, and a cohort that
// does not tie to its retained aggregate is rejected rather than merged.
//
//   node scripts/recover-instrument-snapshots.mjs <commit> <YYYY-MM>
import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import process from "node:process";
import { ARCHIVE_DESCRIPTION, restoreInstrumentSnapshot } from "./composition-data.mjs";

const [commit, month] = process.argv.slice(2);
if (!commit || !/^\d{4}-\d{2}$/.test(month ?? "")) throw new Error("Usage: recover-instrument-snapshots.mjs <commit> <YYYY-MM>");
execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"]);

const CACHE_FILE = "data/normalized/composition-cache.json";
const ARCHIVE_FILE = "data/normalized/composition-observations.json";
const PROVIDERS = [
  { key: "hyperliquidLive", aggregateDimension: "assetClass", valueMetrics: ["volume24h", "oiSnapshot"] },
  { key: "kalshiPredictions", aggregateDimension: "category", valueMetrics: ["volume24h", "oiSnapshot"] },
  { key: "polymarket", aggregateDimension: "category", valueMetrics: ["volume30d", "oiSnapshot"] },
];

async function writeAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, value);
  await rename(temporaryPath, filePath);
}

const source = JSON.parse(execFileSync("git", ["show", `${commit}:${CACHE_FILE}`], { maxBuffer: 1 << 28 }).toString());
const cache = JSON.parse(await readFile(CACHE_FILE, "utf8"));
const archive = JSON.parse(await readFile(ARCHIVE_FILE, "utf8"));
const observations = new Map(archive.observations.map((row) => [`${row.id}|${row.collectedAt}`, row]));
let changed = false;

for (const { key, aggregateDimension, valueMetrics } of PROVIDERS) {
  const result = restoreInstrumentSnapshot({
    target: cache.providers[key].series,
    source: source.providers[key].series,
    month,
    aggregateDimension,
    valueMetrics,
  });
  cache.providers[key].series = result.series;
  changed ||= result.changed;
  for (const { item, point } of result.restored) {
    observations.set(`${item.id}|${point.collectedAt}`, {
      id: item.id, venue: item.venue, dimension: item.dimension, group: item.group,
      metric: item.metric, unit: item.unit, collectedAt: point.collectedAt, asOfDate: point.asOfDate, value: point.value,
    });
  }
  console.log(`${key}: ${result.changed ? `restored ${result.restored.length} points` : "already present"} for ${month}`);
}

if (changed) {
  await writeAtomic(CACHE_FILE, `${JSON.stringify(cache)}\n`);
  await writeAtomic(ARCHIVE_FILE, `${JSON.stringify({
    description: ARCHIVE_DESCRIPTION,
    observations: [...observations.values()].sort((a, b) => a.collectedAt.localeCompare(b.collectedAt) || a.id.localeCompare(b.id)),
  })}\n`);
}
