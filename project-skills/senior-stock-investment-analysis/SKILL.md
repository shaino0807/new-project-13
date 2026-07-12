---
name: senior-stock-investment-analysis
description: "Creates data-driven senior equity research investment reports using five full fiscal years plus TTM financial data, valuation comparisons, moat analysis, governance review, and risk assessment."
category: analysis
risk: medium
source: local
tags: "[equity-research, investment-analysis, valuation, financial-analysis, stocks]"
date_added: "2026-05-06"
version: "1.0.0"
author: "Unknown"
---

# Senior Stock Investment Analysis

## Purpose

Create a comprehensive, objective, data-driven equity research report for a public company. The report uses the past five complete fiscal years plus the latest twelve months (TTM) of financial data, and combines financial statement analysis, valuation, competitive positioning, governance, capital allocation, and risk review into a clear buy, hold, or sell recommendation.

## Trigger Phrases

Use this skill when the request includes phrases such as:

- "股票研究分析師"
- "投資分析報告"
- "comprehensive investment analysis report"
- "equity research report"
- "五個完整財政年度和 TTM"
- "buy hold sell recommendation"
- "valuation versus peers and industry"

## Required Inputs

Collect or infer the following before drafting the report:

- Company name and ticker symbol
- Current share price and market capitalization date
- Reporting currency and fiscal year-end
- Top three direct competitors
- Industry or sub-industry peer group
- Past five complete fiscal years of income statement, balance sheet, and cash flow data
- TTM financial data
- Current valuation multiples and five-year historical average multiples
- Industry average valuation multiples
- Business segment revenue contribution
- CEO, senior management, insider ownership, dividend, buyback, and M&A history

If company, ticker, or competitors are placeholders, ask for those inputs before conducting live research or producing company-specific conclusions.

## Source And Data Standards

Use primary and reliable sources whenever available:

- SEC 10-K, 10-Q, 20-F, annual reports, quarterly reports, investor presentations, and earnings releases
- Company filings and investor relations pages for business segments, management, and capital returns
- Reputable market data providers for valuation multiples, share price, market cap, enterprise value, and industry averages
- Exchange filings, proxy statements, and ownership filings for insider ownership and governance

State the source date for current price, market capitalization, and valuation metrics. If a metric is estimated, label it as an estimate and explain the calculation. Avoid mixing fiscal-year and calendar-year periods without clearly labeling the basis.

## Report Workflow

1. Define the company, ticker, fiscal periods, reporting currency, and peer set.
2. Gather five full fiscal years plus TTM financial data.
3. Calculate revenue growth, gross margin, operating margin, net margin, debt-to-equity, current ratio, operating cash flow, capital expenditures, free cash flow, and valuation multiples.
4. Compare current valuation against five-year company averages, industry averages, and the three named competitors.
5. Analyze business model, segment mix, moat durability, growth catalysts, market opportunity, governance, capital allocation, and insider ownership.
6. Identify company-specific and systematic risks.
7. Synthesize the evidence into a buy, hold, or sell rating.

## Required Report Sections

### 1. Executive Summary

Briefly describe the business. State the investment thesis in two to three sentences and give a clear buy, hold, or sell rating at the current valuation. Summarize the main positive catalysts and the main risks.

### 2. Financial Performance And Health

Income statement analysis:

- Revenue growth over five fiscal years plus TTM
- Gross margin trend
- Operating margin trend
- Net margin trend
- Interpretation of scale, pricing power, cost structure, cyclicality, and one-time effects

Balance sheet analysis:

- Debt level
- Debt-to-equity ratio
- Current ratio
- Cash and short-term investments
- Judgment on whether the balance sheet is strong, adequate, or weak

Cash flow analysis:

- Operating cash flow
- Capital expenditures
- Free cash flow generation
- Consistency of positive FCF
- Relationship between earnings quality and cash conversion

### 3. Valuation

Compare current P/E, P/S, P/B, and EV/EBITDA with:

- The company's five-year historical average
- Industry average
- Top three direct competitors

Conclude whether the stock appears overvalued, undervalued, or fairly valued. Tie the conclusion to growth, margins, capital intensity, balance sheet quality, and moat strength.

### 4. Business Model And Competitive Moat

Describe core business segments and revenue contribution. Identify sources of competitive advantage, such as brand, patents, switching costs, network effects, scale, distribution, data advantages, regulatory position, or cost leadership. Assess moat strength and durability.

### 5. Growth Strategy And Outlook

Identify the main growth drivers, including new products, market expansion, pricing, mix shift, operating leverage, technology adoption, or industry trends. Discuss TAM and the company's potential to gain or defend market share.

### 6. Management And Governance

Summarize the CEO and senior management team, tenure, and track record. Evaluate capital allocation through dividends, repurchases, M&A, reinvestment, leverage management, and return on invested capital where available. Note insider ownership and alignment with shareholders.

### 7. Risk Analysis

List the top three company-specific risks, such as product failure, customer concentration, key-person risk, litigation, integration risk, leverage, execution risk, or technology disruption.

List the top three systematic risks, such as recession, rates, currency, regulation, supply chain pressure, commodity costs, geopolitical risk, or competitive disruption.

### 8. Final Recommendation

Synthesize all evidence into a final investment conclusion. Reiterate buy, hold, or sell and give a concise explanation based on the balance of upside, valuation, catalysts, and risks at the current price.

## Output Requirements

- Write in Traditional Chinese unless the user requests another language.
- Use tables for financial history, margins, cash flow, balance sheet metrics, and valuation comparisons.
- Keep conclusions evidence-based and avoid promotional language.
- Distinguish facts, calculations, analyst judgment, and assumptions.
- Include a brief data-quality note when key metrics are unavailable or estimated.
- Include source links or citations when live research is used.

## Extended Reference

For the detailed table structure, metric formulas, and reusable report skeleton, load `references/report-framework.md`.

## Limitations

This skill supports investment research and education. It does not provide personalized financial advice, suitability analysis, tax advice, or legal advice. Recommendations should be framed as research opinions based on the evidence reviewed.
