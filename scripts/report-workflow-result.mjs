import { appendFile } from "node:fs/promises";
import process from "node:process";
import { workflowResult } from "../lib/workflow-result.mjs";

const result = workflowResult({
  refresh: process.env.REFRESH_OUTCOME,
  lint: process.env.LINT_OUTCOME,
  test: process.env.TEST_OUTCOME,
  pages: process.env.PAGES_OUTCOME,
  persist: process.env.PERSIST_OUTCOME,
  artifact: process.env.ARTIFACT_OUTCOME,
});
console.log(result.ok ? result.message : `::error title=Activity Atlas ${result.stage} failed::${result.message}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### Activity Atlas run result\n\n${result.message}\n`);
if (!result.ok) process.exitCode = 1;
