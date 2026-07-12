---
name: taiwan-stock-screener
description: "Screens Taiwan listed and OTC stocks for turnover, foreign net buying, dividend yield, EPS growth, trading value, 20MA trend setups, and price-change rankings."
category: analysis
risk: medium
source: local
tags: "[taiwan-stocks, stock-screening, twse, tpex, quantitative-analysis]"
date_added: "2026-05-06"
version: "1.0.0"
author: "Unknown"
---

# Taiwan Stock Screener

## Purpose

Screen Taiwan listed and OTC stocks using recent market, chip, dividend, technical, and financial-statement data. The skill is designed for repeatable ranking tasks such as hot stocks, foreign-buying value candidates, EPS-growth candidates, high-trading-value stocks, and 20MA trend breakout candidates.

This skill produces data tables only. It does not provide personalized investment advice or a buy/sell recommendation unless the user separately asks for investment analysis.

## Trigger Phrases

Use this skill when the user asks in Chinese or English for Taiwan stock screens such as:

- 找出台股週轉率排名
- 台股外資買超前 30 名
- 股價 100 元以內依殖利率排序
- EPS 成長率最高
- 近三個月成交金額最高
- Taiwan stock screener
- TWSE TPEx ranking
- 20MA趨勢投資指標
- 股價站上均線且均線向上
- 突破趨勢線
- W底型態
- 成交量爆量

## Default Universe

Unless the user specifies otherwise:

- Include TWSE listed and TPEx OTC common stocks.
- Exclude ETFs, ETNs, warrants, beneficiary securities, and non-common-stock products.
- Keep 4-digit numeric stock codes that represent ordinary stocks.
- Use the latest available trading day at or before the request date.
- Label all dates used in the output.

If the user's wording says "台股", treat it as TWSE plus TPEx. If the user says "上市" or "上櫃", restrict the universe accordingly.

## Data Sources

Prefer official sources first:

- TWSE OpenAPI for current listed daily prices, dividend yield, P/E, P/B, and monthly stock statistics.
- TWSE historical endpoints for dated listed daily prices and institutional trading when accessible.
- TPEx public JSON endpoints for OTC daily quotes, turnover ranking, P/E, dividend yield, and institutional trading.
- MOPS or FinMind financial statements for EPS when official bulk MOPS extraction is not available.
- FinMind per-stock APIs as a fallback for historical price, shareholding, institutional, PER, dividend yield, and EPS data.

Use source-specific throttling. If an API returns rate limiting, WAF blocks, `ip banned`, or sponsor-only messages, stop using that source for the run and clearly report the limitation.

## Required Output Rules

Every screener table must include:

- Rank
- Stock code
- Stock name
- Market: TWSE/listed or TPEx/OTC
- Latest close price
- The metric used for the primary ranking
- The metric used for final sorting
- Data period and latest trading date

Round percentages to two decimals. Show share quantities in lots when discussing Taiwan stock buy/sell volume. Show trading value in NT$100 million units when useful.

When this skill is used for the standard screening series, always provide all five screener tables unless the user explicitly asks for only one series. Each of the five series must list at least 10 stocks. If a strict filter returns fewer than 10 passing stocks, keep the strict pass list and add the nearest candidates needed to reach 10 under a clearly labeled "near-pass" status with the failed condition shown.

## Calculation Standards

### Price Change

Calculate price change as:

```
(latest_close / first_close_in_period - 1) * 100
```

Use the first available trading day in the requested period and the latest available trading day. Do not annualize.

### Weekly Turnover Rate

For "最近一週週轉率", use the latest five trading days unless the source provides a formal weekly turnover report.

Calculate:

```
sum(trading_volume_over_period) / latest_issued_shares * 100
```

If using a formal weekly turnover report, state the report date and source label.

### Foreign Net Buy

For "外資買超", use foreign investor net buy shares:

```
foreign_buy_shares - foreign_sell_shares
```

Include foreign dealer self-trading only if the source separates it and the user asks to include it. Otherwise use the standard foreign investor field. Convert shares to lots for display.

### Dividend Yield

Use the latest available dividend yield from TWSE or TPEx daily P/E and yield tables. If using another provider, label the source and date.

### EPS Growth

For "近三個月 EPS 成長率", use the latest quarterly EPS compared with the immediately previous quarterly EPS:

```
(latest_quarter_eps / previous_quarter_eps - 1) * 100
```

If previous EPS is zero or negative, do not calculate a percentage growth rate; either exclude it from percentage ranking or place it in a separate "turnaround" note.

### Three-Month Trading Value

Calculate:

```
sum(daily_trading_money_over_period)
```

Use the latest three calendar months back from the latest available trading day unless the user asks for exactly 60 trading days or calendar quarter data.

### 20MA Trend Investment Indicator

For "20MA趨勢投資指標", evaluate only stocks with enough daily OHLCV history to calculate a 20-day moving average, trend line, W-bottom pattern, and volume expansion. Use at least 60 trading days of data by default; 90 to 120 trading days is preferred when available.

The stock must pass all four conditions:

1. Price above the 20-day moving average and the 20MA is rising.
2. Price breaks above a recent downward or horizontal trend line.
3. Price shows a W-bottom pattern.
4. Volume expands significantly on or near the breakout day.

Calculate 20MA as:

```
average(close over latest 20 trading days)
```

Define "price above 20MA and 20MA rising" as:

```
latest_close > latest_20ma
latest_20ma > 20ma_5_trading_days_ago
```

Define "trend-line breakout" conservatively:

- Identify at least two recent swing highs within the last 20 to 60 trading days.
- Fit or draw the resistance line through those swing highs.
- The latest close must be above that line by at least 1% or close above it with above-average volume.

Define "W-bottom pattern" conservatively:

- Two swing lows appear within the last 20 to 80 trading days.
- The second low is not more than 5% below the first low.
- A neckline exists at the swing high between the two lows.
- The latest close is above the neckline, or the stock is within 2% of a neckline breakout if the user asks for early candidates.

Define "volume expansion" as:

```
latest_volume >= 1.5 * average(volume over previous 20 trading days)
```

If the latest trading day is not the breakout day, accept a breakout within the latest three trading days only when volume expansion occurred on the breakout day and price remains above both the 20MA and neckline.

Output fields for this screener:

- Latest close
- Latest 20MA
- 20MA 5-day slope or change
- Trend-line breakout price
- W-bottom neckline
- Distance from neckline or breakout percentage
- Latest volume
- 20-day average volume
- Volume expansion multiple
- Pass/fail notes for each of the four conditions

## Built-In Screeners

### 1. Hot Stocks

Request:

> 找出台股中，最近一週週轉率排名前20名的股票，股價不限，依漲幅由大到小排列。

Workflow:

1. Compute latest five-trading-day turnover rate for all eligible stocks.
2. Select the top 20 by turnover rate.
3. Sort those 20 by one-month price change from high to low unless the user specifies another "漲幅" period.
4. Output at least 10 stocks with weekly turnover rate and price change.

### 2. Undervalued Strong Stocks

Request:

> 找出台股中，近一個月外資買超前30名的股票，依殖利率由高到低排序。

Workflow:

1. Aggregate one-month foreign net buy for all eligible stocks.
2. Select the top 30 by foreign net buy.
3. Sort those 30 stocks by dividend yield from high to low.
4. Output at least 10 stocks with foreign net buy lots, close price, dividend yield, and one-month price change.

### 3. Stable Growth Stocks

Request:

> 找出台股中，近三個月 EPS 成長率最高的前20檔，依股價漲幅由小到大排列。

Workflow:

1. Get latest quarterly EPS and immediately previous quarterly EPS for all eligible stocks.
2. Calculate quarter-over-quarter EPS growth.
3. Select the top 20 by EPS growth.
4. Sort those 20 by three-month price change from low to high.
5. Output at least 10 stocks with EPS dates, EPS values, EPS growth, and three-month price change.

### 4. Highest Trading Value

Request:

> 幫我找出台股中，近三個月成交金額最高的前20檔，依股價漲幅由小到大排列。

Workflow:

1. Sum daily trading value over the latest three-month period.
2. Select the top 20 by total trading value.
3. Sort those 20 by three-month price change from low to high.
4. Output at least 10 stocks with trading value and three-month price change.

### 5. 20MA Trend Investment Indicator

Request:

> 20MA趨勢投資指標：此指標所篩選的股票需達成以下4項：股價站上均線且均線向上、突破趨勢線、有呈現W底型態、成交量爆量。

Workflow:

1. Gather at least 60 trading days of OHLCV data for all eligible stocks.
2. Calculate 20MA and confirm latest close is above 20MA.
3. Confirm 20MA is rising versus five trading days earlier.
4. Detect recent swing highs and test whether latest close breaks the trend line.
5. Detect W-bottom candidates using two swing lows and the intervening neckline.
6. Confirm volume expansion using latest volume divided by previous 20-day average volume.
7. Keep only stocks that pass all four conditions.
8. Sort passing stocks by breakout percentage or volume expansion multiple unless the user specifies a different sort order.
9. Output at least 10 stocks in a condition-by-condition table so borderline technical patterns can be audited.
10. If fewer than 10 stocks strictly pass all four technical conditions, add near-pass candidates ranked by total condition score and label which condition failed.

## Failure Handling

If a data source blocks access or returns incomplete data:

1. Do not present partial rankings as final.
2. Report the source, error message, and affected screener.
3. Use another source if available.
4. If no complete source is available, provide the exact calculation plan and ask the user for an API token or permission to retry later.

## Compliance Notes

Always include a brief note that screening outputs are quantitative candidates, not investment advice. Avoid claims such as "undervalued" as a conclusion unless the screen explicitly defines it as a mechanical label.
