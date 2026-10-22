# Activity Atlas

Hosted dashboard: [https://iixo3.github.io/activity-atlas/](https://iixo3.github.io/activity-atlas/)

Local, source-audited dashboard comparing activity across:

- Binance, Bybit and Kraken derivatives, plus Coinbase International perpetuals
- the covered global perpetual-DEX universe, with a top-10 observed cumulative-volume drilldown
- Polymarket, Polymarket US, and Kalshi prediction markets
- granular composition for Hyperliquid, Kalshi Perps, Kalshi Predictions, and Polymarket

The default window starts in January 2023. Prediction-market drilldowns retain earlier coverage from September 2020. The dashboard displays its exact latest refresh time, full-month cutoff, and source coverage.

## Reading the dashboard

The opening compares category totals and growth between two matching complete months. It never uses the partial-month estimate for its headline. The relative-size graphic shows one group's reported dollars per $100 of the reference group; it is not global market share or evidence of money moving between groups.

The platform breakdown opens on current Hyperliquid observations. Paired bars compare trading share with open-position share, with the measurement periods visible. Historical complete-month breakdowns remain selectable. Kalshi prediction breakdowns use contract counts, not dollars paid. Line charts and correlation statistics remain available further down the page.

Source freshness is evaluated from observation dates, independently of the file's refresh timestamp. Unknown publication cutoffs remain unknown; older Hyperliquid composition and Coinbase OI are explicitly flagged. Temporary core fetch failures retry up to three times. Incomplete Kalshi pagination or failed perp market feeds cannot replace a complete cached breakdown. GitHub runs include a source-health report.

`data/normalized/composition-observations.json` retains dated category/operator observations at each successful collection. Rolling 24h/30d volumes overlap and must not be summed into monthly totals. Missing historical observations are not reconstructed.

## Run locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The chart toolbar exports the active chart as a 2× PNG.

`npm run dev` is the normal restart protocol. It:

1. refreshes all public data;
2. falls back to the last valid snapshot if a source is temporarily unavailable;
3. starts the local dashboard;
4. refreshes again at 08:00 and 16:00 Europe/Paris while that command remains running.

The browser checks for a newer snapshot every five minutes and whenever the tab regains focus. It keeps the selected chart, venue, currency, and date range. Stop the dashboard with `Ctrl+C`. It intentionally does not launch at Mac login.

Each chart has one **Hide all / Show all** toggle alongside individual venue controls. The **CEX / Hyperliquid** view compares them directly without reclassifying Hyperliquid. USD is the default; BTC shows approximate BTC equivalents; **% change** compares growth from each line's first positive visible USD value (0% baseline). Extreme percentage ranges use a multiplicative axis with true percentage labels and no caps.

## Verify

```bash
npm run lint
npm test
npm run test:pages
```

## GitHub Pages

`.github/workflows/pages.yml` refreshes, verifies, and deploys the static dashboard on every `main` push, on manual dispatch, and at 08:00/16:00 Europe/Paris. An hourly lightweight check retries an overdue refresh window and skips full work when that window already completed. Successful runs commit compact continuity files so Coinbase OI and incomplete-month observations accumulate across runs. Raw provider responses stay local and out of Git.

Hosted refreshes retain the last valid snapshot when an optional provider fails. Dune-derived Hyperliquid/Polymarket composition history currently remains cached because the connected free Dune account has no query credits. Current Hyperliquid composition refreshes separately from its official API; core category and venue activity continues refreshing from public sources. Source timestamps expose this difference.

## Refresh the public snapshot

```bash
npm run refresh
```

This pulls 12 public chart datasets, current Coinbase International instruments, completed Coinbase BTC/USD daily candles, compact Dune composition aggregates, and official Kalshi/Polymarket snapshots, then rewrites:

- `data/raw/*.json` — latest source responses, each written atomically
- `data/normalized/activity-series.csv` — normalized long-form data
- `data/normalized/coinbase-oi-history.json` — compact collected Coinbase OI snapshots
- `data/normalized/partial-volume-history.json` — incomplete-month observations retained for later backtesting
- `data/normalized/composition-cache.json` — last valid granular datasets and forward-collected category snapshots
- `public/data/activity-series.csv` — downloadable CSV
- `public/data/activity-data.json` — dashboard payload and computed correlations

Publication is atomic and guarded against overlapping refreshes. The public JSON is replaced last, so a failed run does not expose a half-written dashboard. The app has no paid API dependency, database, tracking, account requirement, or Mac login daemon. GitHub Pages and GitHub Actions provide public hosting and scheduled refreshes within GitHub's free public-repository limits.

## Interpretation limits

- Binance volume is perpetual-only; Bybit and Kraken volume are total-futures proxies, without perpetual-only filtering or independent reconciliation.
- CEX OI is Binance + Bybit + Kraken BTC and ETH futures, not all-pair perpetual OI.
- Coinbase International volume sums only reported `-PERP` contracts; spot, US futures and Deribit are excluded. Coverage starts June 21, 2023; the first month is incomplete. OI is collected from dated official snapshots going forward, with no fabricated pre-collection history. USDC OI is treated as USD at 1:1.
- Current-month volume is a dashed full-calendar-month run-rate estimate. Tooltips and downloads retain the observed MTD value, coverage date, day count, and multiplier. A zero current bucket from a normally active source is omitted rather than treated as a real collapse. Current-month OI is the actual latest snapshot and is never extrapolated.
- Category totals use a fixed Binance + Bybit + Kraken universe. Coinbase remains in the venue charts, outside category totals/correlations, to avoid a changing historical universe.
- BTC values divide USD flows by the month's mean completed daily BTC/USD closes and OI by the last completed close on or before its observation date. This is approximate equivalent value, not actual BTC traded. Correlations stay USD-based.
- Global perp-DEX volume covers every protocol label currently present in the public vendor series. Historical perp-DEX OI covers Hyperliquid only.
- The DEX top 10 includes raw current-month-to-date volume so new venues that affect the category total are not hidden. It never uses the projected run rate and remains provisional until month-end.
- Prediction-market USD histories use The Block's taker-notional and OI series. Kalshi begins July 2024; Polymarket US begins October 2025.
- Composition history is not uniform: Hyperliquid OI is granular from June 2023, granular Hyperliquid volume from October 2025, Kalshi Perps from product launch, and prediction-category OI is collected forward. The dashboard shows exact coverage and source quality.
- Volume/OI turnover and share gaps are screening signals only. They do not prove wash trading, manipulation, or inflated activity.
- Correlations use monthly log changes over the common complete-month window. They describe co-movement, not causation.

Full definitions, source mapping, and formulas: [docs/methodology.md](docs/methodology.md).
