/** Stages that must succeed before the site may change, in run order. */
export const WORKFLOW_STAGES = [
  { id: "refresh", label: "Refresh public data" },
  { id: "lint", label: "Lint" },
  { id: "test", label: "Tests" },
  { id: "pages", label: "GitHub Pages build and export test" },
  { id: "persist", label: "Persist collected snapshots" },
  { id: "artifact", label: "Pages artifact upload" },
];

/** Decide the run result from step outcomes. A skipped stage does not count as
 * passing, so a green result requires every stage to have actually succeeded.
 * @param {Record<string, string | undefined>} outcomes
 */
export function workflowResult(outcomes) {
  const failed = WORKFLOW_STAGES.find((stage) => outcomes[stage.id] !== "success");
  if (!failed) return { ok: true, stage: null, message: "All stages passed; the deploy job publishes this build." };
  return {
    ok: false,
    stage: failed.id,
    message: `${failed.label} did not pass (outcome: ${outcomes[failed.id] || "not run"}). The last good site stays online; this run is marked failed.`,
  };
}
