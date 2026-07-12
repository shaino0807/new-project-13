# Taiwan Stock Screener

Local Codex skill for repeatable Taiwan stock screening across TWSE and TPEx stocks.

It covers five common screeners:

- Weekly turnover top 20, sorted by price gain.
- One-month foreign net-buy top 30, sorted by dividend yield.
- Quarterly EPS growth top 20, sorted by three-month price gain ascending.
- Three-month trading value top 20, sorted by three-month price gain ascending.
- 20MA trend investment candidates that pass price-above-rising-20MA, trend-line breakout, W-bottom pattern, and volume expansion checks.

For the standard screening series, the skill should output all five tables and list at least 10 stocks in each table. If a strict technical or quantitative filter returns fewer than 10 stocks, the table should add clearly labeled near-pass candidates to reach 10.

The skill requires current market data access. It prefers official TWSE/TPEx sources and falls back to FinMind per-stock APIs when needed, with throttling and failure reporting.
