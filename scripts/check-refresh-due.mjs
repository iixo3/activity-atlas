import { readFile, appendFile } from "node:fs/promises";
import { nextRefresh } from "../lib/refresh-schedule.mjs";

const data = JSON.parse(await readFile("public/data/activity-data.json", "utf8"));
const last = new Date(data.meta.generatedAt);
const due = process.env.GITHUB_EVENT_NAME !== "schedule" || !Number.isFinite(last.getTime()) || nextRefresh(last) <= new Date();
console.log(due ? "Refresh due" : "This refresh window already completed; skip the full run.");
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `due=${due}\n`);
