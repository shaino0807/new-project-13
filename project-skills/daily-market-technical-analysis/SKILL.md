---
name: daily-market-technical-analysis
description: "When the user provides a stock, ETF, futures contract, cryptocurrency, index, or market benchmark to evaluate, perform a daily-chart technical analysis using price action, moving averages, indicators, Chan theory, Elliott wave, and Granville's eight rules, then produce a clear trading plan with levels and charts."
category: analysis
risk: medium
source: local
tags: "[technical-analysis, daily-chart, trading-strategy, index-analysis, stock-analysis]"
date_added: "2026-05-06"
version: "1.0.0"
author: "Codex"
---

# Daily Market Technical Analysis

## Purpose

Evaluate a user-specified security, ETF, futures contract, cryptocurrency, index, or market benchmark from a daily-chart perspective. The analysis should focus on price behavior, moving averages, technical indicators, Chan theory, Elliott wave structure, and Granville's eight moving-average rules. The output should estimate pullback or continuation probability, compare evidence in charts/tables, and provide a scenario-based trading plan with entry, exit, stop, and target levels.

## Trigger

Use this skill when the user asks to evaluate a tradable market target or index using technical analysis, especially when the request includes:

- 標的評估
- 指數評估
- 日線分析
- 拉回機率
- 進出場點位
- 交易策略
- 價格行為、均線、指標、纏論、波浪理論、葛蘭威爾
- technical analysis, pullback probability, daily chart, trading levels

## Required Input

The only required user input is the target to evaluate.

Accept any of the following:

- Ticker or symbol, such as `AAPL`, `TSLA`, `SPY`, `QQQ`, `^GSPC`, `BTC-USD`
- Index name, such as `標普500`, `納斯達克100`, `台股加權`, `日經225`
- Futures or ETF name, such as `ES`, `NQ`, `SPY`, `0050`
- Company or asset name, if it can be mapped to a market symbol

If the user has not provided a target, ask one concise question: 「請給我要評估的標的或指數，例如 SPY、^GSPC、台積電、台股加權、BTC。」 Do not start market analysis before a target is known.

If the target is ambiguous, make the most likely mapping and state it. Ask only if ambiguity could materially change the analysis, such as `台積電` needing either Taiwan `2330.TW` or U.S. ADR `TSM`.

## Data Workflow

1. Identify the symbol, exchange, asset class, and market timezone.
2. Fetch or verify the latest available daily OHLCV data. Because market data changes frequently, browse or use a live data source whenever available.
3. Use at least 6 months of daily data when possible; prefer 1 year or more for SMA200 and broader wave context.
4. Record the data timestamp, whether the latest bar is complete or intraday, and the data source.
5. Calculate the daily indicators locally when possible so all charts and levels use the same dataset.

## Required Calculations

Calculate or estimate:

- SMA 5, 10, 20, 50, 100, 200
- EMA 20 if useful
- RSI(14)
- MACD(12,26,9)
- ATR(14)
- Bollinger Bands(20,2)
- Recent 20-day and 60-day highs/lows
- Support and resistance from swing pivots, moving averages, prior gaps, and ATR bands
- Distance from price to SMA20/SMA50/SMA200

## Analysis Framework

Cover each framework separately, then synthesize them:

### Price Action

Assess trend, breakout or breakdown status, candle behavior, higher highs/lower lows, range expansion/contraction, gaps, and volume confirmation if volume is available.

### Moving Averages

Assess slope, alignment, price position, dynamic support/resistance, distance from key averages, and possible mean reversion pressure.

### Indicators

Use RSI, MACD, Bollinger Bands, and ATR to judge momentum, overbought/oversold pressure, volatility, and trend exhaustion. Do not treat overbought as automatically bearish in a strong trend.

### Chan Theory

Use a pragmatic approximation if full multi-timeframe stroke/segment decomposition is unavailable:

- Identify likely daily strokes or segments from swing pivots.
- Discuss whether the current move resembles an upward/downward segment extension.
- State whether a lower-timeframe divergence would be needed to confirm a reversal.

### Elliott Wave

Provide a probabilistic wave count, not a definitive count. Identify invalidation levels. Prefer plain language such as "possible wave 3/5 extension" or "possible ABC pullback" when evidence is incomplete.

### Granville's Eight Rules

Map price and moving-average behavior to the most relevant Granville buy/sell rule. Explain whether price is near a trend-following entry, mean-reversion risk zone, or failure condition.

## Probability Scoring

Estimate pullback, continuation, and range-bound probabilities as judgment calls based on the evidence. Explain the main drivers. A simple pullback score may consider:

- RSI over 70 or under 30
- Price distance from SMA20/SMA50
- Touch or breach of Bollinger upper/lower band
- MACD histogram acceleration or deceleration
- ATR expansion
- Failed breakout or breakdown
- Trend alignment of SMA20/SMA50/SMA200
- Proximity to major resistance or support

Avoid false precision. Use ranges such as 45-55% when evidence is mixed.

## Output Requirements

Write in Traditional Chinese unless the user requests another language.

Include:

1. Target, symbol mapping, data source, and latest data timestamp.
2. Executive summary with directional bias and pullback/continuation probability.
3. A comparison table covering price action, moving averages, indicators, Chan theory, Elliott wave, and Granville rules.
4. Charts whenever feasible:
   - Price chart with candlesticks or line, SMA20/SMA50/SMA200, Bollinger Bands
   - Momentum chart with RSI and MACD
   - Optional support/resistance or scenario chart
5. Scenario-based trading plan:
   - Continuation entry
   - Pullback entry
   - Failure/exit condition
   - Stop-loss level
   - Targets
   - Position sizing or risk note if appropriate
6. A clear limitation note that the analysis is informational and not personalized financial advice.

## File Output

If the user asks for charts, comparison visuals, or a polished report, create a local HTML report in the workspace. Use a descriptive filename such as:

`technical_report_<symbol>_<YYYYMMDD>.html`

Also save a compact JSON summary if calculations are performed locally:

`technical_summary_<symbol>_<YYYYMMDD>.json`

## Guardrails

- Do not invent current prices or levels. Verify market data when current levels matter.
- Do not give personalized financial advice, tax advice, or legal advice.
- Treat futures, leveraged ETFs, crypto, and illiquid assets as higher risk and state that explicitly.
- If the latest bar is incomplete, label conclusions as intraday/preliminary.
- If live data is unavailable, use the latest available data and clearly state the limitation.
