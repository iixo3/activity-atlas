import { readFile, appendFile } from "node:fs/promises";
import { dataHealth, hyperliquidOiReconciliation } from "../lib/activity-insights.mjs";

const data = JSON.parse(await readFile("public/data/activity-data.json", "utf8"));
const rows = dataHealth(data);
const reconciliation = hyperliquidOiReconciliation(data);
const cell = (value) => String(value).replaceAll("|", "/").replaceAll("\n", " ");
const report = [
  "### Activity Atlas source health", "",
  `Published data file: ${data.meta.generatedAt}. A file timestamp is not proof of fresh source data; a successful refresh can include retained older observations.`, "",
  "| Feed | Last checked | Last retrieved | Verified observation cutoff | Latest complete month | Status | Retained because / notes |", "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((row) => `| ${cell(row.label)} | ${row.checkedAt ?? "Unknown"} | ${row.retrievedAt ?? "Unknown"} | ${row.observed ?? "Unknown"} | ${row.complete ?? "None verified"} | ${row.status} | ${cell([row.failure, row.note].filter(Boolean).join(" ") || "-")} |`), "",
  "Older historical composition is an upstream availability limit; current snapshots refresh separately.",
  ...(reconciliation ? [`Hyperliquid open interest, unresolved: vendor total ${Math.round(reconciliation.vendorValue)} USD (${reconciliation.vendorDate}) vs official snapshot sum ${Math.round(reconciliation.officialValue)} USD (${reconciliation.collectedAt}); official is ${reconciliation.ratio.toFixed(2)}x vendor. Neither is adjusted.`] : []),
  "",
].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
