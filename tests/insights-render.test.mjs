// Render the real insight components with the published data file.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { completeComparison } from "../lib/activity-insights.mjs";

const data = JSON.parse(await readFile(new URL("../public/data/activity-data.json", import.meta.url), "utf8"));
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true, hmr: false, watch: null },
  plugins: [react()],
});
after(() => server.close());
const { Breakdown, DataHealth, Overview, Relationships } = await server.ssrLoadModule("/app/insights.tsx");
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const decode = (html) => html.replaceAll("&amp;", "&").replaceAll("&#x27;", "'");
const noop = () => undefined;

function relationships(metric, period = {}) {
  const overview = completeComparison(data.series, metric, data.meta.completeThrough, period);
  return { overview, html: decode(render(Relationships, { data, metric, overview, setPeriod: noop, controls: null })) };
}

test("default two-month selection withholds all three coefficients and offers an explicit extension", () => {
  for (const metric of ["volume", "oi"]) {
    const { html } = relationships(metric);
    assert.equal(html.match(/Choose a longer period/g)?.length, 3, metric);
    assert.equal(html.match(/1 monthly change<\/b>/g)?.length, 3, metric);
    assert.match(html, /1 of 6 changes needed/);
    assert.match(html, /display guard, not a significance test/);
    assert.match(html, /Extend the overview period:/);
    assert.match(html, /Full overlap \(/);
    assert.doesNotMatch(html, /role="img"[^>]*Correlation [-0-9]/, `${metric} must show no coefficient`);
    const primary = html.replace(/<details[\s\S]*?<\/details>/g, "");
    assert.doesNotMatch(primary, /coefficient|withheld/i, `${metric} keeps that wording in exact statistics and methodology`);
  }
});

test("changes with no variation get a plain heading rather than a coefficient", () => {
  const dates = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01"];
  const series = ["cex", "dex", "prediction"].map((category) => ({ id: `category-${category}-oi`, category, metric: "oi", venue: category, points: dates.map((date) => ({ date, value: 100, isComplete: true })) }));
  const flat = { series, meta: { completeThrough: "2026-08" }, correlations: { oi: { coverageStart: "2026-01", method: "Test method." } } };
  const overview = completeComparison(series, "oi", "2026-08", { start: dates[0], end: dates.at(-1) });
  const html = decode(render(Relationships, { data: flat, metric: "oi", overview, setPeriod: noop, controls: null }));
  assert.equal(html.match(/No variation to compare/g)?.length, 3);
  assert.equal(html.match(/7 monthly changes<\/b>/g)?.length, 3);
  assert.match(html, /These changes do not vary enough to compare/);
  assert.doesNotMatch(html, /Choose a longer period/);
  assert.doesNotMatch(html.replace(/<details[\s\S]*?<\/details>/g, ""), /coefficient|withheld/i);
});

test("an extended selection shows coefficients with exact counts, dates and separate size", () => {
  const { overview } = relationships("oi");
  const start = overview.dates[0];
  const { html, overview: extended } = relationships("oi", { start, end: overview.end });
  const expected = extended.dates.filter((date) => date >= start && date <= overview.end).length - 1;
  assert.equal(html.match(new RegExp(`${expected} monthly changes</b>`, "g"))?.length, 3);
  assert.match(html, /Open interest · /);
  assert.match(html, /Hyperliquid/);
  assert.match(html, /Size is separate: CEX \$[\d.]+[BTM] · Hyperliquid \$[\d.]+[BTM] in /);
  assert.match(html, /on a −1 to \+1 scale/);
  assert.match(html, /similar size/);
  assert.match(html, /Changes into: /);
  assert.doesNotMatch(html, /Choose a longer period|No variation to compare/);
  assert.doesNotMatch(html, /open.position/i);
  assert.doesNotMatch(html, /causes? (the|one) .* to (rise|grow)/i);
});

test("a selected month the metric lacks stays visible in the overview selector", () => {
  const start = "2024-08-01";
  const result = completeComparison(data.series, "oi", data.meta.completeThrough, { start });
  assert.deepEqual(result.rows, []);
  const html = render(Overview, { data, onExplore: noop, metric: "oi", setMetric: noop, result, setStart: noop, setEnd: noop, onReset: noop });
  assert.match(html, /<option value="2024-08-01" selected="">Aug 2024 · unavailable<\/option>/);
  assert.match(html, /Matching complete months are unavailable/);
});

test("the recap discloses that Coinbase is excluded, in both metrics", () => {
  for (const metric of ["volume", "oi"]) {
    const result = completeComparison(data.series, metric, data.meta.completeThrough);
    const html = decode(render(Overview, { data, onExplore: noop, metric, setMetric: noop, result, setStart: noop, setEnd: noop, onReset: noop }));
    assert.match(html, /Coinbase excluded/, metric);
    assert.match(html, /Coinbase International is excluded and stays in its own drilldown/, metric);
    assert.match(html, metric === "volume" ? /Binance perpetuals \+ Bybit & Kraken total futures/ : /BTC \+ ETH futures only/);
  }
});

test("Breakdown shows the recovered October individual-asset snapshot with its collection and window", () => {
  const html = decode(render(Breakdown, { data, initialState: { selectedDate: "2026-10-01", dimensionId: "instrument" } }));
  assert.match(html, /Collected Oct 31, 2026, 15:52 UTC/);
  assert.match(html, /rolling 24-hour trading and open interest at collection/);
  assert.match(html, /It is not a total for Oct 2026/);
  assert.match(html, /<option value="snapshot" selected="">Collected snapshot<\/option>/);
  assert.match(html, /<option value="monthEndOi">Month-end open interest<\/option>/);
  assert.doesNotMatch(html, /<option value="month">/);
  assert.match(html, /<option value="2026-10-01" selected="">Oct 2026 · collected Oct 31<\/option>/);
  assert.doesNotMatch(html, /open.position/i);
});

test("Breakdown keeps an unsupported month selected and explains it rather than jumping", () => {
  const html = decode(render(Breakdown, { data, initialState: { venueId: "polymarket", view: "month", selectedDate: "2026-08-01" } }));
  assert.match(html, /<option value="2026-08-01" disabled="" selected="">Aug 2026 · unavailable<\/option>/);
  assert.match(html, /Polymarket has no usable collected snapshot for Aug 2026\. Latest available: /);
  assert.doesNotMatch(html, /aria-label="View"/);
  assert.match(html, /Use latest available month/);
});

test("a month with an unmatched segment is withheld and names that segment", () => {
  const html = decode(render(Breakdown, { data, initialState: { view: "month", selectedDate: "2026-08-01" } }));
  assert.match(html, /<option value="2026-08-01" disabled="" selected="">Aug 2026 · unavailable<\/option>/);
  assert.match(html, /Some segments lack a matching measurement \(no trading measurement: Pre-IPO \/ private\)/);
  assert.match(html, /Full calendar month unavailable for this selection/);
});

test("Breakdown keeps each platform's real window and unit", () => {
  const predictions = decode(render(Breakdown, { data, initialState: { venueId: "kalshi-predictions" } }));
  assert.match(predictions, /rolling 24-hour trading/);
  assert.match(predictions, /Contract counts, not USD/);
  assert.match(predictions, /contracts<\/b>/);
  assert.doesNotMatch(predictions, /\$\d/);
  assert.match(decode(render(Breakdown, { data, initialState: { venueId: "polymarket" } })), /rolling 30-day trading/);
  const perps = decode(render(Breakdown, { data, initialState: { venueId: "kalshi-perps" } }));
  assert.match(perps, /Full calendar month: /);
  assert.match(perps, /daily-average open interest/);
  assert.doesNotMatch(perps, /aria-label="View"/);
});

test("the freshness panel separates check time, cutoff and complete month, and includes Coinbase volume", () => {
  const html = decode(render(DataHealth, { data }));
  assert.match(html, /Binance \+ Bybit \+ Kraken · trading/);
  assert.match(html, /Coinbase International · trading/);
  assert.match(html, /Coinbase International · open interest/);
  assert.match(html, /Last checked: /);
  assert.match(html, /Verified observation cutoff: unknown/);
  assert.match(html, /Cutoff unknown/);
  assert.match(html, /Latest complete month: /);
  assert.match(html, /Retained, not new: /);
  assert.match(html, /Hyperliquid · month-end open interest \(Ironflow\)/);
});

test("Hyperliquid month-end archive has distinct OI-only coverage for September and October", () => {
  for (const [date, label, total] of [["2026-09-01", "Sep", 8.376], ["2026-10-01", "Oct", 7.453]]) {
    const html = decode(render(Breakdown, { data, initialState: { view: "monthEndOi", dimensionId: "instrument", selectedDate: date } }));
    assert.match(html, new RegExp("Month-end open interest: " + label + " 2026"));
    assert.match(html, /Trading volume is not part of this view/);
    assert.doesNotMatch(html, /Trading share|Trading ÷ OI/);
    for (const dimension of ["assetClass", "operator", "instrument"]) {
      const sum = data.composition.series.filter((item) => item.venue === "Hyperliquid" && item.dimension === dimension && item.metric === "archiveMonthEndOi")
        .reduce((value, item) => value + (item.points.find((point) => point.date === date)?.value ?? 0), 0);
      assert.ok(Math.abs(sum / 1e9 - total) < .001, `${dimension} ${date}: ${sum}`);
    }
  }
});

test("October overview identifies PaperTrade and Hyperliquid separately and keeps the ruler visible", () => {
  const metric = "volume";
  const result = completeComparison(data.series, metric, data.meta.completeThrough, { start: "2026-09-01", end: "2026-10-01" });
  const html = decode(render(Overview, { data, onExplore: noop, metric, setMetric: noop, result, setStart: noop, setEnd: noop, onReset: noop }));
  assert.match(html, /<div class="comparison-timeline" role="group"/);
  assert.match(html, /PaperTrade<small>Separate protocol<\/small><\/dt><dd><b>\$[\d.]+T<\/b><small>[\d.]+% of covered DEX volume/);
  assert.match(html, /Hyperliquid<\/dt><dd><b>\$[\d.]+B<\/b><small>[\d.]+% of covered CEX volume/);
});
