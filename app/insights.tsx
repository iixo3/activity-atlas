"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { completeComparison, compositionComparison, dataHealth, relativeHistory } from "../lib/activity-insights.mjs";
import type { DashboardData, Metric, Category } from "./page";

const COLORS = { cex: "#78a7ff", dex: "#4fd1a1", prediction: "#ff6fae" };
const LABELS = { cex: "Centralized exchanges", dex: "Onchain exchanges", prediction: "Prediction markets" };
const month = (date: string) => new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date.slice(0, 7)}-01T00:00:00Z`));
const day = (date: string) => new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(date));
const dollars = (value: number) => new Intl.NumberFormat("en", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
const signed = (value: number) => `${value > 0 ? "+" : ""}${value.toLocaleString("en", { maximumFractionDigits: 1 })}%`;
const name = (category: Category, metric: Metric) => category === "dex" && metric === "oi" ? "Hyperliquid only" : LABELS[category];
export const dimensionLabel = (dimension: { id: string; label: string }) => dimension.id === "operator" ? "Market provider"
  : dimension.id === "instrument" && dimension.label === "Underlying" ? "Individual assets" : dimension.label;
const scope = (category: Category, metric: Metric) => category === "cex"
  ? (metric === "volume" ? "Binance perpetuals + Bybit & Kraken futures" : "Binance, Bybit & Kraken · BTC + ETH futures only")
  : category === "dex" ? (metric === "volume" ? "Perpetual DEXs · all venues in our source" : "Historical DEX coverage is Hyperliquid only")
    : "Polymarket, Polymarket US & Kalshi · coverage varies over time";

function useClock() {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function Freshness({ data, refreshWarning, staleSnapshot }: { data: DashboardData; refreshWarning: boolean; staleSnapshot: boolean }) {
  const now = useClock();
  const health = dataHealth(data, now);
  const behind = health.filter((row) => row.status === "behind");
  return <div className="freshness-strip">
    <span className={behind.length || staleSnapshot || refreshWarning ? "status-dot delayed" : "status-dot"} />
    <span>{refreshWarning ? "Could not check for a newer file" : staleSnapshot ? "Scheduled refresh is overdue" : `Data file updated ${day(data.meta.generatedAt)}`}</span>
    <a href="#data-health" onClick={() => { const details = document.getElementById("data-health") as HTMLDetailsElement | null; if (details) details.open = true; }}>{behind.length ? `${behind.length} feeds behind · see source dates` : "Check source dates"} <span aria-hidden="true">↗</span></a>
    <span className="refresh-schedule">Automatic checks · 07:00 &amp; 15:00 UTC</span>
  </div>;
}

export function Overview({ data, onExplore }: { data: DashboardData; onExplore: (category: Category, metric: Metric) => void }) {
  const [metric, setMetric] = useState<Metric>("volume");
  const [start, setStart] = useState<string>();
  const [end, setEnd] = useState<string>();
  const [numerator, setNumerator] = useState<Category>("dex");
  const [denominator, setDenominator] = useState<Category>("cex");
  const result = completeComparison(data.series, metric, data.meta.completeThrough, { start, end });
  const { rows, dates } = result;
  const ordered = [...rows].filter((row) => row.change != null).sort((a, b) => b.change! - a.change!);
  const leader = ordered[0];
  const isTie = leader && ordered[1] && Math.abs(leader.change! - ordered[1].change!) < .05;
  const subject = leader?.category === "prediction" ? "Prediction-market" : leader?.category === "dex" ? (metric === "oi" ? "Hyperliquid" : "Onchain-exchange") : "Centralized-exchange";
  const headline = !leader ? "Choose two complete months." : rows.some((row) => row.change == null) ? "Some groups lack a growth baseline." : isTie ? "The leading growth rates are nearly equal."
    : leader.change! > 0 ? `${subject} ${metric === "volume" ? "volume" : "open interest"} grew fastest.`
      : leader.change === 0 ? "No covered group grew." : "Activity fell across all three groups.";
  const subline = rows.length && rows.every((row) => (row.change ?? -Infinity) > 0) ? "All three covered groups increased. Growth and size tell different stories."
    : "Compare reported size and change over the same two complete months.";
  const maximum = Math.max(1, ...rows.map((row) => Math.abs(row.change ?? 0)));
  const a = rows.find((row) => row.category === numerator);
  const b = rows.find((row) => row.category === denominator);
  const ratio = a && b && b.value > 0 ? 100 * a.value / b.value : null;
  const prior = a && b && b.before > 0 ? 100 * a.before / b.before : null;
  const ratioMaximum = Math.max(100, ratio ?? 0, prior ?? 0);
  const history = (result.start && result.end ? relativeHistory(data.series, metric, numerator, denominator, result.start, result.end) : []) as { date: string; value: number }[];
  const historyMax = Math.max(1, ...history.map((point) => point.value));
  const historyMin = Math.min(0, ...history.map((point) => point.value));
  const path = history.map((point, index) => `${index ? "L" : "M"}${8 + index / Math.max(1, history.length - 1) * 624},${94 - (point.value - historyMin) / (historyMax - historyMin) * 78}`).join(" ");
  const startIndex = Math.max(0, dates.indexOf(result.start ?? ""));
  const endIndex = Math.max(startIndex + 1, dates.indexOf(result.end ?? ""));
  const timelineDenominator = Math.max(1, dates.length - 1);
  return <section className="overview-story" id="overview" aria-labelledby="overview-title">
    <div className="overview-toolbar">
      <p className="eyebrow">The big picture <span> / </span> Complete months</p>
      <div className="segmented" role="group" aria-label="Overview metric">
        <button className={metric === "volume" ? "active" : ""} aria-pressed={metric === "volume"} onClick={() => setMetric("volume")}>Trading volume</button>
        <button className={metric === "oi" ? "active" : ""} aria-pressed={metric === "oi"} onClick={() => setMetric("oi")}>Open interest</button>
      </div>
    </div>
    <div className="story-heading">
      <p className="overview-question">{metric === "volume" ? "Where is trading growing?" : "Where is open interest growing?"}</p>
      <h1 id="overview-title">{result.end && <span className="headline-date">{month(result.end)}: </span>}{headline}</h1>
      <p>{result.start && <>Compared with {month(result.start)}. </>}{subline}</p>
    </div>
    <div className="comparison-period">
      <span>Compare</span>
      <label className="month-chip"><span className="sr-only">Comparison start month</span><select aria-label="Comparison start month" value={result.start ?? ""} onChange={(event) => setStart(event.target.value)}>{dates.filter((date) => !result.end || date < result.end).map((date) => <option key={date} value={date}>{month(date)}</option>)}</select></label>
      <span>with</span>
      <label className="month-chip"><span className="sr-only">Comparison end month</span><select aria-label="Comparison end month" value={result.end ?? ""} onChange={(event) => setEnd(event.target.value)}>{dates.filter((date) => !result.start || date > result.start).map((date) => <option key={date} value={date}>{month(date)}</option>)}</select></label>
      <button className="text-button" onClick={() => { setStart(undefined); setEnd(undefined); }}>Latest comparison ↺</button>
    </div>
    {dates.length > 1 && <details className="comparison-timeline">
      <summary>Explore another period on the timeline</summary>
      <p>Drag either handle to choose a month. We compare the two selected months, not the total between them.</p>
      <div className="month-timeline" style={{ "--range-start": `${100 * startIndex / timelineDenominator}%`, "--range-end": `${100 * endIndex / timelineDenominator}%` } as CSSProperties}>
        <div className="month-timeline-track"><i /></div>
        <input type="range" min="0" max={dates.length - 1} value={startIndex} aria-label="Timeline start month" aria-valuetext={month(dates[startIndex])} onChange={(event) => setStart(dates[Math.min(Number(event.target.value), endIndex - 1)])} />
        <input type="range" min="0" max={dates.length - 1} value={endIndex} aria-label="Timeline end month" aria-valuetext={month(dates[Math.min(endIndex, dates.length - 1)])} onChange={(event) => setEnd(dates[Math.max(Number(event.target.value), startIndex + 1)])} />
      </div>
      <div className="month-timeline-labels"><span>{month(dates[0])}</span><b>{result.start && month(result.start)} → {result.end && month(result.end)}</b><span>{month(dates.at(-1)!)}</span></div>
    </details>}
    <p className="overview-definition">{metric === "volume" ? <><b>Trading volume:</b> the reported value traded during each month.</> : <><b>Open interest:</b> the reported value of contracts still open at month-end.</>}</p>
    {!rows.length && <p className="insight-note">Matching complete months are unavailable for this selection. Choose another period; missing values are never treated as zero.</p>}
    <div className="recap-grid">
      {rows.map((row) => {
        const category = row.category as Category;
        const secondary = data.series.find((item) => item.id === `category-${category}-${metric === "volume" ? "oi" : "volume"}`)?.points.find((point) => point.date === result.end && point.isComplete !== false);
        return <article className="recap-card" key={category} style={{ "--category-color": COLORS[category] } as CSSProperties}>
          <div className="recap-title"><span className="category-dot" /><h2>{name(category, metric)}</h2><span className="recap-number">0{["cex", "dex", "prediction"].indexOf(category) + 1}</span></div>
          <p className="recap-scope">{scope(category, metric)}</p>
          <div className="recap-total"><strong className="recap-value" title={row.value.toLocaleString("en", { style: "currency", currency: "USD" })}>{dollars(row.value)}</strong><span className="measure-caption">{metric === "volume" ? "traded in" : "open interest at the end of"}<br />{month(result.end!)}</span></div>
          <div className="recap-change"><b>{row.change == null ? "No growth baseline" : signed(row.change)}</b><span>vs {month(result.start!)}</span></div>
          <div className="change-track" aria-hidden="true"><i className="change-zero" /><i className="change-fill" style={{ left: `${row.change != null && row.change < 0 ? 50 - Math.abs(row.change) / maximum * 50 : 50}%`, width: `${Math.abs(row.change ?? 0) / maximum * 50}%` }} /></div>
          <div className="change-axis"><span>Decrease</span><span>0</span><span>Increase</span></div>
          <div className="secondary-metric"><span>{metric === "volume" ? (category === "dex" ? "Open interest · Hyperliquid only" : category === "cex" ? "Open interest · BTC + ETH only" : "Open interest · month-end") : "Monthly trading volume"}</span><b>{secondary ? dollars(secondary.value) : "Unavailable"}</b></div>
          <a className="recap-link" href="#venues" onClick={() => onExplore(category, metric)} aria-label={`Explore ${LABELS[category]} ${metric === "volume" ? "trading volume" : "open interest"}`}>Explore this category <span aria-hidden="true">↘</span></a>
        </article>;
      })}
    </div>
    <p className="overview-footnote">B = billion · T = trillion. Reported activity, not money deposited. These groups cover different products; figures are not a global market-share breakdown. Partial months are excluded here.</p>
    <div className="relative-panel">
      <div className="relative-copy">
        <p className="section-kicker">Put the size in perspective</p>
        <h2>How far apart are they?</h2>
        <div className="pair-selectors">
          <label>Compare<select value={numerator} onChange={(event) => { const next = event.target.value as Category; setNumerator(next); if (next === denominator) setDenominator(numerator); }}>{(["cex", "dex", "prediction"] as Category[]).map((category) => <option key={category} value={category}>{name(category, metric)}</option>)}</select></label>
          <label>With<select value={denominator} onChange={(event) => { const next = event.target.value as Category; setDenominator(next); if (next === numerator) setNumerator(denominator); }}>{(["cex", "dex", "prediction"] as Category[]).map((category) => <option key={category} value={category}>{name(category, metric)}</option>)}</select></label>
        </div>
        <p>For every <b>$100</b> {metric === "volume" ? "traded on" : "of open interest on"} {name(denominator, metric).toLowerCase()}, {name(numerator, metric).toLowerCase()} reported:</p>
        <div className="relative-answer"><strong className="relative-value" style={{ color: COLORS[numerator] }}>{ratio == null ? "—" : `$${ratio.toLocaleString("en", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`}</strong><span>{metric === "volume" ? "of trading volume" : "of open interest"}<br />{result.end && `in ${month(result.end)}`}</span></div>
        <p className="relative-before">{prior == null ? "No matching earlier value." : `$${prior.toFixed(2)} in ${month(result.start!)} → $${ratio?.toFixed(2)} in ${month(result.end!)}`}</p>
      </div>
      <div className="relative-visual">
        <div className="reference-bar-label"><span>{name(numerator, metric)}</span><b>{ratio == null ? "—" : `$${ratio.toFixed(2)}`}</b></div>
        <div className="relative-track"><i style={{ width: `${(ratio ?? 0) / ratioMaximum * 100}%`, background: COLORS[numerator] }} /></div>
        <div className="reference-bar-label"><span>{name(denominator, metric)} · reference</span><b>$100</b></div>
        <div className="relative-track"><i style={{ width: `${100 / ratioMaximum * 100}%`, background: COLORS[denominator] }} /></div>
        {history.length > 1 && <><svg viewBox="0 0 640 104" className="ratio-history" role="img" aria-label={`Relative size from ${month(result.start!)} to ${month(result.end!)}. Dollar amount per 100 reference dollars.`}><path d={path} fill="none" stroke={COLORS[numerator]} strokeWidth="3" /><circle cx="632" cy={94 - (history.at(-1)!.value - historyMin) / (historyMax - historyMin) * 78} r="4" fill={COLORS[numerator]} /></svg><div className="ratio-axis"><span>{month(result.start!)} · ${history[0].value.toFixed(2)}</span><span>{month(result.end!)} · ${history.at(-1)!.value.toFixed(2)}</span></div></>}
        <p className="insight-note">A rising ratio means the first group grew relative to the reference—not that money moved between them. The totals and growth above show whether either group actually increased.</p>
      </div>
    </div>
  </section>;
}

export function Breakdown({ data }: { data: DashboardData }) {
  const now = useClock();
  const [venueId, setVenueId] = useState("hyperliquid");
  const [dimensionId, setDimensionId] = useState<string>();
  const [mode, setMode] = useState("current");
  const [selectedDate, setSelectedDate] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const venue = data.composition?.venues.find((item) => item.id === venueId) ?? data.composition?.venues[0];
  if (!venue || !data.composition) return null;
  const dimension = venue.dimensions.find((item) => item.id === dimensionId)?.id ?? venue.defaultDimension;
  const live = venue.id === "hyperliquid" && mode === "current";
  const volumeMetric = live ? "volume24h" : venue.qualityVolumeMetric;
  const oiMetric = live ? "oiSnapshot" : venue.qualityOiMetric;
  const result = compositionComparison(data.composition.series, venue.label, dimension, volumeMetric, oiMetric, selectedDate);
  const volumePeriod = volumeMetric === "volume24h" ? "Trading · preceding 24 hours" : volumeMetric === "volume30d" ? "Trading · preceding 30 days" : "Trading · full month";
  const interestPeriod = oiMetric === "averageOi" ? "Open interest · daily average" : "Open interest · at collection";
  const contracts = venue.id === "kalshi-predictions";
  const value = (amount: number) => contracts ? `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(amount)} contracts` : dollars(amount);
  const featured = result.rows[0];
  const isOld = result.snapshot ? !result.observedAt || Date.parse(now) - Date.parse(result.observedAt) > 3 * 86400000 : (result.date ?? "").slice(0, 7) < data.meta.completeThrough;
  return <section className="section-block breakdown-section" id="breakdown" aria-labelledby="breakdown-title">
    <div className="section-head"><div><p className="section-kicker">Look inside a platform</p><h2 id="breakdown-title">Lots of trading, little open interest?</h2><p>Compare each segment’s share of trading with its share of open interest. A difference is a clue to explore, not proof of inflated activity.</p><div className={`breakdown-context ${isOld ? "is-old" : ""}`}><b>{venue.label}</b><span>{result.snapshot ? `Collected ${result.observedAt ? day(result.observedAt) : "date unknown"}` : `Complete month: ${result.date ? month(result.date) : "unavailable"}`}</span>{isOld && <span className="older-observation">Older data · newer observations are unavailable for this view.</span>}</div></div><a className="section-jump" href="#composition">Explore the history ↗</a></div>
    <div className="breakdown-controls">
      <label>Platform<select aria-label="Platform" value={venue.id} onChange={(event) => { setVenueId(event.target.value); setDimensionId(undefined); setSelectedDate(undefined); setMode("current"); setShowAll(false); }}>{data.composition.venues.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Group by<select aria-label="Group by" value={dimension} onChange={(event) => { setDimensionId(event.target.value); setSelectedDate(undefined); setShowAll(false); }}>{venue.dimensions.map((item) => <option key={item.id} value={item.id}>{dimensionLabel(item)}</option>)}</select></label>
      {venue.id === "hyperliquid" && <label>View<select aria-label="View" value={mode} onChange={(event) => { setMode(event.target.value); setSelectedDate(undefined); }}><option value="current">Current snapshot</option><option value="historical">Complete-month history</option></select></label>}
      <label>{result.snapshot ? "Snapshot month" : "Complete month"}<select value={result.date ?? ""} onChange={(event) => setSelectedDate(event.target.value)}>{result.dates.map((date) => <option key={date} value={date}>{month(date)}</option>)}</select></label>
      {dimension === "operator" && <p className="group-help">Market provider = who lists the contract. This may differ from the issuer of the underlying asset.</p>}
    </div>
    {!result.rows.length ? <p className="insight-note">{result.reason}</p> : <>
      <div className="breakdown-reading"><p><b>{featured.group}</b> accounts for <strong>{featured.volumeShare.toFixed(1)}%</strong> of trading and <strong>{featured.oiShare.toFixed(1)}%</strong> of open interest.</p><span>Largest share difference in this breakdown. Short holding periods or contract settlement can also create a gap.</span></div>
      <div className="share-key"><span><i className="trading-key" />{volumePeriod} <b>{value(result.volumeTotal)}</b></span><span><i className="interest-key" />{interestPeriod} <b>{value(result.oiTotal)}</b></span><small>Each bar runs from 0% to 100% of its own total.</small></div>
      <div className="share-rows">{(showAll ? result.rows : result.rows.slice(0, 6)).map((row) => <div className="share-row" key={row.group}><b>{row.group}</b><div className="paired-bars"><div><span className="sr-only">Trading share</span><i className="trading-fill" style={{ width: `${row.volumeShare}%` }} /><em>{row.volumeShare.toFixed(1)}%</em></div><div><span className="sr-only">Open-position share</span><i className="interest-fill" style={{ width: `${row.oiShare}%` }} /><em>{row.oiShare.toFixed(1)}%</em></div></div><span className="gap-description">{Math.abs(row.gap).toFixed(1)} points {row.gap >= 0 ? "more trading share" : "more open-interest share"}</span></div>)}</div>
      {result.rows.length > 6 && <button className="text-button show-segments" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer segments" : `Show all ${result.rows.length} segments`}</button>}
      <details className="source-details"><summary>Exact values and how to read them</summary><p className="insight-note">Share difference = trading share minus open-interest share, in percentage points. Trading ÷ open interest measures turnover over the labelled trading period; it is not a fraud score. {contracts ? "Kalshi supplies contract counts here, not dollars spent." : "Values use the provider’s USD-notional convention, not cash deposits."} {dimension === "operator" ? "An operator lists the market; it is not necessarily the legal issuer of the underlying asset." : "Unresolved classifications remain Unclassified."}</p><div className="quality-table" role="table" aria-label="Activity breakdown values"><div className="quality-table-row quality-table-header" role="row"><span role="columnheader">Segment</span><span role="columnheader">Trading</span><span role="columnheader">Trading share</span><span role="columnheader">Open interest</span><span role="columnheader">OI share</span><span role="columnheader">Difference</span><span role="columnheader">Trading ÷ OI</span></div>{result.rows.map((row) => <div className="quality-table-row" role="row" key={row.group}><b role="cell">{row.group}</b><span role="cell">{value(row.volume)}</span><span role="cell">{row.volumeShare.toFixed(1)}%</span><span role="cell">{value(row.oi)}</span><span role="cell">{row.oiShare.toFixed(1)}%</span><span role="cell">{row.gap > 0 ? "+" : ""}{row.gap.toFixed(1)} pp</span><span role="cell">{row.turnover == null ? "Unavailable" : `${row.turnover.toFixed(2)}×`}</span></div>)}</div></details>
    </>}
  </section>;
}

export function DataHealth({ data }: { data: DashboardData }) {
  const now = useClock();
  const rows = dataHealth(data, now);
  return <details className="source-details data-health" id="data-health"><summary>Data freshness · see what is current and what is behind</summary><p className="insight-note">The site checks sources twice a day at 07:00 and 15:00 UTC, even when your laptop is off. A successful check does not guarantee a source has new data. Current feeds are flagged after 3 days; historical feeds are flagged when the latest complete month is missing. Failed checks preserve the last valid data.</p><div className="health-grid">{rows.map((row) => <article key={row.id}><div><b>{row.label}</b><span className={row.status === "current" ? "health-ok" : "health-behind"}>{row.status === "current" ? "Recent" : row.status === "behind" ? "Behind" : "Date unknown"}</span></div><p>{row.observed ? `Latest observation: ${day(row.observed)}` : "No verified observation date"}{row.historical && row.complete ? ` · Last complete month: ${month(row.complete)}` : ""}</p></article>)}</div><p className="insight-note">Free historical Hyperliquid breakdowns remain limited by the upstream archive. Current official snapshots update separately. Scheduled checks can be delayed; this is a research dashboard, not a live trading feed.</p></details>;
}
