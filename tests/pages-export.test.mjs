import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("GitHub Pages export contains app, repository paths and downloads", async () => {
  const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "/activity-atlas";
  const basePath = `/${configuredBasePath.trim().replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");
  const assetBase = basePath ? `${basePath}/assets/` : "/assets/";
  const html = await readFile(new URL("../dist/pages/index.html", import.meta.url), "utf8");
  assert.match(html, /Activity Atlas/);
  assert.ok(html.includes(assetBase), `expected HTML asset path to include ${assetBase}`);
  const assets = await readdir(new URL("../dist/pages/assets/", import.meta.url));
  const script = assets.find((file) => file.endsWith(".js"));
  assert.ok(script);
  const javascript = await readFile(new URL(`../dist/pages/assets/${script}`, import.meta.url), "utf8");
  assert.ok(javascript.includes(basePath || "/"));
  assert.ok(javascript.includes("/data/activity-data.json"));
  assert.ok(javascript.includes("/data/activity-series.csv"));
  await access(new URL("../dist/pages/data/activity-data.json", import.meta.url));
  await access(new URL("../dist/pages/data/activity-series.csv", import.meta.url));
});
