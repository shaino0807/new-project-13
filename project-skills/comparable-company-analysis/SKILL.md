---
name: comparable-company-analysis
description: Create trading comparable company analysis reports for equity research and valuation. Use when the user asks for public-company comps, peer trading multiples, EV/EBITDA, EV/revenue, P/E, percentile valuation ranges, implied valuation for a target company, peer quality screens, growth comparison, or investment-banking/equity-research style comparable company valuation tables.
---

# Comparable Company Analysis

## Core Workflow

Produce an equity-research style trading comps report for the target company.

1. Define the target company, ticker, exchange, reporting currency, latest fiscal period, and valuation date.
2. Gather current market data and latest available financials from reliable public sources. Browse when the answer depends on current prices, market cap, enterprise value, analyst estimates, or recent filings.
3. Select 10-15 listed peer companies in the same industry or business model. Prefer peers with similar revenue mix, geography, size, margin profile, growth, and capital intensity.
4. Calculate or source EV/EBITDA, EV/revenue, and P/E for each peer. Use forward-year estimates when available; otherwise label metrics as LTM or TTM.
5. Include financial comparison metrics: revenue, EBITDA, EBITDA margin, revenue growth, and any sector-specific quality metrics.
6. Compute the peer set 25th percentile, median, and 75th percentile for each valuation multiple.
7. Apply the percentile multiples to the target company's corresponding financial metric to derive implied enterprise value or equity value.
8. Explain whether the target deserves a premium or discount using growth, margin, profitability quality, scale, risk, balance sheet, management execution, and business mix.
9. Identify the most comparable peers and explain why they receive higher analytical weight.

## Output Requirements

Return the report in the user's requested language. For Chinese requests, use Traditional Chinese finance terminology from the methodology reference.

Include these sections:

- Comparable company valuation table: peer company table with company, ticker, country/exchange, market cap, enterprise value, revenue, EBITDA, EBITDA margin, revenue growth, EV/revenue, EV/EBITDA, and P/E.
- Valuation range: 25th percentile, median, and 75th percentile for each highlighted multiple.
- Implied valuation: target implied enterprise value and/or equity value under each percentile multiple.
- Growth and quality comparison: target growth, margin, and quality versus the peer group.
- Premium/discount adjustment: concise justification for premium, discount, or in-line valuation.
- Best comparable companies: 3-5 highest-quality peers with reasons.
- Data sources and limitations: sources, metric period, currency treatment, and assumptions.

Highlight valuation multiples in Markdown tables by bolding the multiple columns and percentile rows, for example `**EV/EBITDA**`, `**EV/revenue**`, and `**P/E**`.

## Data Discipline

State the valuation date and whether figures are LTM, TTM, NTM, or fiscal-year estimates.

Use consistent currency where possible. If peers report in different currencies, keep market-value metrics in a common currency and label financial statement metrics clearly.

Do not mix enterprise-value multiples with equity metrics:

- Apply EV/revenue to revenue to estimate enterprise value.
- Apply EV/EBITDA to EBITDA to estimate enterprise value.
- Apply P/E to net income or EPS to estimate equity value.

When current market data is unavailable, provide the table structure and clearly mark unavailable values as `N/A`; do not fabricate numbers.

## References

Read `references/comps-methodology.md` when building a full report, checking formulas, or explaining peer selection and valuation adjustments.
