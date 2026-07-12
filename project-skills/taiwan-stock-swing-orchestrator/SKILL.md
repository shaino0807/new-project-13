---
name: taiwan-stock-swing-orchestrator
description: Orchestrates a Traditional Chinese Taiwan stock 1-3 month swing-investing workflow. Use when the user wants latest macro analysis, Taiwan stock screening, a pause for user-selected candidates, comparable company valuation, selected-stock senior investment analysis, daily technical analysis, and K-line long/short signal synthesis.
---

# Taiwan Stock Swing Orchestrator

## Purpose

Run a staged Taiwan stock swing-analysis workflow for a 1-3 month investment horizon. The skill coordinates existing specialist skills and enforces a required handoff point after screening so the user can choose which stocks continue into deeper analysis.

Write all user-facing analysis in Traditional Chinese. Treat outputs as research, scenarios, and risk-control references, not personalized financial advice.

## Required Specialist Skills

Load and apply these skills in this order:

1. `senior-macro-strategist` at `../senior-macro-strategist/SKILL.md`
2. `taiwan-stock-screener` at `../taiwan-stock-screener/SKILL.md`
3. `comparable-company-analysis` at `../comparable-company-analysis/SKILL.md`
4. `senior-stock-investment-analysis` at `../senior-stock-investment-analysis/SKILL.md`
5. `daily-market-technical-analysis` at `../daily-market-technical-analysis/SKILL.md`
6. `kline-long-short-signal` at `../kline-long-short-signal/SKILL.md`

If a required specialist skill cannot be read, state which one is unavailable and continue only with the closest available fallback. Do not silently skip a stage.

## Data Freshness

Because this workflow depends on current market conditions, always verify current information with live sources or available market-data tools when possible. State the report date, Taiwan timezone, and latest market data date used.

For claims about macro data, prices, filings, news, institutional flows, comparable-company valuation multiples, and technical levels, include source URLs or clearly mark the item as tool-derived or unavailable. Do not invent rankings, prices, flows, peers, valuation multiples, or news.

## Workflow

### 1. Macro Regime

Use `senior-macro-strategist` first. Produce a concise macro regime view focused on the next 1-3 months:

- Taiwan and US equity risk appetite
- Rates, USD/TWD, liquidity, inflation, and central-bank path
- Semiconductor and AI supply-chain context when relevant
- Key events for the next 1-3 months
- Market regime label: risk-on, selective risk-on, range-bound, defensive, or risk-off

End this stage with screening implications, such as preferred sectors, factor tilts, and risk filters.

### 2. Taiwan Stock Screening

Use `taiwan-stock-screener` after the macro regime. Set the default investment operation horizon to 1-3 months unless the user overrides it.

Screen TWSE and TPEx common stocks unless the user narrows the universe. Prefer candidates that combine:

- Liquidity sufficient for practical trading
- Price above or reclaiming key moving averages
- 20MA or medium-term trend setup suitable for 1-3 months
- Improving EPS or revenue momentum when available
- Foreign/institutional buying or capital-flow support
- Relative strength versus TAIEX and sector peers
- Reasonable event/risk profile for the next 1-3 months

Return a candidate table with at least:

- Rank
- Stock code and name
- Market
- Latest close and latest data date
- Sector/theme
- 1-3 month setup type
- Primary screening evidence
- Key risk or invalidation level
- Suggested watch priority, not a buy instruction

### 3. Mandatory User Selection Gate

After screening, stop and ask the user to choose the stock codes for the next stages. Do not run comparable-company valuation, company-specific deep analysis, daily technical analysis, or long/short signal synthesis until the user explicitly names the stocks.

Use this exact handoff shape:

```markdown
## 請選擇後續分析股票

以上是 1-3 個月波段候選清單。請回覆你要進入深度流程的股票代號，例如：`2330, 2317, 2454`。

收到後我會依序完成：
1. 可比公司估值分析
2. 個股基本面與投資分析
3. 日線技術分析
4. K 線做多/做空/觀望整合訊號
```

If the user already provided selected stocks in the same request, acknowledge that the selection gate is satisfied and continue directly to stage 4.

### 4. Comparable Company Valuation

For each user-selected stock, use `comparable-company-analysis` before the senior stock report. Evaluate the target company's relative valuation against public peers.

Include:

- Target company, ticker, exchange, valuation date, and currency basis
- Peer set selection logic, preferably 10-15 listed peers when available
- EV/revenue, EV/EBITDA, P/E, revenue growth, EBITDA margin, and market cap where data is available
- Peer 25th percentile, median, and 75th percentile valuation range
- Whether the target deserves a premium, discount, or in-line valuation
- 3-5 highest-quality comparable peers and why they matter
- Data limitations for Taiwan stocks, especially unavailable EV, EBITDA, or analyst estimate fields

If complete peer data is unavailable, provide the best sourced comparable table and mark missing values as `N/A`. Do not fabricate multiples.

### 5. Selected-Stock Deep Analysis

For each user-selected stock, use `senior-stock-investment-analysis`. Adapt the report to the 1-3 month horizon while preserving the skill's requirements for fundamentals, valuation, competitive position, governance, catalysts, and risks.

If full five-year plus TTM data is unavailable for a Taiwan stock, use official filings, MOPS, company IR, TWSE/TPEx, and reliable market-data sources where possible. Mark missing or estimated fields clearly.

### 6. Daily Technical Analysis

Use `daily-market-technical-analysis` for each selected stock. Include daily timeframe trend, moving averages, RSI, MACD, support/resistance, pullback or continuation probability, and scenario levels.

### 7. Long/Short Signal

Use `kline-long-short-signal` last. Decide for each selected stock:

- Long setup
- Short setup
- No trade / wait for confirmation

Require alignment between daily technical analysis and latest K-line signal before calling a setup strong. If evidence conflicts, downgrade to no-trade or conditional setup.

## Final Synthesis

After all stages complete, produce an integrated table:

- Stock
- Comparable valuation bias
- Fundamental rating or bias
- Daily technical bias
- K-line long/short signal
- 1-3 month scenario
- Key levels
- Main catalyst
- Main risk
- Final research stance: bullish candidate, neutral/watchlist, bearish/avoid, or short-biased candidate

Close with a ranked watchlist and risk controls. Use scenario language such as "若突破/站回/跌破..." and avoid direct instructions such as "立即買進" or "立刻放空".
