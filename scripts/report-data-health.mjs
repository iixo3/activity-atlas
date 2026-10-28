import { readFile, appendFile } from "node:fs/promises";
import { dataHealth } from "../lib/activity-insights.mjs";

const data = JSON.parse(await readFile("public/data/activity-data.json", "utf8"));
const rows = dataHealth(data);
const report = [
  "### Activity Atlas source health", "",
  `Published data file: ${data.meta.generatedAt}. A successful refresh can include retained older observations.`, "",
  "| Feed | Observation | Status |", "| --- | --- | --- |",
  ...rows.map((row) => `| ${row.label} | ${row.observed ?? "Unknown"} | ${row.status} |`), "",
  "Older historical composition is an upstream availability limit; current snapshots refresh separately.", "",
].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report);
