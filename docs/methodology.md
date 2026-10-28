# Activity Atlas methodology

The dashboard records the exact retrieval timestamp and latest full calendar month in every downloadable JSON snapshot. The incomplete current month is excluded from correlation calculations. Raw current-month-to-date volume is included in the provisional DEX venue ranking so a new venue that changes the category total cannot remain hidden.

## Design principles

1. Free and publicly accessible sources only.
2. No interpolation, synthetic backfill, or cumulative-volume line charts.
3. Monthly volume is a flow in USD notional; open interest is a month-end USD stock.
4. Observed, derived, and proxy series are labeled separately.
5. Category lines prioritize broad comparison. Venue drilldowns preserve the source's individual labels.

## Source map

Direct historical inputs are public chart datasets from The Block. The perp-DEX volume and Hyperliquid OI charts attribute their upstream data to DeFiLlama.

| Output | Direct source | Transformation | Quality |
|---|---|---|---|
| Binance volume | [Hyperliquid vs Binance monthly perpetual volumes](https://www.theblock.co/data/decentralized-finance/derivatives/hyperliquid-vs-binance-monthly-perpetual-volumes) | Binance series, monthly USD | Observed |
| Bybit / Kraken volume | [Total futures volumes](https://www.theblock.co/data/crypto-markets/futures/total-futures-volumes) | ByBit / Kraken series, monthly USD | Proxy: total futures, not verified perpetual-only |
| CEX volume | inputs above | Binance + Bybit + Kraken | Derived from mixed-scope inputs; fixed universe |
| Binance / Bybit / Kraken OI | [BTC futures OI](https://www.theblock.co/data/crypto-markets/futures/aggregated-open-interest-of-bitcoin-futures-daily) + [ETH futures OI](https://www.theblock.co/data/crypto-markets/futures/aggregated-open-interest-of-ethereum-futures-daily) | BTC + ETH; last shared daily observation each month | Proxy: major assets, all futures |
| Coinbase International volume | [Daily contract volume](https://www.theblock.co/data/crypto-markets/futures/coinbase-international-daily-volume) | sum daily USD values for `-PERP` symbols only, then sum by month | Derived; starts June 21, 2023 (partial month) |
| Coinbase International OI | [Official instrument API](https://docs.cdp.coinbase.com/api-reference/international-exchange-api/rest-api/instruments/list-instruments) | filter type `PERP`; sum `open_interest × quote.mark_price`; retain collected snapshots | Forward collection only; USDC treated as USD at 1:1 |
| BTC denominator | [Coinbase Exchange daily candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles) | completed UTC BTC/USD daily closes | Approximate equivalent value; see below |
| Perp-DEX volume | [Perpetual protocol trade volume](https://www.theblock.co/data/decentralized-finance/derivatives/perpetual-protocol-trade-volume) | sum of every reported protocol series | Derived; vendor universe |
| Perp-DEX OI | [Hyperliquid open interest](https://www.theblock.co/data/decentralized-finance/derivatives/hyperliquid-open-interest) | last daily observation each month | Proxy for category; Hyperliquid only |
| Prediction volume | [Polymarket, Polymarket US and Kalshi volume](https://www.theblock.co/data/decentralized-finance/prediction-markets/polymarket-and-kalshi-volume-monthly) | monthly taker notional; platform sum | Derived |
| Prediction OI | [Polymarket and Kalshi OI](https://www.theblock.co/data/decentralized-finance/prediction-markets/polymarket-and-kalshi-open-interest-daily) | last daily observation each month; platform sum | Vendor-compiled USD OI |
| Breadth context | [Polymarket active traders](https://www.theblock.co/data/decentralized-finance/prediction-markets/polymarket-active-traders-monthly), [new markets](https://www.theblock.co/data/decentralized-finance/prediction-markets/polymarket-new-markets-monthly), [Kalshi active markets](https://www.theblock.co/data/decentralized-finance/prediction-markets/kalshi-daily-active-markets) | monthly values; Kalshi sampled at month-end | Observed vendor series |

Official API audits were used to test whether a better free reconstruction was practical:

- [Binance OI history](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Open-Interest-Statistics) is per symbol and has limited public lookback.
- [Bybit OI history](https://bybit-exchange.github.io/docs/v5/market/open-interest) is per symbol and requires instrument enumeration plus USD conversion.
- [Polymarket data resources](https://docs.polymarket.com/resources/blockchain-data) point historical users toward third-party/on-chain providers; the native APIs do not expose a complete aggregate history.
- [Kalshi historical data](https://docs.kalshi.com/getting_started/historical_data) can be reconstructed from live and archived market endpoints, but contract-level stitching and USD valuation are required.

## Composition layer

The granular section uses a bounded evidence ladder: official metadata first; deterministic symbol/tag mapping second; operator or contract evidence third; explicit curated overrides only when documented. Anything unresolved remains `Unclassified`. Classification provenance is stored on every series and never silently substituted for a measured value.

| Venue | Breakdown | Activity inputs | Coverage / limitation |
|---|---|---|---|
| Hyperliquid | asset class, HIP-3 operator/deployer, underlying | 21Shares Research Dune history plus official `perpDexs`, `metaAndAssetCtxs` and `perpConciseAnnotations` live responses | OI history begins June 2023; granular monthly volume begins October 2025. Separate official rolling-24h volume and OI snapshots cover Core plus every reported HIP-3 perp DEX and accumulate from the first successful collection. |
| Kalshi Perps | official asset class, ticker/underlying | Kalshi public margin-market list and daily `1440`-minute candles | Product-launch history only. Monthly volume is summed; average OI and last monthly OI are kept separately. |
| Kalshi Predictions | official event category, market | open events with nested official 24h volume and OI | Current snapshots; category history accumulates forward while the local refresh runner is active. |
| Polymarket | tag-derived category, event/market | Gamma rolling 30d volume and current OI; Dune community weekly category volume | Current snapshot history accumulates forward. Weekly history covers March 2025–March 2026 and assigns each week to its start month, so it is approximate rather than an exact calendar-month total. |

Hyperliquid's HIP-3 operator/deployer is the market deployer, not automatically the legal issuer of the referenced equity, commodity, private-company exposure, or other underlying. The dashboard therefore labels this dimension **Operator / deployer** and keeps **Underlying** separate. Live asset classes primarily follow official concise annotations; Core defaults to Crypto and missing HIP-3 annotations remain `Unclassified`. Official `dayNtlVlm` and `openInterest × markPx` are displayed as nominal USD-equivalent values. Numeric `collateralToken` IDs are retained on each live point, but no cross-collateral FX conversion is applied.

For each venue, dimension, metric and observation date:

```text
slice_share = 100 × slice_value / sum(all displayed slices)
turnover    = volume / average_OI        # monthly perpetual histories
turnover    = rolling_or_24h_volume / OI # current prediction snapshots
share_gap   = volume_share − OI_share
```

`Other instruments` preserves the long tail outside the top ten. `Unclassified` preserves unresolved metadata. Turnover and volume/OI share gaps are triage signals: a high value can arise from short holding periods, event duration, contract design, market-making, or measurement conventions and is not proof of manipulation.

## Aggregation

For a month `t`, category volume is:

```text
CEX_t        = Binance_perp_t + Bybit_total_futures_t + Kraken_total_futures_t
PerpDEX_t    = sum(volume_t for every protocol label reported by the source)
Prediction_t = Polymarket_t + Kalshi_t + Polymarket_US_t
```

CEX totals require all three components on each date. For CEX OI, daily component values are aligned before month-end sampling; original observation dates are preserved as `asOfDate`. Coinbase remains separate from category totals and correlations because its volume history starts later and its OI has no verified free historical aggregate. Activity Atlas preserves the 3 September 2026 snapshot and collects later official snapshots while the local runner is active; no pre-collection OI is inferred. Adding that short collected series to a long historical category aggregate would manufacture a coverage jump.

Absent components in DEX, prediction and Coinbase contract-volume aggregates contribute zero. This can hide source gaps; these are covered/vendor aggregates, not complete economic totals. Coinbase spot symbols are explicitly excluded using the `-PERP` suffix. Its source contains older/retired instrument labels as well as newer instruments; completeness beyond the vendor's reported universe is not independently verified. Future-dated rows are discarded. Incomplete daily coverage, including June 2023, is flagged.

Bybit is not estimated from market share or filled from Binance. Volume is copied unchanged from the vendor's total-futures series. OI is the sum of its BTC and ETH futures series at the last common daily observation of each month. These are reported data for a different scope, not verified all-pair perpetual metrics. No independent reconciliation or quantitative estimate of the scope error was performed. The previous description “perpetual-dominant” was unsupported and has been removed.

Venue-level prediction series omit leading zero rows before their first positive observation. Category history is retained: before July 2024 it is Polymarket-only; Kalshi starts July 2024; Polymarket US starts October 2025.

## Incomplete current month

Volume is a flow. For every positive incomplete current-month volume value, the chart uses a transparent calendar run-rate preview:

```text
projected full month = observed MTD volume × days in calendar month / covered days
```

Coinbase International has an explicit latest covered daily date. Monthly vendor buckets generally do not, so the calculation conservatively assumes coverage through the prior completed UTC day and labels that assumption in the tooltip. The underlying `value` remains the observed MTD amount; projection fields are separate in JSON/CSV. Dashed segments identify projections. A zero current bucket from a normally active source is treated as not yet published and omitted from the line rather than plotted as a collapse.

OI is a stock, not a flow. Incomplete-month OI points are actual dated snapshots, shown with dashed segments and never extrapolated. All incomplete points remain outside correlations; the DEX ranking is volume-only.

No arbitrary 3/6/12-month smoothing is used. Each refresh stores a compact incomplete-volume observation in `data/normalized/partial-volume-history.json`. Once enough month-progress observations exist, calendar proration can be backtested against empirical completion curves before any method change. Weekly reconstruction is not attempted because most broad free source payloads are monthly, even where their metadata says daily.

## Perp-DEX top 10

The ranking sums every venue's observed monthly volume, including raw current-month-to-date volume, and selects the ten largest totals. It does not use the chart's projected current-month run rate. The ranking is therefore provisional until month-end, but it keeps a newly launched venue visible when that venue already affects the category aggregate.

This follows the approved cumulative-activity rule and still favors longer-lived venues. Protocol labels follow the source; infrastructure, routing, economic-volume quality, or migrated-protocol attribution may overlap or remain unreconciled at the vendor level. New labels such as PaperTrade are retained rather than silently suppressed, with their incomplete-month and source-quality caveats disclosed.

PaperTrade first appears in October 2026. [DeFiLlama describes it](https://defillama.com/protocol/papertrade) as synthetic BTC and ETH perpetuals against a protocol-owned pool; [Galaxy Research reports](https://www.galaxy.com/insights/research/papertrade-paper-token-economics) up to 1,000× leverage and substantial token-incentive farming. Activity Atlas therefore includes the vendor's reported notional because it is in scope, but does not imply that one dollar of its turnover is economically comparable with one dollar on an order-book venue.

## Percentage-change view and axes

For each visible series, percentage change is:

```text
change_t = 100 × (value_t / first positive value in the selected range − 1)
```

The date navigator changes the visible window and therefore the baseline. The percentage view is linear for ordinary ranges. When the largest positive underlying ratio is at least 100 times the smallest, it switches to a multiplicative log-ratio axis while retaining true percentage labels. On that axis, doubling (+100%) and halving (−50%) occupy equal distance; zero activity (−100%) is pinned at the floor. Values are never capped. USD/BTC views retain their existing adaptive logarithmic rule. No smoothing or moving average is applied.

USD remains the default. **% change** replaces the former Indexed view: 0% is the baseline, +100% means doubled, and −50% means halved. This is change from the selected baseline, not month-to-month change or market share. Different coverage starts can imply different baseline dates. A single Coinbase OI snapshot becomes 0%; it contains no growth history and is shown as a point. USD/BTC values, exported source data and USD-based correlation calculations are unchanged.

## BTC equivalents

Public Coinbase Exchange BTC/USD candles are fetched in windows below the 300-candle API limit, deduplicated and sorted. Only completed daily closes are used; today's unfinished candle is excluded.

```text
volume_BTC_t = monthly_USD_volume_t / mean(completed daily BTCUSD closes in month t)
OI_BTC_t     = USD_OI_t / last completed BTCUSD close on or before the OI observation date
```

Where a volume source has an explicit last covered date, later prices are excluded from its denominator. Missing prices are not interpolated or zero-filled. The OI price must be in the observation month. `value` remains USD; `valueBtc`, `btcUsdPrice`, `btcPriceDate`, and `btcPriceMethod` are included in JSON/CSV for auditing. BTC values are approximate equivalents, not traded BTC contract quantities. Price averaging here is a conversion convention, not smoothing the activity series.

Coinbase's collected OI uses the most recent completed BTC close on or before each observation date, not a same-instant quote. USDC OI is treated as USD at 1:1. Both assumptions are disclosed in the dashboard.

## Refresh lifecycle

`npm run dev` and `npm start` refresh before starting the server. If the refresh fails and a prior public snapshot exists, the server starts with that last valid snapshot. While the runner is alive, it refreshes at 07:00 and 15:00 UTC; no Mac login job is installed. GitHub Actions runs the same public-data refresh at those times for the hosted dashboard. The client checks the cache-busted JSON every five minutes and on focus/visibility return without resetting chart controls.

Refreshes are serialized with a lock. Files are written to same-directory temporary files and atomically renamed; public JSON is published last as the commit point. Granular Dune aggregates use a 12-hour cache to bound query-credit use; official live snapshots still refresh on every scheduled/manual run. Hyperliquid publishes its Dune-history and official-live retrieval timestamps separately. Granular queries and live snapshots retain their last valid `composition-cache.json` payload when a source fails. The prior valid dashboard therefore survives upstream or mid-run failures.

## Correlation

For each category series, monthly log change is:

```text
r_t = ln(value_t / value_(t-1))
```

Only adjacent, positive, complete-month observations common to both categories are retained. The dashboard reports:

- Pearson correlation of monthly log changes
- Spearman rank correlation of the same changes
- observation count and exact overlap window

Exact overlap and sample counts are recalculated on refresh and displayed for each pair. Results always use USD, regardless of chart currency, because a shared BTC price denominator can mechanically alter correlations. The chart slider does not change the fixed calculation window. OI results remain exploratory because the CEX and perp-DEX category inputs are partial-universe proxies.

## Reproducibility

The fetch, normalization, ranking, projection fields, snapshot histories, and correlation calculations are implemented in [`scripts/fetch-data.mjs`](../scripts/fetch-data.mjs). Granular source queries, classification, reconciliation, caching, share calculations, and turnover are implemented in [`scripts/composition-data.mjs`](../scripts/composition-data.mjs). Scheduling and server lifecycle are implemented in [`scripts/run-dashboard.mjs`](../scripts/run-dashboard.mjs). Raw responses are retained under [`data/raw`](../data/raw); normalized values are in [`data/normalized/activity-series.csv`](../data/normalized/activity-series.csv).
# Comparison-first overview (October 2026)

The opening uses the same two complete calendar months for all three categories. Growth is `(end / start - 1) × 100`; a missing or zero starting value has no growth rate. The main comparison uses USD, excludes current-month projections, and retains the underlying coverage differences. The relative-size graphic is `100 × numerator / reference`, not a share of a combined global market. Values above 100 are valid and never capped.

Breakdown share comparisons require matching volume and OI periods. Snapshot comparisons additionally require matching collection timestamps. Missing counterparts are not interpreted as zero. Shares use each metric's own total; share gaps are percentage-point differences. Current Kalshi prediction breakdowns use official `volume_24h_fp` and `open_interest_fp` contract counts, not USD cash turnover; their old BTC conversions are removed. The separate vendor-based category histories retain their published notional conventions.

Freshness uses observation dates against wall-clock time, not the file-generation date. Current feeds have a three-day publication grace period; monthly breakdowns are behind when the previous complete calendar month is missing. Unknown cutoffs stay unknown. Retained category/operator snapshots are archived per collection for future analysis; overlapping rolling-volume observations must not be summed as exact calendar-month volume.
