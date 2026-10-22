import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { nextParisRefresh, PARIS_TIME_ZONE } from "../lib/refresh-schedule.mjs";

const ROOT = process.cwd();
const SNAPSHOT = path.join(ROOT, "public", "data", "activity-data.json");
const REFRESH_SCRIPT = path.join(ROOT, "scripts", "fetch-data.mjs");
const serverScript = process.argv[2] ?? "dev:server";
const refreshTimeoutMs = 5 * 60_000;

let activeRefresh = null;
let activeRefreshChild = null;
let scheduleTimer = null;
let server = null;
let shuttingDown = false;

function log(message) {
  console.log(`[activity-atlas ${new Date().toISOString()}] ${message}`);
}

function runRefresh(reason) {
  if (activeRefresh) {
    log(`${reason} refresh skipped; another refresh is still running`);
    return activeRefresh;
  }
  activeRefresh = new Promise((resolve, reject) => {
    log(`${reason} refresh started`);
    const child = spawn(process.execPath, [REFRESH_SCRIPT], { cwd: ROOT, stdio: "inherit" });
    activeRefreshChild = child;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`refresh exceeded ${refreshTimeoutMs / 60_000} minutes`));
    }, refreshTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      activeRefreshChild = null;
      if (code === 0) {
        log(`${reason} refresh completed`);
        resolve();
      } else {
        reject(new Error(`refresh exited ${signal ? `on ${signal}` : `with code ${code}`}`));
      }
    });
  }).finally(() => {
    activeRefresh = null;
  });
  return activeRefresh;
}

function spawnServer() {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? spawn(process.execPath, [npmCli, "run", serverScript], { cwd: ROOT, stdio: "inherit" })
    : spawn("npm", ["run", serverScript], { cwd: ROOT, stdio: "inherit" });
}

function scheduleNextRefresh() {
  if (shuttingDown) return;
  const nextRun = nextParisRefresh();
  const delay = Math.max(0, nextRun.getTime() - Date.now());
  log(`next refresh: ${nextRun.toISOString()} (${PARIS_TIME_ZONE} 08:00/16:00)`);
  scheduleTimer = setTimeout(async () => {
    try {
      await runRefresh("scheduled");
    } catch (error) {
      console.error(`[activity-atlas] scheduled refresh failed; keeping last valid snapshot: ${error.message}`);
    } finally {
      scheduleNextRefresh();
    }
  }, delay);
}

async function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (scheduleTimer) clearTimeout(scheduleTimer);
  activeRefreshChild?.kill(signal);
  server?.kill(signal);
}

async function main() {
  try {
    await runRefresh("startup");
  } catch (error) {
    try {
      await access(SNAPSHOT);
      console.error(`[activity-atlas] startup refresh failed; serving last valid snapshot: ${error.message}`);
    } catch {
      throw new Error(`startup refresh failed and no prior snapshot exists: ${error.message}`);
    }
  }
  if (shuttingDown) return;

  server = spawnServer();
  server.once("error", (error) => {
    console.error(`[activity-atlas] server failed to start: ${error.message}`);
    shuttingDown = true;
    if (scheduleTimer) clearTimeout(scheduleTimer);
    process.exitCode = 1;
  });
  server.once("exit", (code, signal) => {
    if (scheduleTimer) clearTimeout(scheduleTimer);
    if (!shuttingDown) {
      shuttingDown = true;
      console.error(`[activity-atlas] server stopped ${signal ? `on ${signal}` : `with code ${code}`}`);
      process.exitCode = code ?? 1;
    }
  });
  scheduleNextRefresh();
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

main().catch((error) => {
  console.error(`[activity-atlas] ${error.message}`);
  process.exitCode = 1;
});
