import { router, json, error, secrets } from "@appdeploy/sdk";

type DailyBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type QuoteInfo = {
  code: string;
  symbol: string;
  name: string;
  market: string;
  currency: string;
  close: number;
  open: number;
  high: number;
  low: number;
  quoteDate: string | null;
  change: number | null;
  volume: number;
  source: string;
  sourceUrls: Record<string, string | null>;
  series: DailyBar[];
  analysis: ReturnType<typeof buildAnalysis>;
};

const FALLBACK_NAMES: Record<string, string> = {
  "0050": "\u5143\u5927\u53F0\u706350",
  "2303": "\u806F\u96FB",
  "2308": "\u53F0\u9054\u96FB",
  "2317": "\u9D3B\u6D77",
  "2330": "\u53F0\u7A4D\u96FB",
  "2344": "\u83EF\u90A6\u96FB",
  "2356": "\u82F1\u696D\u9054",
  "2382": "\u5EE3\u9054",
  "2454": "\u806F\u767C\u79D1",
  "3231": "\u7DEF\u5275",
};

function cleanCode(value: string | undefined) {
  return String(value || "").replace(/[^0-9A-Za-z.]/g, "").slice(0, 12).toUpperCase();
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "-" || value === "") return NaN;
  return Number(String(value).replace(/[,+%]/g, "").trim());
}

function round(value: number, digits = 2) {
  if (!Number.isFinite(value)) return NaN;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

async function fetchJson(url: string, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json,text/plain,*/*",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return JSON.parse((await res.text()).trim());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/rss+xml,application/xml,text/xml,text/html,*/*",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

type FinMindRow = Record<string, any>;

type FinMindCacheEntry = {
  data: FinMindRow[];
  fetchedAt: number;
};

type FinMindDatasetResult = {
  dataset: string;
  data: FinMindRow[];
  fetchedAt: string;
  cached: boolean;
  stale: boolean;
  warning?: string;
};

class FinMindError extends Error {
  status: number;
  code: "quota_exceeded" | "auth_error" | "upstream_error" | "invalid_response";

  constructor(message: string, status: number, code: FinMindError["code"]) {
    super(message);
    this.name = "FinMindError";
    this.status = status;
    this.code = code;
  }
}

const FINMIND_API_URL = "https://api.finmindtrade.com/api/v4/data";
const FINMIND_SOURCE_URL = "https://finmind.github.io/";
const finMindCache = new Map<string, FinMindCacheEntry>();
const finMindInflight = new Map<string, Promise<FinMindDatasetResult>>();
let finMindTokenPromise: Promise<string> | null = null;

async function getFinMindToken() {
  if (!finMindTokenPromise) {
    finMindTokenPromise = secrets.readSecret("FINMIND_TOKEN").catch(() => "");
  }
  const token = await finMindTokenPromise;
  if (!token) finMindTokenPromise = null;
  return token;
}

function isoDateDaysAgo(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function finMindCacheTtl(dataset: string) {
  if (dataset === "TaiwanStockInfo") return 24 * 60 * 60 * 1000;
  if ([
    "TaiwanStockFinancialStatements",
    "TaiwanStockBalanceSheet",
    "TaiwanStockCashFlowsStatement",
  ].includes(dataset)) return 6 * 60 * 60 * 1000;
  if (dataset === "TaiwanStockMonthRevenue") return 2 * 60 * 60 * 1000;
  return 30 * 60 * 1000;
}

function finMindStartDate(dataset: string) {
  if (dataset === "TaiwanStockInfo") return isoDateDaysAgo(30);
  if ([
    "TaiwanStockFinancialStatements",
    "TaiwanStockBalanceSheet",
    "TaiwanStockCashFlowsStatement",
  ].includes(dataset)) return isoDateDaysAgo(900);
  if (dataset === "TaiwanStockMonthRevenue") return isoDateDaysAgo(760);
  if (dataset === "TaiwanStockPER") return isoDateDaysAgo(120);
  return isoDateDaysAgo(90);
}

function finMindErrorCode(status: number): FinMindError["code"] {
  if (status === 402 || status === 429) return "quota_exceeded";
  if (status === 401 || status === 403) return "auth_error";
  if (status >= 500) return "upstream_error";
  return "invalid_response";
}

function finMindPublicMessage(err: unknown) {
  if (err instanceof FinMindError) {
    if (err.code === "quota_exceeded") return "FinMind API \u984D\u5EA6\u66AB\u6642\u7528\u5B8C\uFF0C\u5DF2\u4FDD\u7559\u5176\u4ED6\u53EF\u7528\u8CC7\u6599\u3002";
    if (err.code === "auth_error") return "FinMind Token \u7121\u6548\u6216\u4F86\u6E90\u66AB\u6642\u62D2\u7D55\u5B58\u53D6\u3002";
    if (err.code === "upstream_error") return "FinMind \u670D\u52D9\u66AB\u6642\u7570\u5E38\u3002";
    return "FinMind \u56DE\u50B3\u683C\u5F0F\u4E0D\u7B26\u5408\u9810\u671F\u3002";
  }
  return err instanceof Error ? err.message : String(err);
}

async function requestFinMindDataset(dataset: string, code: string): Promise<FinMindDatasetResult> {
  const cacheKey = `${dataset}:${code}`;
  const now = Date.now();
  const cached = finMindCache.get(cacheKey);
  const ttl = finMindCacheTtl(dataset);
  if (cached && now - cached.fetchedAt < ttl) {
    return {
      dataset,
      data: cached.data,
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
      cached: true,
      stale: false,
    };
  }

  const activeRequest = finMindInflight.get(cacheKey);
  if (activeRequest) return activeRequest;

  const request = (async () => {
    const params = new URLSearchParams({
      dataset,
    });
    if (dataset !== "TaiwanStockInfo") {
      params.set("start_date", finMindStartDate(dataset));
      params.set("end_date", new Date().toISOString().slice(0, 10));
    }
    if (code) params.set("data_id", code);
    const token = await getFinMindToken();
    const requestUrl = `${FINMIND_API_URL}?${params.toString()}`;
    const fetchDataset = async (useToken: boolean) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(requestUrl, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            ...(useToken && token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        const text = await res.text();
        let payload: any = null;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new FinMindError("FinMind returned non-JSON content", res.status || 502, "invalid_response");
        }
        const status = Number(payload?.status || res.status);
        if (!res.ok || status !== 200 || !Array.isArray(payload?.data)) {
          throw new FinMindError(
            String(payload?.msg || `${res.status} ${res.statusText}`),
            status || res.status || 502,
            finMindErrorCode(status || res.status || 502),
          );
        }
        return payload.data as FinMindRow[];
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      let data: FinMindRow[];
      try {
        data = await fetchDataset(false);
      } catch (err) {
        const canRetryWithToken = Boolean(token)
          && err instanceof FinMindError
          && (err.code === "quota_exceeded" || err.code === "auth_error");
        if (!canRetryWithToken) throw err;
        data = await fetchDataset(true);
      }
      const entry = { data, fetchedAt: Date.now() };
      finMindCache.set(cacheKey, entry);
      return {
        dataset,
        data: entry.data,
        fetchedAt: new Date(entry.fetchedAt).toISOString(),
        cached: false,
        stale: false,
      };
    } catch (err) {
      if (cached && now - cached.fetchedAt < 24 * 60 * 60 * 1000) {
        return {
          dataset,
          data: cached.data,
          fetchedAt: new Date(cached.fetchedAt).toISOString(),
          cached: true,
          stale: true,
          warning: finMindPublicMessage(err),
        };
      }
      if (err instanceof FinMindError) throw err;
      throw new FinMindError(
        err instanceof Error ? err.message : String(err),
        502,
        "upstream_error",
      );
    }
  })();

  finMindInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    finMindInflight.delete(cacheKey);
  }
}

function sortByDate(rows: FinMindRow[]) {
  return [...rows].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

function latestRow(rows: FinMindRow[]) {
  const sorted = sortByDate(rows);
  return sorted.length ? sorted[sorted.length - 1] : null;
}

function finiteOrNull(value: unknown) {
  const number = toNumber(value);
  return Number.isFinite(number) ? number : null;
}

function percentChange(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null;
  return round(((current / previous) - 1) * 100, 2);
}

function rowsForLatestDate(rows: FinMindRow[]) {
  const date = latestRow(rows)?.date;
  return date ? rows.filter(row => row.date === date) : [];
}

function statementValue(rows: FinMindRow[], types: string[]) {
  for (const type of types) {
    const row = rows.find(item => item.type === type);
    const value = finiteOrNull(row?.value);
    if (value !== null) return value;
  }
  return null;
}

function statementPeriods(rows: FinMindRow[]) {
  const dates = [...new Set(rows.map(row => String(row.date || "")).filter(Boolean))].sort();
  return dates.map(date => ({ date, rows: rows.filter(row => row.date === date) }));
}

function sameQuarterLastYear(periods: ReturnType<typeof statementPeriods>, date: string) {
  const year = Number(date.slice(0, 4)) - 1;
  const monthDay = date.slice(4);
  return periods.find(period => period.date === `${year}${monthDay}`) || null;
}

function buildFinancialSummary(rows: FinMindRow[]) {
  const periods = statementPeriods(rows);
  const latest = periods[periods.length - 1] || null;
  if (!latest) return null;
  const previousYear = sameQuarterLastYear(periods, latest.date);
  const eps = statementValue(latest.rows, ["EPS", "BasicEarningsLossPerShare"]);
  const previousEps = previousYear ? statementValue(previousYear.rows, ["EPS", "BasicEarningsLossPerShare"]) : null;
  const revenue = statementValue(latest.rows, ["Revenue", "OperatingRevenue"]);
  const previousRevenue = previousYear ? statementValue(previousYear.rows, ["Revenue", "OperatingRevenue"]) : null;
  const netIncome = statementValue(latest.rows, [
    "IncomeAfterTaxes",
    "IncomeFromContinuingOperations",
    "EquityAttributableToOwnersOfParent",
  ]);
  return {
    date: latest.date,
    eps,
    epsYoY: percentChange(eps, previousEps),
    previousYearEps: previousEps,
    revenue,
    revenueYoY: percentChange(revenue, previousRevenue),
    previousYearRevenue: previousRevenue,
    pretaxIncome: statementValue(latest.rows, ["IncomeBeforeTax", "PreTaxIncome", "ProfitBeforeTax"]),
    netIncome,
    operatingIncome: statementValue(latest.rows, ["OperatingIncome"]),
    grossProfit: statementValue(latest.rows, ["GrossProfit"]),
  };
}

function buildRevenueSummary(rows: FinMindRow[]) {
  const sorted = sortByDate(rows);
  const latest = latestRow(sorted);
  if (!latest) return null;
  const previousYear = sorted.find(row =>
    Number(row.revenue_year) === Number(latest.revenue_year) - 1 &&
    Number(row.revenue_month) === Number(latest.revenue_month)
  ) || null;
  const latestRevenue = finiteOrNull(latest.revenue);
  const previousRevenue = finiteOrNull(previousYear?.revenue);
  const recent = sorted.slice(-6).map(row => {
    const comparison = sorted.find(item =>
      Number(item.revenue_year) === Number(row.revenue_year) - 1 &&
      Number(item.revenue_month) === Number(row.revenue_month)
    );
    return {
      date: row.date,
      year: Number(row.revenue_year),
      month: Number(row.revenue_month),
      revenue: finiteOrNull(row.revenue),
      yoy: percentChange(finiteOrNull(row.revenue), finiteOrNull(comparison?.revenue)),
    };
  });
  const validGrowth = recent.map(row => row.yoy).filter((value): value is number => value !== null);
  const latestThree = validGrowth.slice(-3);
  const priorThree = validGrowth.slice(-6, -3);
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const latestAverage = average(latestThree);
  const priorAverage = average(priorThree);
  return {
    date: latest.date,
    createTime: latest.create_time || null,
    revenue: latestRevenue,
    yoy: percentChange(latestRevenue, previousRevenue),
    recent,
    growthMomentum: latestAverage !== null && priorAverage !== null ? round(latestAverage - priorAverage, 2) : null,
  };
}

function buildValuationSummary(rows: FinMindRow[]) {
  const latest = latestRow(rows);
  if (!latest) return null;
  return {
    date: latest.date,
    per: finiteOrNull(latest.PER),
    pbr: finiteOrNull(latest.PBR),
    dividendYield: finiteOrNull(latest.dividend_yield),
  };
}

function buildCashFlowSummary(rows: FinMindRow[]) {
  const latest = rowsForLatestDate(rows);
  if (!latest.length) return null;
  const operatingCashFlow = statementValue(latest, [
    "CashFlowsFromOperatingActivities",
    "NetCashInflowFromOperatingActivities",
  ]);
  const capitalExpenditure = statementValue(latest, [
    "PropertyAndPlantAndEquipment",
    "AcquisitionOfPropertyPlantAndEquipment",
  ]);
  const freeCashFlow = operatingCashFlow !== null && capitalExpenditure !== null
    ? round(operatingCashFlow + capitalExpenditure, 0)
    : null;
  return {
    date: latest[0].date,
    operatingCashFlow,
    capitalExpenditure,
    freeCashFlow,
    cashChange: statementValue(latest, ["CashBalancesIncrease"]),
    endingCash: statementValue(latest, ["CashBalancesEndOfPeriod"]),
  };
}

function buildBalanceSheetSummary(rows: FinMindRow[]) {
  const latest = rowsForLatestDate(rows);
  if (!latest.length) return null;
  const totalAssets = statementValue(latest, ["TotalAssets"]);
  const liabilities = statementValue(latest, ["Liabilities", "TotalLiabilities"]);
  const currentAssets = statementValue(latest, ["CurrentAssets"]);
  const currentLiabilities = statementValue(latest, ["CurrentLiabilities"]);
  return {
    date: latest[0].date,
    totalAssets,
    liabilities,
    liabilityRatio: totalAssets && liabilities !== null ? round((liabilities / totalAssets) * 100, 2) : null,
    currentAssets,
    currentLiabilities,
    currentRatio: currentLiabilities && currentAssets !== null ? round(currentAssets / currentLiabilities, 2) : null,
    cashAndEquivalents: statementValue(latest, ["CashAndCashEquivalents"]),
    equity: statementValue(latest, ["Equity", "EquityAttributableToOwnersOfParent"]),
  };
}

function buildInstitutionalSummary(rows: FinMindRow[]) {
  const sorted = sortByDate(rows);
  const recent = sorted.slice(-5);
  if (!recent.length) return null;
  const net = (row: FinMindRow, buyFields: string[], sellFields: string[]) =>
    buyFields.reduce((sum, field) => sum + (finiteOrNull(row[field]) || 0), 0) -
    sellFields.reduce((sum, field) => sum + (finiteOrNull(row[field]) || 0), 0);
  const foreignNet = recent.reduce((sum, row) => sum + net(
    row,
    ["Foreign_Investor_buy", "Foreign_Dealer_Self_buy"],
    ["Foreign_Investor_sell", "Foreign_Dealer_Self_sell"],
  ), 0);
  const trustNet = recent.reduce((sum, row) => sum + net(
    row,
    ["Investment_Trust_buy"],
    ["Investment_Trust_sell"],
  ), 0);
  const dealerNet = recent.reduce((sum, row) => sum + net(
    row,
    ["Dealer_buy", "Dealer_self_buy", "Dealer_Hedging_buy"],
    ["Dealer_sell", "Dealer_self_sell", "Dealer_Hedging_sell"],
  ), 0);
  return {
    date: recent[recent.length - 1].date,
    days: recent.length,
    foreignNet: round(foreignNet, 0),
    investmentTrustNet: round(trustNet, 0),
    dealerNet: round(dealerNet, 0),
    totalNet: round(foreignNet + trustNet + dealerNet, 0),
  };
}

function buildShareholdingSummary(rows: FinMindRow[]) {
  const sorted = sortByDate(rows);
  const latest = latestRow(sorted);
  if (!latest) return null;
  const previous = sorted[Math.max(0, sorted.length - 6)] || null;
  const ratio = finiteOrNull(latest.ForeignInvestmentSharesRatio);
  const previousRatio = finiteOrNull(previous?.ForeignInvestmentSharesRatio);
  return {
    date: latest.date,
    foreignShares: finiteOrNull(latest.ForeignInvestmentShares),
    foreignRatio: ratio,
    fiveDayRatioChange: ratio !== null && previousRatio !== null ? round(ratio - previousRatio, 2) : null,
  };
}

function buildMarginSummary(rows: FinMindRow[]) {
  const sorted = sortByDate(rows);
  const latest = latestRow(sorted);
  if (!latest) return null;
  const fiveDaysAgo = sorted[Math.max(0, sorted.length - 6)] || null;
  const twentyDaysAgo = sorted[Math.max(0, sorted.length - 21)] || null;
  const marginBalance = finiteOrNull(latest.MarginPurchaseTodayBalance);
  const shortBalance = finiteOrNull(latest.ShortSaleTodayBalance);
  return {
    date: latest.date,
    marginBalance,
    marginFiveDayChange: percentChange(marginBalance, finiteOrNull(fiveDaysAgo?.MarginPurchaseTodayBalance)),
    marginTwentyDayChange: percentChange(marginBalance, finiteOrNull(twentyDaysAgo?.MarginPurchaseTodayBalance)),
    shortBalance,
    shortFiveDayChange: percentChange(shortBalance, finiteOrNull(fiveDaysAgo?.ShortSaleTodayBalance)),
  };
}

function buildLendingSummary(rows: FinMindRow[]) {
  const daily = new Map<string, number>();
  rows.forEach(row => {
    const date = String(row.date || "");
    if (!date) return;
    daily.set(date, (daily.get(date) || 0) + (finiteOrNull(row.volume) || 0));
  });
  const dates = [...daily.keys()].sort();
  if (!dates.length) return null;
  const latestDate = dates[dates.length - 1];
  const latestVolume = daily.get(latestDate) || 0;
  const previous = dates.slice(-21, -1).map(date => daily.get(date) || 0);
  const average20 = previous.length ? previous.reduce((sum, value) => sum + value, 0) / previous.length : null;
  return {
    date: latestDate,
    volume: round(latestVolume, 0),
    average20: average20 === null ? null : round(average20, 0),
    volumeRatio: average20 ? round(latestVolume / average20, 2) : null,
  };
}

type EtfHolding = {
  code: string;
  name: string;
  weight: number;
};

type EtfProfile = {
  code: string;
  name: string;
  holdingsDate: string | null;
  holdings: EtfHolding[];
  holdingsSourceUrl: string | null;
  nav: {
    date: string | null;
    value: number | null;
    marketPrice: number | null;
    premiumDiscount: number | null;
    sourceUrl: string | null;
  };
  componentSummary: {
    coverageWeight: number;
    profitableWeight: number | null;
    positiveEpsGrowthWeight: number | null;
    weightedEpsYoY: number | null;
    weightedRevenueYoY: number | null;
    weightedPer: number | null;
    weightedPbr: number | null;
    weightedDividendYield: number | null;
    availableComponents: number;
  } | null;
  warnings: string[];
};

const etfProfileCache = new Map<string, { data: EtfProfile; fetchedAt: number }>();
const ETF_PROFILE_TTL_MS = 30 * 60 * 1000;

function normalizeDate(value: string | null | undefined) {
  const match = String(value || "").match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function parseYuantaHoldings(html: string) {
  const holdings: EtfHolding[] = [];
  const spanValues = [...html.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)]
    .map(match => stripTags(match[1]).trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (let index = 0; index < spanValues.length; index += 1) {
    const code = spanValues[index];
    if (!/^\d{4,6}$/.test(code) || seen.has(code)) continue;
    const name = spanValues[index + 1] || "";
    const nearbyNumbers = spanValues
      .slice(index + 2, index + 8)
      .map(value => toNumber(value))
      .filter(value => Number.isFinite(value) && value > 0 && value <= 100);
    const weight = nearbyNumbers[nearbyNumbers.length - 1];
    if (!name || !Number.isFinite(weight)) continue;
    seen.add(code);
    if (!Number.isFinite(weight)) continue;
    holdings.push({
      code,
      name,
      weight: round(weight, 2),
    });
  }
  const dateMatch = html.match(/(\d{4}\/\d{2}\/\d{2})/);
  return {
    date: normalizeDate(dateMatch?.[1]),
    holdings,
  };
}

function parseYuantaNav(html: string) {
  const match = html.match(/<h5[^>]*>(\d{4}\/\d{2}\/\d{2})<\/h5>[\s\S]*?<p[^>]*>\s*NTD\s*([\d,.]+)<\/p>/i);
  return {
    date: normalizeDate(match?.[1]),
    value: finiteOrNull(match?.[2]),
  };
}

function weightedMetric<T>(rows: T[], weight: (row: T) => number, value: (row: T) => number | null) {
  const usable = rows.map(row => ({ weight: weight(row), value: value(row) }))
    .filter(row => Number.isFinite(row.weight) && row.weight > 0 && row.value !== null && Number.isFinite(row.value));
  const totalWeight = usable.reduce((sum, row) => sum + row.weight, 0);
  if (!totalWeight) return null;
  return round(usable.reduce((sum, row) => sum + row.weight * (row.value as number), 0) / totalWeight, 2);
}

async function buildEtfComponentSummary(holdings: EtfHolding[]) {
  const major = holdings.slice(0, 5);
  const rows = await Promise.all(major.map(async holding => {
    try {
      const [financial, revenue, valuation] = await Promise.all([
        requestFinMindDataset("TaiwanStockFinancialStatements", holding.code),
        requestFinMindDataset("TaiwanStockMonthRevenue", holding.code),
        requestFinMindDataset("TaiwanStockPER", holding.code),
      ]);
      return {
        ...holding,
        financial: buildFinancialSummary(financial.data),
        revenue: buildRevenueSummary(revenue.data),
        valuation: buildValuationSummary(valuation.data),
      };
    } catch {
      return {
        ...holding,
        financial: null,
        revenue: null,
        valuation: null,
      };
    }
  }));
  const available = rows.filter(row => row.financial || row.revenue || row.valuation);
  const coverageWeight = round(major.reduce((sum, row) => sum + row.weight, 0), 2);
  const financialWeight = rows.filter(row => Number.isFinite(row.financial?.netIncome))
    .reduce((sum, row) => sum + row.weight, 0);
  const profitableWeight = financialWeight
    ? round(rows.filter(row => (row.financial?.netIncome || 0) > 0).reduce((sum, row) => sum + row.weight, 0), 2)
    : null;
  const epsGrowthWeight = rows.filter(row => Number.isFinite(row.financial?.epsYoY))
    .reduce((sum, row) => sum + row.weight, 0);
  const positiveEpsGrowthWeight = epsGrowthWeight
    ? round(rows.filter(row => (row.financial?.epsYoY || 0) > 0).reduce((sum, row) => sum + row.weight, 0), 2)
    : null;
  return {
    holdings: rows.map(row => ({
      code: row.code,
      name: row.name,
      weight: row.weight,
      epsYoY: row.financial?.epsYoY ?? null,
      revenueYoY: row.revenue?.yoy ?? row.financial?.revenueYoY ?? null,
      per: row.valuation?.per ?? null,
      pbr: row.valuation?.pbr ?? null,
      dividendYield: row.valuation?.dividendYield ?? null,
      profitable: row.financial?.netIncome !== null ? (row.financial?.netIncome || 0) > 0 : null,
    })),
    summary: {
      coverageWeight,
      profitableWeight,
      positiveEpsGrowthWeight,
      weightedEpsYoY: weightedMetric(rows, row => row.weight, row => row.financial?.epsYoY ?? null),
      weightedRevenueYoY: weightedMetric(rows, row => row.weight, row => row.revenue?.yoy ?? row.financial?.revenueYoY ?? null),
      weightedPer: weightedMetric(rows, row => row.weight, row => row.valuation?.per ?? null),
      weightedPbr: weightedMetric(rows, row => row.weight, row => row.valuation?.pbr ?? null),
      weightedDividendYield: weightedMetric(rows, row => row.weight, row => row.valuation?.dividendYield ?? null),
      availableComponents: available.length,
    },
  };
}

async function loadEtfProfile(code: string, name: string): Promise<EtfProfile> {
  const cached = etfProfileCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < ETF_PROFILE_TTL_MS) return cached.data;

  const profile: EtfProfile = {
    code,
    name,
    holdingsDate: null,
    holdings: [],
    holdingsSourceUrl: null,
    nav: {
      date: null,
      value: null,
      marketPrice: null,
      premiumDiscount: null,
      sourceUrl: null,
    },
    componentSummary: null,
    warnings: [],
  };

  if (code === "0050") {
    const holdingsUrl = "https://www.yuantaetfs.com/product/detail/0050/ratio";
    const navUrl = "https://www.yuantaetfs.com/tradeInfo/pcf/0050";
    try {
      const [holdingsHtml, navHtml, quote] = await Promise.all([
        fetchText(holdingsUrl, 18000),
        fetchText(navUrl, 18000),
        fetchTwseMis(code),
      ]);
      const holdingsResult = parseYuantaHoldings(holdingsHtml);
      const navResult = parseYuantaNav(navHtml);
      profile.holdingsDate = holdingsResult.date;
      profile.holdings = holdingsResult.holdings;
      profile.holdingsSourceUrl = holdingsUrl;
      profile.nav.date = navResult.date;
      profile.nav.value = navResult.value;
      profile.nav.marketPrice = finiteOrNull(quote?.close);
      profile.nav.premiumDiscount = profile.nav.value && profile.nav.marketPrice !== null
        ? round(((profile.nav.marketPrice / profile.nav.value) - 1) * 100, 2)
        : null;
      profile.nav.sourceUrl = navUrl;
      if (profile.holdings.length) {
        const components = await buildEtfComponentSummary(profile.holdings);
        profile.holdings = components.holdings;
        profile.componentSummary = components.summary;
      } else {
        profile.warnings.push("\u5143\u5927\u6295\u4FE1\u6301\u80A1\u9801\u76EE\u524D\u6C92\u6709\u53EF\u89E3\u6790\u7684\u6210\u5206\u80A1\u3002");
      }
    } catch (err) {
      profile.warnings.push(`0050 ETF \u5B98\u65B9\u8CC7\u6599\u66AB\u6642\u7121\u6CD5\u53D6\u5F97\uFF1A${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    profile.warnings.push("\u76EE\u524D\u5B8C\u6574\u6210\u5206\u80A1\u8207\u6DE8\u503C\u805A\u5408\u5148\u652F\u63F4 0050\uFF0C\u5176\u4ED6 ETF \u4ECD\u4FDD\u7559\u6CD5\u4EBA\u8207\u7C4C\u78BC\u8CC7\u6599\u3002");
  }

  etfProfileCache.set(code, { data: profile, fetchedAt: Date.now() });
  return profile;
}

async function loadFundamentals(code: string) {
  const authenticated = Boolean(await getFinMindToken());
  let infoResult: FinMindDatasetResult | null = null;
  try {
    infoResult = await requestFinMindDataset("TaiwanStockInfo", code);
  } catch {
    infoResult = null;
  }
  const infoRows = infoResult?.data || [];
  const stockInfo = latestRow(infoRows);
  const isEtf = infoRows.some(row =>
    String(row?.industry_category || "").trim().toUpperCase().includes("ETF")
  ) || code === "0050";
  const assetType = isEtf ? "etf" : "stock";
  const datasets = assetType === "etf"
    ? [
        "TaiwanStockInstitutionalInvestorsBuySellWide",
        "TaiwanStockShareholding",
        "TaiwanStockMarginPurchaseShortSale",
        "TaiwanStockSecuritiesLending",
      ]
    : [
        "TaiwanStockFinancialStatements",
        "TaiwanStockBalanceSheet",
        "TaiwanStockCashFlowsStatement",
        "TaiwanStockMonthRevenue",
        "TaiwanStockPER",
        "TaiwanStockInstitutionalInvestorsBuySellWide",
        "TaiwanStockShareholding",
        "TaiwanStockMarginPurchaseShortSale",
        "TaiwanStockSecuritiesLending",
      ];
  const results = await Promise.allSettled(datasets.map(dataset => requestFinMindDataset(dataset, code)));
  const available = new Map<string, FinMindDatasetResult>();
  if (infoResult) available.set("TaiwanStockInfo", infoResult);
  const errors: Array<{ dataset: string; code: string; message: string }> = [];
  results.forEach((result, index) => {
    const dataset = datasets[index];
    if (result.status === "fulfilled") {
      available.set(dataset, result.value);
    } else {
      const reason = result.reason;
      errors.push({
        dataset,
        code: reason instanceof FinMindError ? reason.code : "upstream_error",
        message: finMindPublicMessage(reason),
      });
    }
  });

  const rows = (dataset: string) => available.get(dataset)?.data || [];
  const successful = [...available.values()];
  const staleDatasets = successful.filter(result => result.stale).map(result => result.dataset);
  const cachedDatasets = successful.filter(result => result.cached).map(result => result.dataset);
  const fetchedTimes = successful.map(result => Date.parse(result.fetchedAt)).filter(Number.isFinite);
  const etf = assetType === "etf"
    ? await loadEtfProfile(code, stockInfo?.stock_name || FALLBACK_NAMES[code] || code)
    : null;

  return {
    ok: successful.length > 0,
    partial: errors.length > 0 || staleDatasets.length > 0,
    code,
    assetType,
    source: "FinMind",
    sourceUrl: FINMIND_SOURCE_URL,
    requestMode: authenticated ? "token" : "anonymous",
    generatedAt: new Date().toISOString(),
    fetchedAt: fetchedTimes.length ? new Date(Math.max(...fetchedTimes)).toISOString() : null,
    cache: {
      cachedDatasets,
      staleDatasets,
      policy: "\u8CA1\u5831 6 \u5C0F\u6642\u3001\u6708\u71DF\u6536 2 \u5C0F\u6642\u3001\u4F30\u503C\u8207\u7C4C\u78BC 30 \u5206\u9418\uFF1B\u4F86\u6E90\u5931\u6557\u6642\u6700\u591A\u6CBF\u7528 24 \u5C0F\u6642\u820A\u5FEB\u53D6\u3002",
    },
    data: {
      profitability: assetType === "stock" ? buildFinancialSummary(rows("TaiwanStockFinancialStatements")) : null,
      revenue: assetType === "stock" ? buildRevenueSummary(rows("TaiwanStockMonthRevenue")) : null,
      valuation: assetType === "stock" ? buildValuationSummary(rows("TaiwanStockPER")) : null,
      cashFlow: assetType === "stock" ? buildCashFlowSummary(rows("TaiwanStockCashFlowsStatement")) : null,
      balanceSheet: assetType === "stock" ? buildBalanceSheetSummary(rows("TaiwanStockBalanceSheet")) : null,
      institutional: buildInstitutionalSummary(rows("TaiwanStockInstitutionalInvestorsBuySellWide")),
      foreignShareholding: buildShareholdingSummary(rows("TaiwanStockShareholding")),
      margin: buildMarginSummary(rows("TaiwanStockMarginPurchaseShortSale")),
      securitiesLending: buildLendingSummary(rows("TaiwanStockSecuritiesLending")),
      etf,
    },
    errors,
  };
}

type ScoreComponent = {
  score: number | null;
  label: string;
  weight: number;
  evidence: string[];
  missing: string[];
};

type ValueScore = {
  ok: boolean;
  code: string;
  name: string;
  market: string;
  close: number;
  quoteDate: string | null;
  change: number | null;
  volume: number;
  source: {
    quote: string;
    fundamentals: string;
    valuationModel: string;
  };
  generatedAt: string;
  fairValue: {
    value: number | null;
    upsidePct: number | null;
    methods: Array<{ name: string; value: number | null; weight: number; note: string }>;
    note: string;
  };
  scores: {
    undervalued: number | null;
    overvalued: number | null;
    smallInvestor: number | null;
    valuation: ScoreComponent;
    cashFlow: ScoreComponent;
    growth: ScoreComponent;
    profitability: ScoreComponent;
    financialStability: ScoreComponent;
    marketConfidence: ScoreComponent;
    chaseRisk: ScoreComponent;
  };
  dataStatus: {
    quoteDate: string | null;
    generatedAt: string;
    assetType: string;
    requestMode: string;
    coverage: {
      available: number;
      total: number;
      percent: number;
      label: string;
    };
    datasets: Array<{ key: string; label: string; date: string | null; available: boolean; missing: string[] }>;
    missingItems: string[];
    cachedDatasets: string[];
    staleDatasets: string[];
    warnings: string[];
  };
  professionalRating: {
    total: number | null;
    grade: "A" | "B" | "C" | "D" | "X";
    gradeLabel: string;
    modelVersion: string;
    assetModel: "stock" | "etf";
    components: Array<{ key: string; label: string; score: number | null; weight: number; evidence: string[]; missing: string[]; whyDeducted: string[] }>;
    stopTrackingAssumption: string;
    note: string;
  };
  rating: {
    smallInvestorLabel: string;
    valuationLabel: string;
    marketConfidenceLabel: string;
    analystConsensus: {
      available: false;
      label: string;
      note: string;
    };
  };
  allocationGuide: {
    action: string;
    firstBuyPct: number;
    cashReservePct: number;
    notes: string[];
  };
  cfoGuide: {
    action: string;
    actionLabel: string;
    singleEntryLimitPct: number;
    maxHoldingPct: number;
    worstCaseLossPct: number | null;
    stopTrackingAssumption: string;
    notes: string[];
  };
  warnings: string[];
  fundamentals: Awaited<ReturnType<typeof loadFundamentals>>;
};

const TAIWAN_UNIVERSE_VERSION = "tw-liquid-v1-2026-06";
const TAIWAN_COMPANY_UNIVERSE_VERSION = "finmind-tw-company-universe-2026-07";
const TAIWAN_COMPANY_TYPES = new Set(["twse", "tpex", "emerging"]);
const OFFICIAL_TAIWAN_COMPANY_UNIVERSE_ENDPOINTS = [
  { type: "twse", source: "TWSE t187ap03_L", url: "https://openapi.twse.com.tw/v1/opendata/t187ap03_L" },
  { type: "tpex", source: "TPEx mopsfin_t187ap03_O", url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O" },
  { type: "emerging", source: "TPEx mopsfin_t187ap03_R", url: "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_R" },
];
const TAIWAN_NON_COMPANY_KEYWORDS = [
  "ETF",
  "\u6307\u6578\u80a1\u7968\u578b\u57fa\u91d1",
  "\u53d7\u76ca\u8b49\u5238",
  "\u5b58\u8a17\u6191\u8b49",
  "ETN",
  "\u50b5",
  "\u671f\u8ca8",
  "\u8a8d\u8cfc",
  "\u8a8d\u552e",
];
const TAIWAN_SCREENING_UNIVERSE = [
  { code: "0050", name: "Yuanta Taiwan 50", group: "ETF core" },
  { code: "006208", name: "Fubon Taiwan 50", group: "ETF core" },
  { code: "00878", name: "Cathay Taiwan ESG Dividend", group: "ETF income" },
  { code: "0056", name: "Yuanta High Dividend", group: "ETF income" },
  { code: "1101", name: "Taiwan Cement", group: "materials" },
  { code: "1102", name: "Asia Cement", group: "materials" },
  { code: "1216", name: "Uni-President", group: "consumer" },
  { code: "1301", name: "Formosa Plastics", group: "plastics" },
  { code: "1303", name: "Nan Ya Plastics", group: "plastics" },
  { code: "2002", name: "China Steel", group: "steel" },
  { code: "2303", name: "UMC", group: "semiconductor" },
  { code: "2308", name: "Delta Electronics", group: "electronics" },
  { code: "2317", name: "Hon Hai", group: "electronics" },
  { code: "2330", name: "TSMC", group: "semiconductor" },
  { code: "2344", name: "Winbond", group: "semiconductor" },
  { code: "2356", name: "Inventec", group: "electronics" },
  { code: "2357", name: "ASUS", group: "electronics" },
  { code: "2379", name: "Realtek", group: "semiconductor" },
  { code: "2382", name: "Quanta", group: "electronics" },
  { code: "2395", name: "Advantech", group: "industrial computer" },
  { code: "2408", name: "Nanya Technology", group: "semiconductor" },
  { code: "2412", name: "Chunghwa Telecom", group: "telecom" },
  { code: "2454", name: "MediaTek", group: "semiconductor" },
  { code: "2603", name: "Evergreen Marine", group: "shipping" },
  { code: "2609", name: "Yang Ming", group: "shipping" },
  { code: "2615", name: "Wan Hai", group: "shipping" },
  { code: "2880", name: "Hua Nan Financial", group: "financial" },
  { code: "2881", name: "Fubon Financial", group: "financial" },
  { code: "2882", name: "Cathay Financial", group: "financial" },
  { code: "2884", name: "E.SUN Financial", group: "financial" },
  { code: "2885", name: "Yuanta Financial", group: "financial" },
  { code: "2886", name: "Mega Financial", group: "financial" },
  { code: "2887", name: "Taishin Financial", group: "financial" },
  { code: "2891", name: "CTBC Financial", group: "financial" },
  { code: "2892", name: "First Financial", group: "financial" },
  { code: "3008", name: "Largan", group: "optics" },
  { code: "3034", name: "Novatek", group: "semiconductor" },
  { code: "3231", name: "Wistron", group: "electronics" },
  { code: "3711", name: "ASE Technology", group: "semiconductor" },
  { code: "4938", name: "Pegatron", group: "electronics" },
  { code: "5880", name: "Taiwan Cooperative Financial", group: "financial" },
  { code: "6505", name: "Formosa Petrochemical", group: "petrochemical" },
  { code: "6669", name: "Wiwynn", group: "server" },
];
const DEFAULT_SCREENER_UNIVERSE = TAIWAN_SCREENING_UNIVERSE.map(item => item.code);
const CUSTOM_SCREENER_LIMIT = 40;

const SCORE_SOURCE_NOTE = "Transparent model: Yahoo/TWSE quotes plus FinMind financial data; no InvestingPro data or third-party analyst consensus is used.";

function summarizeTaiwanCompanies(companies: Array<{ code: string; name: string; type: string; industry: string }>) {
  return companies.reduce((acc: Record<string, number>, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
}

function buildTaiwanCompanyUniverseFromFinMind(info: FinMindDatasetResult) {
  const byCode = new Map<string, { code: string; name: string; type: string; industry: string }>();
  const rawUnique = new Set<string>();
  for (const row of info.data) {
    const code = cleanCode(row.stock_id);
    if (!code) continue;
    rawUnique.add(code);
    const type = String(row.type || "").toLowerCase();
    const industry = String(row.industry_category || "");
    if (!/^\d{4}$/.test(code)) continue;
    if (!TAIWAN_COMPANY_TYPES.has(type)) continue;
    if (TAIWAN_NON_COMPANY_KEYWORDS.some(keyword => industry.toUpperCase().includes(keyword))) continue;
    if (!byCode.has(code)) {
      byCode.set(code, {
        code,
        name: String(row.stock_name || FALLBACK_NAMES[code] || code),
        type,
        industry,
      });
    }
  }
  const companies = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  const counts = summarizeTaiwanCompanies(companies);
  return {
    ok: true,
    version: TAIWAN_COMPANY_UNIVERSE_VERSION,
    source: "FinMind TaiwanStockInfo",
    fetchedAt: info.fetchedAt,
    cached: info.cached,
    stale: info.stale,
    warning: info.warning || null,
    rawRows: info.data.length,
    rawUniqueCodes: rawUnique.size,
    companyCount: companies.length,
    counts,
    filter: "4-digit twse/tpex/emerging companies; ETF, bond ETF, ETN, warrants, DR and fund-like products are excluded.",
    samples: companies.slice(0, 20),
  };
}

function rowValue(row: any, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

async function requestOfficialCompanyRows(endpoint: typeof OFFICIAL_TAIWAN_COMPANY_UNIVERSE_ENDPOINTS[number]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(endpoint.url, { signal: controller.signal, headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint.source} HTTP ${res.status}: ${text.slice(0, 120)}`);
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error(`${endpoint.source} returned a non-array payload`);
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

async function loadOfficialTaiwanCompanyUniverseFallback(finMindError: unknown) {
  const settled = await Promise.allSettled(
    OFFICIAL_TAIWAN_COMPANY_UNIVERSE_ENDPOINTS.map(async endpoint => ({ endpoint, rows: await requestOfficialCompanyRows(endpoint) }))
  );
  const byCode = new Map<string, { code: string; name: string; type: string; industry: string }>();
  const rawUnique = new Set<string>();
  const warnings: string[] = [];
  let rawRows = 0;
  for (const result of settled) {
    if (result.status === "rejected") {
      warnings.push(String(result.reason?.message || result.reason || "official endpoint failed"));
      continue;
    }
    const { endpoint, rows } = result.value;
    rawRows += rows.length;
    for (const row of rows) {
      const code = cleanCode(rowValue(row, ["SecuritiesCompanyCode", "\u516C\u53F8\u4EE3\u865F"]));
      if (!/^\d{4}$/.test(code)) continue;
      rawUnique.add(code);
      if (!byCode.has(code)) {
        byCode.set(code, {
          code,
          name: rowValue(row, ["CompanyAbbreviation", "CompanyName", "\u516C\u53F8\u7C21\u7A31", "\u516C\u53F8\u540D\u7A31"]) || FALLBACK_NAMES[code] || code,
          type: endpoint.type,
          industry: rowValue(row, ["SecuritiesIndustryCode", "\u7522\u696D\u5225"]),
        });
      }
    }
  }
  const companies = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  if (!companies.length) {
    throw new Error(`Unable to load Taiwan company universe from FinMind or official fallback: ${String((finMindError as Error)?.message || finMindError || "unknown error")}`);
  }
  const counts = summarizeTaiwanCompanies(companies);
  return {
    ok: true,
    version: `${TAIWAN_COMPANY_UNIVERSE_VERSION}-official-fallback`,
    source: "TWSE/TPEx OpenAPI fallback",
    fetchedAt: new Date().toISOString(),
    cached: false,
    stale: true,
    warning: [
      `FinMind unavailable: ${String((finMindError as Error)?.message || finMindError || "unknown error")}`,
      ...warnings,
    ].filter(Boolean).join(" | "),
    rawRows,
    rawUniqueCodes: rawUnique.size,
    companyCount: companies.length,
    counts,
    filter: "Official listed, OTC, and emerging company profile endpoints; used only when FinMind TaiwanStockInfo is temporarily unavailable.",
    samples: companies.slice(0, 20),
  };
}

async function loadTaiwanCompanyUniverse() {
  try {
    const info = await requestFinMindDataset("TaiwanStockInfo", "");
    return buildTaiwanCompanyUniverseFromFinMind(info);
  } catch (err) {
    return loadOfficialTaiwanCompanyUniverseFallback(err);
  }
}

function scoreLabel(score: number | null, high = "strong", mid = "neutral", low = "weak") {
  if (score === null) return "insufficient data";
  if (score >= 80) return high;
  if (score >= 60) return mid;
  if (score >= 40) return mid;
  return low;
}

function weightedScore(parts: Array<{ score: number | null; weight: number }>) {
  const usable = parts.filter(part => part.score !== null && Number.isFinite(part.score) && part.weight > 0);
  const totalWeight = usable.reduce((sum, part) => sum + part.weight, 0);
  if (!totalWeight) return null;
  return Math.round(usable.reduce((sum, part) => sum + (part.score as number) * part.weight, 0) / totalWeight);
}

function scoreFromThresholds(value: number | null | undefined, thresholds: Array<[number, number]>, missing: string) {
  if (!Number.isFinite(value)) {
    return { score: null, missing: [missing] };
  }
  for (const [limit, score] of thresholds) {
    if ((value as number) <= limit) return { score, missing: [] };
  }
  return { score: thresholds[thresholds.length - 1][1], missing: [] };
}

function positiveGrowthScore(value: number | null | undefined) {
  if (!Number.isFinite(value)) return null;
  const n = value as number;
  if (n >= 40) return 95;
  if (n >= 20) return 85;
  if (n >= 10) return 75;
  if (n >= 0) return 62;
  if (n >= -10) return 42;
  if (n >= -25) return 25;
  return 10;
}

function valueFromYield(close: number, dividendYield: number | null | undefined) {
  if (!Number.isFinite(close) || !Number.isFinite(dividendYield) || (dividendYield as number) <= 0) return null;
  const targetYield = 4;
  return round(close * ((dividendYield as number) / targetYield));
}

function gradeFromScore(score: number | null, coveragePct: number): "A" | "B" | "C" | "D" | "X" {
  if (score === null || coveragePct < 45) return "X";
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  return "D";
}

function gradeLabel(grade: string) {
  if (grade === "A") return "worth deeper review";
  if (grade === "B") return "watchlist candidate";
  if (grade === "C") return "wait for better price or data";
  if (grade === "D") return "avoid for now";
  return "insufficient data";
}

function deductionReasons(score: number | null, missing: string[], riskText: string) {
  const reasons: string[] = [];
  if (missing.length) reasons.push(`Missing: ${missing.slice(0, 3).join(", ")}`);
  if (score !== null && score < 50) reasons.push(riskText);
  if (!reasons.length) reasons.push("No major deduction from available data.");
  return reasons;
}

function componentForProfessional(key: string, label: string, score: number | null, weight: number, evidence: string[], missing: string[], riskText: string) {
  return {
    key,
    label,
    score,
    weight,
    evidence,
    missing,
    whyDeducted: deductionReasons(score, missing, riskText),
  };
}

function buildCfoGuide(total: number | null, chaseRiskScore: number | null, downsidePct: number | null, close: number) {
  const highChase = chaseRiskScore !== null && chaseRiskScore >= 72;
  const grade = gradeFromScore(total, total === null ? 0 : 100);
  const action = highChase
    ? "wait_pullback"
    : total !== null && total >= 70
      ? "stage_entry"
      : total !== null && total >= 55
        ? "small_watch"
        : "avoid";
  const singleEntryLimitPct = action === "stage_entry" ? 25 : action === "small_watch" ? 12 : action === "wait_pullback" ? 8 : 0;
  const maxHoldingPct = grade === "A" ? 18 : grade === "B" ? 12 : grade === "C" ? 8 : 4;
  const worstCaseLossPct = Number.isFinite(downsidePct)
    ? Math.max(8, Math.min(35, Math.round(Math.abs(downsidePct as number))))
    : Number.isFinite(close) ? 15 : null;
  return {
    action,
    actionLabel: action === "stage_entry" ? "\u5206\u6279\u9032\u5834" : action === "small_watch" ? "\u5C0F\u984D\u89C0\u5BDF\u90E8\u4F4D" : action === "wait_pullback" ? "\u7B49\u5F85\u56DE\u6A94" : "\u907F\u514D\u65B0\u589E\u90E8\u4F4D",
    singleEntryLimitPct,
    maxHoldingPct,
    worstCaseLossPct,
    stopTrackingAssumption: highChase
      ? "\u82E5\u50F9\u683C\u6301\u7E8C\u588A\u9AD8\u4F46\u5206\u6578\u54C1\u8CEA\u6C92\u6709\u6539\u5584\uFF0C\u5148\u505C\u6B62\u628A\u5B83\u5217\u70BA\u9032\u5834\u5019\u9078\u3002"
      : "\u82E5\u4F30\u503C\u3001\u73FE\u91D1\u6D41\u6216\u6210\u9577\u8CC7\u6599\u60E1\u5316\uFF0C\u540C\u6642\u50F9\u683C\u4ECD\u504F\u8CB4\uFF0C\u5148\u505C\u6B62\u8FFD\u8E64\u3002",
    notes: [
      "\u9019\u662F\u8CC7\u91D1\u63A7\u7BA1\u60C5\u5883\uFF0C\u4E0D\u662F\u500B\u4EBA\u5316\u8CB7\u8CE3\u6307\u793A\u3002",
      `\u55AE\u6B21\u6295\u5165\u61C9\u4F4E\u65BC\u898F\u5283\u90E8\u4F4D\u7684 ${singleEntryLimitPct}%\u3002`,
      `\u5728\u56DE\u6E2C\u8207\u8CC7\u6599\u8986\u84CB\u66F4\u5B8C\u6574\u4EE5\u524D\uFF0C\u55AE\u4E00\u500B\u80A1\u61C9\u4F4E\u65BC\u6295\u8CC7\u7D44\u5408\u7684 ${maxHoldingPct}%\u3002`,
    ],
  };
}

function buildValueScores(quote: QuoteInfo, fundamentals: Awaited<ReturnType<typeof loadFundamentals>>): ValueScore {
  const data = fundamentals.data;
  const profit = data.profitability;
  const revenue = data.revenue;
  const valuation = data.valuation;
  const cashFlow = data.cashFlow;
  const balance = data.balanceSheet;
  const institutional = data.institutional;
  const foreign = data.foreignShareholding;
  const margin = data.margin;
  const lending = data.securitiesLending;
  const latest = quote.analysis.latest;
  const close = quote.close;
  const warnings: string[] = [];

  if (fundamentals.assetType === "etf") {
    warnings.push("ETF has no single-company income statement, cash flow statement, or balance sheet; this model only uses available ETF NAV, holdings summary, and market data.");
  }
  fundamentals.errors.forEach(item => warnings.push(`${item.dataset}: ${item.message}`));

  const perScore = Number.isFinite(valuation?.per) && (valuation?.per || 0) > 0
    ? scoreFromThresholds(valuation?.per, [[10, 95], [15, 85], [22, 68], [30, 50], [45, 30], [999, 15]], "PER").score
    : null;
  const pbrScore = Number.isFinite(valuation?.pbr) && (valuation?.pbr || 0) > 0
    ? scoreFromThresholds(valuation?.pbr, [[1, 90], [1.8, 76], [3, 55], [5, 34], [999, 18]], "PBR").score
    : null;
  const yieldScore = Number.isFinite(valuation?.dividendYield) && (valuation?.dividendYield || 0) >= 0
    ? Math.max(15, Math.min(95, Math.round((valuation?.dividendYield || 0) * 16)))
    : null;
  const rangeScore = Number.isFinite(latest.week52High) && Number.isFinite(latest.week52Low) && latest.week52High > latest.week52Low
    ? Math.max(15, Math.min(95, Math.round(95 - (((close - latest.week52Low) / (latest.week52High - latest.week52Low)) * 70))))
    : null;
  const valuationComponent: ScoreComponent = {
    score: weightedScore([
      { score: perScore, weight: 35 },
      { score: pbrScore, weight: 25 },
      { score: yieldScore, weight: 15 },
      { score: rangeScore, weight: 25 },
    ]),
    label: "",
    weight: 35,
    evidence: [
      Number.isFinite(valuation?.per) ? `PER ${fmt(valuation?.per || NaN, 2)}` : "",
      Number.isFinite(valuation?.pbr) ? `PBR ${fmt(valuation?.pbr || NaN, 2)}` : "",
      Number.isFinite(valuation?.dividendYield) ? `dividend yield ${fmt(valuation?.dividendYield || NaN, 2)}%` : "",
      Number.isFinite(rangeScore) ? `52-week range score ${rangeScore}` : "",
    ].filter(Boolean),
    missing: [
      perScore === null ? "PER" : "",
      pbrScore === null ? "PBR" : "",
      yieldScore === null ? "dividend yield" : "",
      rangeScore === null ? "52-week range" : "",
    ].filter(Boolean),
  };
  valuationComponent.label = scoreLabel(valuationComponent.score, "valuation inexpensive", "valuation fair", "valuation expensive");

  const ocfScore = Number.isFinite(cashFlow?.operatingCashFlow) ? ((cashFlow?.operatingCashFlow || 0) > 0 ? 82 : 20) : null;
  const fcfScore = Number.isFinite(cashFlow?.freeCashFlow) ? ((cashFlow?.freeCashFlow || 0) > 0 ? 86 : 18) : null;
  const cashChangeScore = Number.isFinite(cashFlow?.cashChange) ? ((cashFlow?.cashChange || 0) >= 0 ? 70 : 42) : null;
  const endingCashScore = Number.isFinite(cashFlow?.endingCash) ? ((cashFlow?.endingCash || 0) > 0 ? 68 : 35) : null;
  const cashFlowComponent: ScoreComponent = {
    score: weightedScore([
      { score: ocfScore, weight: 35 },
      { score: fcfScore, weight: 35 },
      { score: cashChangeScore, weight: 15 },
      { score: endingCashScore, weight: 15 },
    ]),
    label: "",
    weight: 20,
    evidence: [
      Number.isFinite(cashFlow?.operatingCashFlow) ? `operating cash flow ${fmt(cashFlow?.operatingCashFlow || NaN, 0)}` : "",
      Number.isFinite(cashFlow?.freeCashFlow) ? `free cash flow ${fmt(cashFlow?.freeCashFlow || NaN, 0)}` : "",
      Number.isFinite(cashFlow?.cashChange) ? `cash change ${fmt(cashFlow?.cashChange || NaN, 0)}` : "",
    ].filter(Boolean),
    missing: [
      ocfScore === null ? "operating cash flow" : "",
      fcfScore === null ? "free cash flow" : "",
      cashChangeScore === null ? "cash change" : "",
    ].filter(Boolean),
  };
  cashFlowComponent.label = scoreLabel(cashFlowComponent.score, "cash flow strong", "cash flow neutral", "cash flow weak");

  const monthlyRevenueScore = positiveGrowthScore(revenue?.yoy);
  const revenueMomentumScore = Number.isFinite(revenue?.growthMomentum)
    ? positiveGrowthScore(revenue?.growthMomentum)
    : null;
  const epsGrowthScore = positiveGrowthScore(profit?.epsYoY);
  const quarterRevenueScore = positiveGrowthScore(profit?.revenueYoY);
  const growthComponent: ScoreComponent = {
    score: weightedScore([
      { score: monthlyRevenueScore, weight: 35 },
      { score: revenueMomentumScore, weight: 20 },
      { score: epsGrowthScore, weight: 25 },
      { score: quarterRevenueScore, weight: 20 },
    ]),
    label: "",
    weight: 20,
    evidence: [
      Number.isFinite(revenue?.yoy) ? `monthly revenue YoY ${fmt(revenue?.yoy || NaN, 2)}%` : "",
      Number.isFinite(revenue?.growthMomentum) ? `3-month revenue momentum ${fmt(revenue?.growthMomentum || NaN, 2)} pts` : "",
      Number.isFinite(profit?.epsYoY) ? `EPS YoY ${fmt(profit?.epsYoY || NaN, 2)}%` : "",
      Number.isFinite(profit?.revenueYoY) ? `quarterly revenue YoY ${fmt(profit?.revenueYoY || NaN, 2)}%` : "",
    ].filter(Boolean),
    missing: [
      monthlyRevenueScore === null ? "monthly revenue YoY" : "",
      revenueMomentumScore === null ? "revenue momentum" : "",
      epsGrowthScore === null ? "EPS YoY" : "",
      quarterRevenueScore === null ? "quarterly revenue YoY" : "",
    ].filter(Boolean),
  };
  growthComponent.label = scoreLabel(growthComponent.score, "growth strong", "growth stable", "growth weak");

  const epsScore = Number.isFinite(profit?.eps) ? ((profit?.eps || 0) > 0 ? 78 : 22) : null;
  const netIncomeScore = Number.isFinite(profit?.netIncome) ? ((profit?.netIncome || 0) > 0 ? 82 : 20) : null;
  const opIncomeScore = Number.isFinite(profit?.operatingIncome) ? ((profit?.operatingIncome || 0) > 0 ? 76 : 26) : null;
  const grossProfitScore = Number.isFinite(profit?.grossProfit) ? ((profit?.grossProfit || 0) > 0 ? 68 : 32) : null;
  const profitabilityComponent: ScoreComponent = {
    score: weightedScore([
      { score: epsScore, weight: 30 },
      { score: netIncomeScore, weight: 35 },
      { score: opIncomeScore, weight: 20 },
      { score: grossProfitScore, weight: 15 },
    ]),
    label: "",
    weight: 15,
    evidence: [
      Number.isFinite(profit?.eps) ? `EPS ${fmt(profit?.eps || NaN, 2)}` : "",
      Number.isFinite(profit?.netIncome) ? `net income ${fmt(profit?.netIncome || NaN, 0)}` : "",
      Number.isFinite(profit?.operatingIncome) ? `operating income ${fmt(profit?.operatingIncome || NaN, 0)}` : "",
    ].filter(Boolean),
    missing: [
      epsScore === null ? "EPS" : "",
      netIncomeScore === null ? "net income" : "",
      opIncomeScore === null ? "operating income" : "",
    ].filter(Boolean),
  };
  profitabilityComponent.label = scoreLabel(profitabilityComponent.score, "profitability strong", "profitability stable", "profitability weak");

  const debtScore = Number.isFinite(balance?.liabilityRatio)
    ? (balance!.liabilityRatio! <= 35 ? 88 : balance!.liabilityRatio! <= 55 ? 68 : balance!.liabilityRatio! <= 70 ? 44 : 20)
    : null;
  const currentRatioScore = Number.isFinite(balance?.currentRatio)
    ? (balance!.currentRatio! >= 2 ? 88 : balance!.currentRatio! >= 1.2 ? 68 : balance!.currentRatio! >= 1 ? 48 : 22)
    : null;
  const cashScore = Number.isFinite(balance?.cashAndEquivalents) ? ((balance?.cashAndEquivalents || 0) > 0 ? 68 : 35) : null;
  const equityScore = Number.isFinite(balance?.equity) ? ((balance?.equity || 0) > 0 ? 72 : 20) : null;
  const financialStabilityComponent: ScoreComponent = {
    score: weightedScore([
      { score: debtScore, weight: 35 },
      { score: currentRatioScore, weight: 30 },
      { score: cashScore, weight: 20 },
      { score: equityScore, weight: 15 },
    ]),
    label: "",
    weight: 10,
    evidence: [
      Number.isFinite(balance?.liabilityRatio) ? `liability ratio ${fmt(balance?.liabilityRatio || NaN, 2)}%` : "",
      Number.isFinite(balance?.currentRatio) ? `current ratio ${fmt(balance?.currentRatio || NaN, 2)}` : "",
      Number.isFinite(balance?.cashAndEquivalents) ? `cash ${fmt(balance?.cashAndEquivalents || NaN, 0)}` : "",
    ].filter(Boolean),
    missing: [
      debtScore === null ? "liability ratio" : "",
      currentRatioScore === null ? "current ratio" : "",
      cashScore === null ? "cash" : "",
    ].filter(Boolean),
  };
  financialStabilityComponent.label = scoreLabel(financialStabilityComponent.score, "financial stability strong", "financial stability neutral", "financial stability weak");

  const institutionalScore = Number.isFinite(institutional?.totalNet) ? ((institutional?.totalNet || 0) > 0 ? 72 : 38) : null;
  const foreignScore = Number.isFinite(foreign?.fiveDayRatioChange) ? ((foreign?.fiveDayRatioChange || 0) > 0 ? 70 : 42) : null;
  const technicalScore = close > latest.ma20 && latest.ma20 >= latest.ma60 ? 72 : close < latest.ma60 ? 35 : 55;
  const marginRiskScore = Number.isFinite(margin?.marginTwentyDayChange)
    ? ((margin?.marginTwentyDayChange || 0) >= 20 ? 28 : (margin?.marginTwentyDayChange || 0) >= 8 ? 48 : 66)
    : null;
  const marketConfidenceComponent: ScoreComponent = {
    score: weightedScore([
      { score: institutionalScore, weight: 30 },
      { score: foreignScore, weight: 20 },
      { score: technicalScore, weight: 35 },
      { score: marginRiskScore, weight: 15 },
    ]),
    label: "",
    weight: 10,
    evidence: [
      Number.isFinite(institutional?.totalNet) ? `${institutional?.days || 0}-day institutional net ${fmt(institutional?.totalNet || NaN, 0)}` : "",
      Number.isFinite(foreign?.fiveDayRatioChange) ? `foreign ownership change ${fmt(foreign?.fiveDayRatioChange || NaN, 2)} pts` : "",
      `technical trend ${technicalScore}`,
      Number.isFinite(margin?.marginTwentyDayChange) ? `20-day margin change ${fmt(margin?.marginTwentyDayChange || NaN, 2)}%` : "",
    ].filter(Boolean),
    missing: [
      institutionalScore === null ? "institutional net buy/sell" : "",
      foreignScore === null ? "foreign ownership change" : "",
      marginRiskScore === null ? "margin balance change" : "",
    ].filter(Boolean),
  };
  marketConfidenceComponent.label = scoreLabel(marketConfidenceComponent.score, "market confidence strong", "market confidence neutral", "market confidence weak");

  const distanceFromSupport = Number.isFinite(quote.analysis.levels.supportShort) && quote.analysis.levels.supportShort > 0
    ? ((close / quote.analysis.levels.supportShort) - 1) * 100
    : null;
  const chaseRiskComponent: ScoreComponent = {
    score: weightedScore([
      { score: latest.pullback, weight: 35 },
      { score: Number.isFinite(latest.rsi14) ? Math.max(10, Math.min(95, Math.round((latest.rsi14 - 35) * 1.45))) : null, weight: 25 },
      { score: Number.isFinite(latest.pctB) ? Math.max(10, Math.min(95, Math.round(latest.pctB * 95))) : null, weight: 20 },
      { score: Number.isFinite(distanceFromSupport) ? Math.max(15, Math.min(95, Math.round((distanceFromSupport as number) * 4))) : null, weight: 20 },
    ]),
    label: "",
    weight: 15,
    evidence: [
      `\u56DE\u6A94\u6A5F\u7387 ${latest.pullback}%`,
      Number.isFinite(latest.rsi14) ? `RSI ${fmt(latest.rsi14, 1)}` : "",
      Number.isFinite(latest.pctB) ? `Bollinger %B ${fmt(latest.pctB, 2)}` : "",
      Number.isFinite(distanceFromSupport) ? `\u8DDD\u77ED\u7DDA\u652F\u6490 ${fmt(distanceFromSupport || NaN, 2)}%` : "",
    ].filter(Boolean),
    missing: [],
  };
  chaseRiskComponent.label = scoreLabel(chaseRiskComponent.score, "\u8FFD\u9AD8\u98A8\u96AA\u9AD8", "\u8FFD\u9AD8\u98A8\u96AA\u4E2D", "\u8FFD\u9AD8\u98A8\u96AA\u4F4E");

  const fairPer = Math.max(10, Math.min(24, 14 + ((growthComponent.score || 50) - 50) / 5));
  const earningsValue = Number.isFinite(profit?.eps) && (profit?.eps || 0) > 0
    ? round((profit?.eps || 0) * 4 * fairPer)
    : null;
  const bookValue = Number.isFinite(valuation?.pbr) && (valuation?.pbr || 0) > 0
    ? round((close / (valuation?.pbr || 1)) * 1.8)
    : null;
  const dividendValue = valueFromYield(close, valuation?.dividendYield);
  const technicalMean = weightedScore([
    { score: latest.ma60, weight: 45 },
    { score: latest.ma120, weight: 35 },
    { score: (latest.week52High + latest.week52Low) / 2, weight: 20 },
  ]);
  const fairMethods = [
    { name: "\u5E74\u5316 EPS \u5408\u7406\u672C\u76CA\u6BD4", value: earningsValue, weight: 40, note: `\u6700\u65B0 EPS \u5E74\u5316\u5F8C\u5957\u7528\u5408\u7406\u672C\u76CA\u6BD4 ${fmt(fairPer, 1)} \u500D\u3002` },
    { name: "\u6DE8\u503C\u5408\u7406\u80A1\u50F9\u6DE8\u503C\u6BD4", value: bookValue, weight: 25, note: "\u7531\u76EE\u524D PBR \u53CD\u63A8\u6BCF\u80A1\u6DE8\u503C\uFF0C\u518D\u5957\u7528 1.8 \u500D PBR\u3002" },
    { name: "\u80A1\u5229\u6B96\u5229\u7387\u53CD\u63A8\u50F9\u503C", value: dividendValue, weight: 15, note: "\u4F7F\u7528 4% \u76EE\u6A19\u6B96\u5229\u7387\uFF1B\u7F3A\u80A1\u5229\u6B96\u5229\u7387\u6642\u6392\u9664\u3002" },
    { name: "\u6280\u8853\u5747\u503C", value: technicalMean, weight: 20, note: "\u4F7F\u7528 MA60\u3001MA120 \u8207 52 \u9031\u4E2D\u4F4D\u50F9\u4F5C\u5747\u503C\u56DE\u6B78\u53C3\u8003\u3002" },
  ];
  const fairValue = weightedScore(fairMethods.map(method => ({ score: method.value, weight: method.weight })));
  const upsidePct = fairValue && close > 0 ? round(((fairValue / close) - 1) * 100, 2) : null;
  const upsideScore = Number.isFinite(upsidePct)
    ? Math.max(5, Math.min(95, Math.round(50 + (upsidePct as number))))
    : null;
  const downsideScore = Number.isFinite(upsidePct)
    ? Math.max(5, Math.min(95, Math.round(50 - (upsidePct as number))))
    : null;
  const qualityScore = weightedScore([
    { score: cashFlowComponent.score, weight: 28 },
    { score: growthComponent.score, weight: 26 },
    { score: profitabilityComponent.score, weight: 24 },
    { score: financialStabilityComponent.score, weight: 22 },
  ]);
  const undervalued = weightedScore([
    { score: valuationComponent.score, weight: 30 },
    { score: upsideScore, weight: 25 },
    { score: cashFlowComponent.score, weight: 15 },
    { score: growthComponent.score, weight: 15 },
    { score: profitabilityComponent.score, weight: 10 },
    { score: marketConfidenceComponent.score, weight: 5 },
    { score: chaseRiskComponent.score === null ? null : 100 - chaseRiskComponent.score, weight: 10 },
  ]);
  const weakGrowthScore = growthComponent.score === null ? null : 100 - growthComponent.score;
  const weakCashFlowScore = cashFlowComponent.score === null ? null : 100 - cashFlowComponent.score;
  const weakProfitScore = profitabilityComponent.score === null ? null : 100 - profitabilityComponent.score;
  const overvalued = weightedScore([
    { score: valuationComponent.score === null ? null : 100 - valuationComponent.score, weight: 25 },
    { score: downsideScore, weight: 25 },
    { score: weakGrowthScore, weight: 20 },
    { score: weakCashFlowScore, weight: 15 },
    { score: weakProfitScore, weight: 10 },
    { score: chaseRiskComponent.score, weight: 15 },
  ]);
  const smallInvestor = weightedScore([
    { score: financialStabilityComponent.score, weight: 25 },
    { score: cashFlowComponent.score, weight: 20 },
    { score: valuationComponent.score, weight: 20 },
    { score: chaseRiskComponent.score === null ? null : 100 - chaseRiskComponent.score, weight: 15 },
    { score: qualityScore, weight: 10 },
    { score: Number.isFinite(quote.volume) && quote.volume > 0 ? 75 : null, weight: 10 },
  ]);
  const action = chaseRiskComponent.score !== null && chaseRiskComponent.score >= 72
    ? "wait for pullback"
    : smallInvestor !== null && smallInvestor >= 70 && undervalued !== null && undervalued >= 62
      ? "stage entries"
      : smallInvestor !== null && smallInvestor >= 55
        ? "small watch position"
        : "do not chase";
  const firstBuyPct = action === "stage entries" ? 35 : action === "small watch position" ? 20 : action === "wait for pullback" ? 10 : 0;
  const cashReservePct = action === "stage entries" ? 25 : action === "small watch position" ? 40 : 60;
  const dataStatusDatasets = [
    { key: "quote", label: "Quote", date: quote.quoteDate, available: Boolean(quote.quoteDate && Number.isFinite(quote.close)), missing: quote.quoteDate ? [] : ["quote date"] },
    { key: "valuation", label: "Valuation", date: valuation?.date || null, available: valuationComponent.score !== null, missing: valuationComponent.missing },
    { key: "cashFlow", label: "Cash flow", date: cashFlow?.date || null, available: cashFlowComponent.score !== null, missing: cashFlowComponent.missing },
    { key: "growth", label: "Growth", date: revenue?.date || profit?.date || null, available: growthComponent.score !== null, missing: growthComponent.missing },
    { key: "profitability", label: "Profitability", date: profit?.date || null, available: profitabilityComponent.score !== null, missing: profitabilityComponent.missing },
    { key: "financialStability", label: "\u8CA1\u52D9\u7A69\u5065", date: balance?.date || null, available: financialStabilityComponent.score !== null, missing: financialStabilityComponent.missing },
    { key: "marketConfidence", label: "Market confidence", date: institutional?.date || foreign?.date || margin?.date || lending?.date || null, available: marketConfidenceComponent.score !== null, missing: marketConfidenceComponent.missing },
  ];
  const availableDatasets = dataStatusDatasets.filter(item => item.available).length;
  const missingItems = dataStatusDatasets.flatMap(item =>
    item.missing.map(missing => `${item.label}: ${missing}`)
  );
  const dataCoveragePct = Math.round((availableDatasets / dataStatusDatasets.length) * 100);
  const technicalPositionScore = chaseRiskComponent.score === null ? null : Math.max(0, Math.min(100, 100 - chaseRiskComponent.score));
  const smallBudgetScore = weightedScore([
    { score: Number.isFinite(close) && close > 0 ? Math.max(15, Math.min(95, Math.round(95 - Math.log10(Math.max(1, close)) * 18))) : null, weight: 35 },
    { score: Number.isFinite(quote.volume) && quote.volume > 0 ? 75 : null, weight: 25 },
    { score: technicalPositionScore, weight: 25 },
    { score: financialStabilityComponent.score, weight: 15 },
  ]);
  const etf = data.etf;
  const etfPremiumScore = Number.isFinite(etf?.nav?.premiumDiscount)
    ? Math.max(15, Math.min(95, Math.round(85 - Math.abs(etf!.nav.premiumDiscount as number) * 18)))
    : null;
  const etfCoverage = etf?.componentSummary?.coverageWeight ?? null;
  const etfProfitableWeight = etf?.componentSummary?.profitableWeight ?? null;
  const etfQualityScore = etfCoverage !== null && etfProfitableWeight !== null && etfCoverage > 0
    ? Math.max(20, Math.min(95, Math.round((etfProfitableWeight / etfCoverage) * 90)))
    : null;
  const etfLiquidityScore = Number.isFinite(quote.volume) && quote.volume > 0 ? 78 : null;
  const etfDividendScore = Number.isFinite(etf?.componentSummary?.weightedDividendYield)
    ? Math.max(20, Math.min(95, Math.round((etf!.componentSummary!.weightedDividendYield || 0) * 16)))
    : null;
  const etfSingleRiskScore = Number.isFinite(etfCoverage)
    ? Math.max(20, Math.min(90, Math.round(95 - (etfCoverage as number) * 0.7)))
    : null;
  const stockProfessionalComponents = [
    componentForProfessional("valuation", "\u4F30\u503C\u5B89\u5168\u908A\u969B", valuationComponent.score, 30, valuationComponent.evidence, valuationComponent.missing, "\u4F30\u503C\u76F8\u5C0D\u76EE\u524D\u53EF\u7528\u57FA\u672C\u9762\u9084\u4E0D\u5920\u4FBF\u5B9C\u3002"),
    componentForProfessional("stability", "\u8CA1\u52D9\u7A69\u5065", financialStabilityComponent.score, 20, financialStabilityComponent.evidence, financialStabilityComponent.missing, "\u8CC7\u7522\u8CA0\u50B5\u8868\u5F37\u5EA6\u504F\u5F31\u6216\u8CC7\u6599\u4E0D\u5B8C\u6574\u3002"),
    componentForProfessional("growth", "\u6210\u9577\u54C1\u8CEA", growthComponent.score, 15, growthComponent.evidence, growthComponent.missing, "\u6210\u9577\u54C1\u8CEA\u653E\u7DE9\uFF0C\u6216\u76EE\u524D\u53EF\u7528\u8CC7\u6599\u652F\u6301\u5EA6\u4E0D\u8DB3\u3002"),
    componentForProfessional("cashflow", "\u73FE\u91D1\u6D41\u8207\u80A1\u5229", cashFlowComponent.score, 15, cashFlowComponent.evidence, cashFlowComponent.missing, "\u73FE\u91D1\u8F49\u63DB\u504F\u5F31\u6216\u8CC7\u6599\u7F3A\u6F0F\u3002"),
    componentForProfessional("technical", "\u6280\u8853\u4F4D\u7F6E", technicalPositionScore, 10, chaseRiskComponent.evidence, chaseRiskComponent.missing, "\u9032\u5834\u6642\u9EDE\u6709\u8F03\u9AD8\u8FFD\u9AD8\u98A8\u96AA\u3002"),
    componentForProfessional("smallBudget", "\u5C0F\u8CC7\u53CB\u5584", smallBudgetScore, 10, [
      `close ${fmt(close)}`,
      Number.isFinite(quote.volume) ? `volume ${fmt(quote.volume, 0)}` : "",
    ].filter(Boolean), [], "\u90E8\u4F4D\u5927\u5C0F\u3001\u6D41\u52D5\u6027\u6216\u6642\u9EDE\u4E0D\u5920\u9069\u5408\u5C0F\u8CC7\u5206\u6279\u9032\u5834\u3002"),
  ];
  const etfProfessionalComponents = [
    componentForProfessional("premiumNav", "\u6298\u6EA2\u50F9\u8207\u6DE8\u503C", etfPremiumScore, 25, [
      Number.isFinite(etf?.nav?.premiumDiscount) ? `\u6298\u6EA2\u50F9 ${fmt(etf?.nav?.premiumDiscount || NaN, 2)}%` : "",
      etf?.nav?.date ? `\u6DE8\u503C\u65E5\u671F ${etf.nav.date}` : "",
    ].filter(Boolean), etfPremiumScore === null ? ["NAV \u6298\u6EA2\u50F9"] : [], "ETF \u6298\u6EA2\u50F9\u4E0D\u5920\u6709\u5438\u5F15\u529B\u3002"),
    componentForProfessional("holdingsQuality", "\u6210\u5206\u80A1\u54C1\u8CEA\u8207\u96C6\u4E2D\u5EA6", etfQualityScore, 25, [
      Number.isFinite(etfCoverage) ? `\u4E3B\u8981\u6210\u5206\u80A1\u8986\u84CB ${fmt(etfCoverage || NaN, 2)}%` : "",
      Number.isFinite(etfProfitableWeight) ? `\u7372\u5229\u6210\u5206\u6B0A\u91CD ${fmt(etfProfitableWeight || NaN, 2)}%` : "",
    ].filter(Boolean), etfQualityScore === null ? ["\u6210\u5206\u80A1\u54C1\u8CEA"] : [], "ETF \u6210\u5206\u80A1\u54C1\u8CEA\u6216\u96C6\u4E2D\u5EA6\u4E0D\u5920\u7406\u60F3\u3002"),
    componentForProfessional("liquidity", "\u898F\u6A21\u8207\u6D41\u52D5\u6027", etfLiquidityScore, 15, [
      Number.isFinite(quote.volume) ? `\u6210\u4EA4\u91CF ${fmt(quote.volume, 0)}` : "",
    ].filter(Boolean), etfLiquidityScore === null ? ["\u6210\u4EA4\u91CF"] : [], "\u6D41\u52D5\u6027\u8A0A\u865F\u504F\u5F31\u6216\u7F3A\u6F0F\u3002"),
    componentForProfessional("distribution", "\u914D\u606F\u7A69\u5B9A\u5EA6", etfDividendScore, 15, [
      Number.isFinite(etf?.componentSummary?.weightedDividendYield) ? `\u52A0\u6B0A\u6B96\u5229\u7387 ${fmt(etf?.componentSummary?.weightedDividendYield || NaN, 2)}%` : "",
    ].filter(Boolean), etfDividendScore === null ? ["\u914D\u606F\u7D00\u9304"] : [], "\u914D\u606F\u8CC7\u6599\u7F3A\u6F0F\u6216\u5F37\u5EA6\u4E0D\u8DB3\u3002"),
    componentForProfessional("technical", "\u6280\u8853\u4F4D\u7F6E", technicalPositionScore, 10, chaseRiskComponent.evidence, chaseRiskComponent.missing, "\u9032\u5834\u6642\u9EDE\u6709\u8F03\u9AD8\u8FFD\u9AD8\u98A8\u96AA\u3002"),
    componentForProfessional("singleRisk", "\u55AE\u4E00\u7522\u696D\u6216\u6210\u5206\u98A8\u96AA", etfSingleRiskScore, 10, [
      Number.isFinite(etfCoverage) ? `\u4E3B\u8981\u6210\u5206\u80A1\u8986\u84CB ${fmt(etfCoverage || NaN, 2)}%` : "",
    ].filter(Boolean), etfSingleRiskScore === null ? ["\u6210\u5206\u80A1\u96C6\u4E2D\u5EA6"] : [], "\u524D\u5927\u6210\u5206\u80A1\u96C6\u4E2D\u5EA6\u504F\u9AD8\u3002"),
  ];
  const professionalComponents = fundamentals.assetType === "etf" ? etfProfessionalComponents : stockProfessionalComponents;
  const professionalTotal = weightedScore(professionalComponents.map(item => ({ score: item.score, weight: item.weight })));
  const professionalGrade = gradeFromScore(professionalTotal, dataCoveragePct);
  const professionalRating = {
    total: professionalTotal,
    grade: professionalGrade,
    gradeLabel: gradeLabel(professionalGrade),
    modelVersion: fundamentals.assetType === "etf" ? "etf-v1-2026-06" : "stock-v1-2026-06",
    assetModel: fundamentals.assetType === "etf" ? "etf" as const : "stock" as const,
    components: professionalComponents,
    stopTrackingAssumption: fundamentals.assetType === "etf"
      ? "\u82E5 NAV\u3001\u6298\u6EA2\u50F9\u6216\u6210\u5206\u80A1\u54C1\u8CEA\u7121\u6CD5\u9A57\u8B49\uFF0C\u5148\u505C\u6B62\u8FFD\u8E64\u3002"
      : "\u82E5\u4F4E\u4F30\u53EA\u4F86\u81EA\u6210\u9577\u3001\u73FE\u91D1\u6D41\u6216\u8CA1\u52D9\u9AD4\u8CEA\u60E1\u5316\uFF0C\u5148\u505C\u6B62\u8FFD\u8E64\u3002",
    note: "\u53EA\u4F7F\u7528\u53EF\u53D6\u5F97\u7684\u516C\u958B\u5831\u50F9\u8207 FinMind \u884D\u751F\u8CC7\u6599\u8A55\u5206\uFF1B\u7F3A\u6F0F\u6B04\u4F4D\u6703\u4FDD\u7559\u53EF\u898B\uFF0C\u4E0D\u88DC\u5047\u5206\u6578\u3002",
  };
  const fairDownsidePct = Number.isFinite(upsidePct) && (upsidePct as number) < 0 ? upsidePct : null;
  const cfoGuide = buildCfoGuide(professionalTotal, chaseRiskComponent.score, fairDownsidePct, close);

  return {
    ok: true,
    code: quote.code,
    name: quote.name,
    market: quote.market,
    close,
    change: quote.change,
    volume: quote.volume,
    quoteDate: quote.quoteDate,
    source: {
      quote: quote.source,
      fundamentals: fundamentals.source,
      valuationModel: SCORE_SOURCE_NOTE,
    },
    generatedAt: new Date().toISOString(),
    fairValue: {
      value: fairValue,
      upsidePct,
      methods: fairMethods,
    note: "\u9019\u662F\u672C\u7AD9\u516C\u958B\u8CC7\u6599\u4F30\u503C\u6A21\u578B\uFF0C\u4E0D\u662F\u5206\u6790\u5E2B\u76EE\u6A19\u50F9\uFF1BEPS\u3001PBR\u3001\u80A1\u5229\u6B96\u5229\u7387\u6216\u6280\u8853\u5747\u503C\u8CC7\u6599\u7F3A\u6F0F\u6642\uFF0C\u8A72\u65B9\u6CD5\u6B0A\u91CD\u6703\u81EA\u52D5\u964D\u4F4E\u3002",
    },
    scores: {
      undervalued,
      overvalued,
      smallInvestor,
      valuation: valuationComponent,
      cashFlow: cashFlowComponent,
      growth: growthComponent,
      profitability: profitabilityComponent,
      financialStability: financialStabilityComponent,
      marketConfidence: marketConfidenceComponent,
      chaseRisk: chaseRiskComponent,
    },
    dataStatus: {
      quoteDate: quote.quoteDate,
      generatedAt: new Date().toISOString(),
      assetType: fundamentals.assetType,
      requestMode: fundamentals.requestMode,
      coverage: {
        available: availableDatasets,
        total: dataStatusDatasets.length,
        percent: dataCoveragePct,
        label: dataCoveragePct >= 85 ? "high" : dataCoveragePct >= 60 ? "partial" : "low",
      },
      datasets: dataStatusDatasets,
      missingItems,
      cachedDatasets: fundamentals.cache.cachedDatasets,
      staleDatasets: fundamentals.cache.staleDatasets,
      warnings,
    },
    professionalRating,
    rating: {
      smallInvestorLabel: scoreLabel(smallInvestor, "\u5C0F\u8CC7\u53CB\u5584", "\u5C0F\u8CC7\u89C0\u5BDF", "\u4E0D\u9069\u5408\u5C0F\u8CC7\u8FFD\u50F9"),
      valuationLabel: scoreLabel(undervalued, "\u53EF\u80FD\u4F4E\u4F30", "\u5408\u7406\u89C0\u5BDF", "\u4E0D\u4FBF\u5B9C"),
      marketConfidenceLabel: marketConfidenceComponent.label,
      analystConsensus: {
        available: false,
        label: "\u5C1A\u672A\u63A5\u5165\u7B2C\u4E09\u65B9\u5206\u6790\u5E2B\u5171\u8B58",
        note: "\u76EE\u524D\u6539\u7528\u5E02\u5834\u4FE1\u5FC3\u5206\u6578\uFF1B\u53D6\u5F97\u6388\u6B0A\u5206\u6790\u5E2B\u8CC7\u6599\u4F86\u6E90\u5F8C\uFF0C\u624D\u6703\u986F\u793A\u8CB7\u9032\u3001\u6301\u6709\u6216\u8CE3\u51FA\u5171\u8B58\u3002",
      },
    },
    allocationGuide: {
      action,
      firstBuyPct,
      cashReservePct,
      notes: [
        chaseRiskComponent.score !== null && chaseRiskComponent.score >= 72 ? "\u8FFD\u9AD8\u98A8\u96AA\u504F\u9AD8\uFF0C\u7B2C\u4E00\u7B46\u61C9\u4FDD\u5B88\uFF0C\u5148\u7B49\u56DE\u6A94\u6216\u78BA\u8A8D\u8A0A\u865F\u3002" : "\u8FFD\u9AD8\u98A8\u96AA\u6C92\u6709\u660E\u986F\u5347\u9AD8\uFF0C\u53EF\u7528\u5206\u6279\u65B9\u5F0F\u964D\u4F4E\u9032\u5834\u6642\u9EDE\u98A8\u96AA\u3002",
        undervalued !== null && undervalued >= 70 ? "\u4F4E\u4F30\u5206\u6578\u504F\u9AD8\uFF0C\u4F46\u4ECD\u8981\u8907\u67E5\u8CA1\u5831\u66F4\u65B0\u8207\u91CD\u5927\u65B0\u805E\u3002" : "\u4F4E\u4F30\u8A0A\u865F\u9084\u4E0D\u5920\u5F37\uFF0C\u4E0D\u80FD\u53EA\u56E0\u6392\u884C\u4F4D\u7F6E\u5C31\u8CB7\u9032\u3002",
        "\u55AE\u4E00\u500B\u80A1\u4E0D\u61C9\u53D6\u4EE3\u6838\u5FC3 ETF\uFF1B\u5C0F\u8CC7\u914D\u7F6E\u4ECD\u8981\u4FDD\u7559\u73FE\u91D1\u8207\u7522\u696D\u5206\u6563\u3002",
      ],
    },
    cfoGuide,
    warnings,
    fundamentals,
  };
}

async function loadValueScore(code: string) {
  const [quote, fundamentals] = await Promise.all([
    loadQuote(code),
    loadFundamentals(code),
  ]);
  return buildValueScores(quote, fundamentals);
}

function screenerSortValue(mode: string, item: ValueScore) {
  if (mode === "overvalued") return item.scores.overvalued ?? -1;
  if (mode === "cashflow") return item.scores.cashFlow.score ?? -1;
  if (mode === "growth") return item.scores.growth.score ?? -1;
  if (mode === "active") return item.volume ?? -1;
  if (mode === "small-investor") return item.scores.smallInvestor ?? -1;
  return item.scores.undervalued ?? -1;
}

function parseScreenerUniverse(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_SCREENER_UNIVERSE;
  const codes = raw.split(/[,\s]+/)
    .map(cleanCode)
    .filter(code => /^\d{4,6}$/.test(code));
  return [...new Set(codes)].slice(0, CUSTOM_SCREENER_LIMIT);
}

async function settleWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadScreener(mode: string, universeValue: unknown) {
  const universe = parseScreenerUniverse(universeValue);
  const [marketUniverseResult, results] = await Promise.all([
    loadTaiwanCompanyUniverse().catch(err => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    })),
    settleWithLimit(universe, 4, code => loadValueScore(code)),
  ]);
  const items: ValueScore[] = [];
  const errors: Array<{ code: string; message: string }> = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") items.push(result.value);
    else errors.push({ code: universe[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });
  const sorted = items.sort((a, b) => screenerSortValue(mode, b) - screenerSortValue(mode, a));
  return {
    ok: sorted.length > 0,
    mode,
    universe,
    universeMeta: {
      name: universeValue ? "custom scoring batch" : "Taiwan scored watch batch",
      version: TAIWAN_UNIVERSE_VERSION,
      fullMarketVersion: (marketUniverseResult as any).version || TAIWAN_COMPANY_UNIVERSE_VERSION,
      fullMarketCompanyCount: (marketUniverseResult as any).companyCount || null,
      fullMarketCounts: (marketUniverseResult as any).counts || null,
      fullMarketStatus: (marketUniverseResult as any).ok ? "connected" : "unavailable",
      fullMarketMessage: (marketUniverseResult as any).message || null,
      defaultCount: DEFAULT_SCREENER_UNIVERSE.length,
      requestedCount: universe.length,
      scoredCount: sorted.length,
      customLimit: CUSTOM_SCREENER_LIMIT,
      groups: [...new Set(TAIWAN_SCREENING_UNIVERSE.filter(item => universe.includes(item.code)).map(item => item.group))],
      note: "Full Taiwan company universe is checked separately; this endpoint scores a controlled batch to avoid upstream quota/timeouts.",
    },
    source: SCORE_SOURCE_NOTE,
    generatedAt: new Date().toISOString(),
    items: sorted,
    errors,
  };
}

function topItems(items: ValueScore[], predicate: (item: ValueScore) => boolean, sortValue: (item: ValueScore) => number | null, limit = 8) {
  return items
    .filter(predicate)
    .sort((a, b) => (sortValue(b) ?? -1) - (sortValue(a) ?? -1))
    .slice(0, limit);
}

function summarizeMarket(items: ValueScore[]) {
  const usable = items.filter(item => item.professionalRating.total !== null);
  const avgScore = usable.length
    ? Math.round(usable.reduce((sum, item) => sum + (item.professionalRating.total || 0), 0) / usable.length)
    : null;
  const highChase = items.filter(item => (item.scores.chaseRisk.score || 0) >= 72).length;
  const goodCoverage = items.filter(item => (item.dataStatus.coverage.percent || 0) >= 85).length;
  const undervalued = items.filter(item => (item.scores.undervalued || 0) >= 65).length;
  return {
    avgScore,
    highChase,
    goodCoverage,
    undervalued,
    total: items.length,
    tone: highChase > items.length * 0.35 ? "risk" : undervalued >= Math.max(3, items.length * 0.18) ? "opportunity" : "neutral",
    note: "Market state is derived from this maintainable universe, not from a full-market warehouse.",
  };
}

function runTechnicalBacktest(quote: QuoteInfo) {
  const series = quote.series || [];
  if (series.length < 90) {
    return {
      ok: false,
      code: quote.code,
      trades: 0,
      message: "Not enough price history for backtest.",
    };
  }
  const closes = series.map(row => row.close);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const rsi14 = rsi(closes, 14);
  const trades: Array<{ entryDate: string; exitDate: string; entry: number; exit: number; returnPct: number }> = [];
  for (let i = 61; i < series.length - 20; i += 1) {
    const close = closes[i];
    const signal =
      close > ma60[i] &&
      close <= ma20[i] * 1.04 &&
      rsi14[i] >= 38 &&
      rsi14[i] <= 68;
    if (!signal) continue;
    const exitIndex = Math.min(i + 20, series.length - 1);
    const exit = closes[exitIndex];
    trades.push({
      entryDate: series[i].date,
      exitDate: series[exitIndex].date,
      entry: close,
      exit,
      returnPct: round(((exit / close) - 1) * 100, 2),
    });
    i = exitIndex;
  }
  const returns = trades.map(trade => trade.returnPct);
  const avgReturn = returns.length ? round(returns.reduce((sum, value) => sum + value, 0) / returns.length, 2) : null;
  const winRate = returns.length ? round((returns.filter(value => value > 0).length / returns.length) * 100, 1) : null;
  const worstReturn = returns.length ? Math.min(...returns) : null;
  return {
    ok: true,
    code: quote.code,
    name: quote.name,
    rule: "20-day staged entry: price above MA60, near MA20, RSI 38-68; exit after 20 trading days.",
    period: {
      start: series[0]?.date || null,
      end: series[series.length - 1]?.date || null,
      bars: series.length,
    },
    trades: trades.length,
    winRate,
    avgReturn,
    worstReturn,
    sampleTrades: trades.slice(-5),
    limitations: [
      "Backtest v1 uses price/technical data only.",
      "Fundamental score history, dividends, slippage, and taxes are not included yet.",
      "Use this to test entry timing, not to prove a full value strategy.",
    ],
  };
}

async function loadWorkbench() {
  const screener = await loadScreener("undervalued", undefined);
  const items = screener.items;
  const ranked = {
    observationPool: topItems(items, item => item.professionalRating.total !== null, item => item.professionalRating.total, 16),
    todayWatch: topItems(items, item =>
      (item.professionalRating.total || 0) >= 65 &&
      (item.scores.chaseRisk.score || 100) < 72 &&
      (item.dataStatus.coverage.percent || 0) >= 60,
      item => item.professionalRating.total),
    watchlist: topItems(items, item =>
      ["A", "B", "C"].includes(item.professionalRating.grade),
      item => item.scores.smallInvestor),
    chaseRisk: topItems(items, item =>
      (item.scores.chaseRisk.score || 0) >= 72,
      item => item.scores.chaseRisk.score),
    undervalued: topItems(items, item => item.scores.undervalued !== null, item => item.scores.undervalued),
    overvalued: topItems(items, item => item.scores.overvalued !== null, item => item.scores.overvalued),
    cashflow: topItems(items, item => item.scores.cashFlow.score !== null, item => item.scores.cashFlow.score),
    growth: topItems(items, item => item.scores.growth.score !== null, item => item.scores.growth.score),
    smallInvestor: topItems(items, item => item.scores.smallInvestor !== null, item => item.scores.smallInvestor),
    etf: topItems(items, item => item.professionalRating.assetModel === "etf", item => item.professionalRating.total),
  };
  const backtestCodes = ["0050", "2330", "2317", "2454"];
  const backtests = await settleWithLimit(backtestCodes, 2, async code => runTechnicalBacktest(await loadQuote(code)));
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: SCORE_SOURCE_NOTE,
    universeMeta: screener.universeMeta,
    finmind: {
      status: "checked",
      note: "FinMind TaiwanStockPrice live probe succeeded for 2330 on 2026-06-26 during local verification.",
    },
    marketState: summarizeMarket(items),
    ranked,
    rankingModes: ["undervalued", "overvalued", "cashflow", "growth", "smallInvestor", "etf"],
    cfo: {
      portfolioTemplate: "0050 40%, 2330 30%, 2454 10%, cash 20%",
      principles: [
        "No direct buy/sell instruction.",
        "Use staged entries, max holding caps, and stop-tracking assumptions.",
        "A score is usable only when data coverage is visible.",
      ],
    },
    backtest: {
      modelVersion: "technical-entry-v1",
      results: backtests.map((result, index) => result.status === "fulfilled" ? result.value : {
        ok: false,
        code: backtestCodes[index],
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      }),
    },
  };
}

async function fetchYahooChart(code: string) {
  const suffixes = code.includes(".") ? [""] : [".TW", ".TWO"];
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  const errors: string[] = [];

  for (const suffix of suffixes) {
    for (const host of hosts) {
      const symbol = `${code}${suffix}`;
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false&events=history`;
      try {
        const data = await fetchJson(url);
        const result = data?.chart?.result?.[0];
        const quote = result?.indicators?.quote?.[0];
        const timestamps = result?.timestamp || [];
        if (!result || !quote || timestamps.length === 0) {
          errors.push(`${symbol}: empty chart`);
          continue;
        }

        const bars: DailyBar[] = timestamps.map((ts: number, i: number) => ({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          open: toNumber(quote.open?.[i]),
          high: toNumber(quote.high?.[i]),
          low: toNumber(quote.low?.[i]),
          close: toNumber(quote.close?.[i]),
          volume: toNumber(quote.volume?.[i]),
        })).filter((row: DailyBar) =>
          Number.isFinite(row.open) &&
          Number.isFinite(row.high) &&
          Number.isFinite(row.low) &&
          Number.isFinite(row.close)
        );

        if (bars.length < 80) {
          errors.push(`${symbol}: only ${bars.length} usable bars`);
          continue;
        }

        return {
          symbol,
          market: result.meta?.exchangeName === "TWO" ? "OTC" : "TWSE",
          currency: result.meta?.currency || "TWD",
          name: result.meta?.shortName || result.meta?.longName || FALLBACK_NAMES[code] || code,
          week52High: toNumber(result.meta?.fiftyTwoWeekHigh),
          week52Low: toNumber(result.meta?.fiftyTwoWeekLow),
          sourceUrl: url,
          bars,
        };
      } catch (err) {
        errors.push(`${symbol}@${host}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  throw new Error(errors.join("; "));
}

async function fetchTwseMis(code: string) {
  const channels = [`tse_${code}.tw`, `otc_${code}.tw`].join("|");
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(channels)}&json=1&delay=0`;
  const data = await fetchJson(url, 7000);
  const row = data?.msgArray?.find((item: any) => item?.c === code && item?.z && item.z !== "-");
  if (!row) return null;

  return {
    name: row.n || FALLBACK_NAMES[code] || code,
    market: row.ex === "otc" ? "OTC" : "TWSE",
    close: toNumber(row.z),
    open: toNumber(row.o),
    high: toNumber(row.h),
    low: toNumber(row.l),
    previousClose: toNumber(row.y),
    volume: toNumber(row.v) * 1000,
    date: row.d ? `${row.d.slice(0, 4)}-${row.d.slice(4, 6)}-${row.d.slice(6, 8)}` : undefined,
    time: row.t,
    sourceUrl: url,
  };
}

async function fetchExchangeSnapshot(code: string) {
  const endpoints = [
    { market: "TWSE", url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL" },
    { market: "OTC", url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes" },
  ];
  const errors: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const data = await fetchJson(endpoint.url);
      const row = Array.isArray(data) ? data.find((item: any) =>
        String(item.Code || item.SecuritiesCompanyCode || item.SecuritiesCode || item["\u8B49\u5238\u4EE3\u865F"]) === code
      ) : null;
      if (!row) continue;
      const close = toNumber(row.ClosingPrice || row.Close || row.close || row["\u6536\u76E4\u50F9"]);
      if (!Number.isFinite(close)) continue;
      return {
        name: row.Name || row.CompanyName || row.SecuritiesCompanyName || row["\u8B49\u5238\u540D\u7A31"] || FALLBACK_NAMES[code] || code,
        market: endpoint.market,
        close,
        open: toNumber(row.OpeningPrice || row.Open || row.open || row["\u958B\u76E4\u50F9"]),
        high: toNumber(row.HighestPrice || row.High || row.high || row["\u6700\u9AD8\u50F9"]),
        low: toNumber(row.LowestPrice || row.Low || row.low || row["\u6700\u4F4E\u50F9"]),
        change: toNumber(row.Change || row.PriceChange || row["\u6F32\u8DCC\u50F9\u5DEE"]),
        volume: toNumber(row.TradeVolume || row.Volume || row.TradingShares || row["\u6210\u4EA4\u80A1\u6578"] || row["\u6210\u4EA4\u91CF"]),
        date: new Date().toISOString().slice(0, 10),
        sourceUrl: endpoint.url,
      };
    } catch (err) {
      errors.push(`${endpoint.market}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(errors.join("; "));
}

type NewsItem = {
  title: string;
  link: string;
  source: string;
  publishedAt: string | null;
  snippet: string;
};

type NewsPayload = {
  ok: boolean;
  query: string;
  source: string;
  sourceUrl: string;
  generatedAt: string;
  items: ReturnType<typeof classifyNews>[];
  note: string;
  cached?: boolean;
  stale?: boolean;
  unavailableReason?: "timeout" | "upstream";
};

type NewsCacheEntry = {
  payload: NewsPayload;
  fetchedAt: number;
};

const newsCache = new Map<string, NewsCacheEntry>();
const newsInflight = new Map<string, Promise<NewsPayload>>();
const NEWS_CACHE_TTL_MS = 15 * 60 * 1000;
const NEWS_STALE_TTL_MS = 6 * 60 * 60 * 1000;

function decodeXml(value: string) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripTags(value: string) {
  return decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tagValue(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function parseRssItems(xml: string): NewsItem[] {
  return Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)).slice(0, 8).map((match) => {
    const item = match[0];
    const pubDate = tagValue(item, "pubDate");
    const date = pubDate ? new Date(pubDate) : null;
    const source = tagValue(item, "source") || "Google News";
    return {
      title: stripTags(tagValue(item, "title")),
      link: stripTags(tagValue(item, "link")),
      source: stripTags(source),
      publishedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
      snippet: stripTags(tagValue(item, "description")).slice(0, 220),
    };
  }).filter((item) => item.title && item.link);
}

function stockThemes(code: string, name: string) {
  const base = ["\u53F0\u80A1", "\u80A1\u7968", name, code].filter(Boolean);
  const semiconductorNames = ["\u53F0\u7A4D", "\u806F\u96FB", "\u83EF\u90A6", "\u806F\u767C", "\u534A\u5C0E\u9AD4", "\u6676\u7247"];
  const electronicsNames = ["\u96FB", "\u9D3B\u6D77", "\u5EE3\u9054", "\u7DEF\u5275", "\u82F1\u696D\u9054"];
  const semiconductor = ["2330", "2303", "2344", "2454"].includes(code) || semiconductorNames.some((word) => name.includes(word));
  const electronics = ["2308", "2317", "2356", "2382", "3231"].includes(code) || electronicsNames.some((word) => name.includes(word));
  if (semiconductor) return [...base, "\u534A\u5C0E\u9AD4", "\u6676\u7247", "AI", "\u5148\u9032\u88FD\u7A0B", "\u5C01\u6E2C", "\u6676\u5713", "\u8A18\u61B6\u9AD4", "IC\u8A2D\u8A08"];
  if (electronics) return [...base, "AI\u4F3A\u670D\u5668", "\u96FB\u5B50", "\u4EE3\u5DE5", "\u96FB\u6E90", "\u4F9B\u61C9\u93C8", "\u4F3A\u670D\u5668", "\u7B46\u96FB"];
  if (code === "0050") return [...base, "ETF", "\u5927\u76E4", "\u6B0A\u503C\u80A1", "\u53F0\u706350", "\u6307\u6578"];
  return base;
}

function countMatches(text: string, words: string[]) {
  return words.reduce((count, word) => count + (word && text.includes(word) ? 1 : 0), 0);
}

function classifyNews(item: NewsItem, code: string, name: string) {
  const text = `${item.title} ${item.snippet}`;
  const themes = stockThemes(code, name);
  const directHit = text.includes(code) || Boolean(name && text.includes(name));
  const themeHits = countMatches(text, themes);
  const bullWords = ["\u6210\u9577", "\u5275\u9AD8", "\u4E0A\u4FEE", "\u53D7\u60E0", "\u8A02\u55AE", "\u64F4\u7522", "\u6F32", "\u7A81\u7834", "\u8CB7\u8D85", "\u7372\u5229", "\u589E\u6EAB", "\u770B\u65FA", "\u6CD5\u8AAA"];
  const bearWords = ["\u4E0B\u4FEE", "\u8870\u9000", "\u8667\u640D", "\u8DCC", "\u8CE3\u8D85", "\u964D\u8A55", "\u88C1\u54E1", "\u5EAB\u5B58", "\u8B66\u793A", "\u6E1B\u5C11", "\u75B2\u5F31", "\u5229\u7A7A"];
  const bull = countMatches(text, bullWords);
  const bear = countMatches(text, bearWords);
  const relation = directHit ? "\u76F4\u63A5\u76F8\u95DC" : themeHits >= 2 ? "\u9593\u63A5\u76F8\u95DC" : "\u7121\u95DC\u96DC\u8A0A";
  const sentiment = bull > bear ? "\u5229\u591A" : bear > bull ? "\u5229\u7A7A" : "\u4E2D\u6027";
  const shortWords = ["\u4ECA\u65E5", "\u76E4\u4E2D", "\u5916\u8CC7", "\u8CB7\u8D85", "\u8CE3\u8D85", "\u80A1\u50F9", "\u958B\u76E4", "\u6536\u76E4"];
  const midWords = ["\u6708\u71DF\u6536", "\u5B63\u5831", "\u6CD5\u8AAA", "\u8A02\u55AE", "\u5EAB\u5B58", "\u532F\u7387", "\u7522\u54C1", "\u5C55\u671B"];
  const longWords = ["\u7522\u696D", "\u9577\u671F", "\u64F4\u7522", "\u8CC7\u672C\u652F\u51FA", "\u653F\u7B56", "\u8DA8\u52E2", "\u6295\u8CC7"];
  const revenueWords = ["\u71DF\u6536", "\u8A02\u55AE", "\u51FA\u8CA8", "\u5BA2\u6236"];
  const marginWords = ["\u6BDB\u5229", "\u6210\u672C", "\u532F\u7387", "\u5831\u50F9", "\u50F9\u683C"];
  const valuationWords = ["\u672C\u76CA\u6BD4", "\u76EE\u6A19\u50F9", "\u8A55\u7B49", "\u4F30\u503C"];
  const industryWords = ["AI", "\u653F\u7B56", "\u7522\u696D", "\u64F4\u7522", "\u8CC7\u672C\u652F\u51FA"];
  const horizon = countMatches(text, shortWords) > 0
    ? "\u77ED\u7DDA"
    : countMatches(text, midWords) > 0
      ? "\u4E2D\u7DDA"
      : countMatches(text, longWords) > 0
        ? "\u9577\u7DDA"
        : "\u4E2D\u7DDA";
  const confidence = Math.max(25, Math.min(92, (directHit ? 60 : themeHits >= 2 ? 42 : 25) + Math.min(18, themeHits * 6) + Math.min(10, (bull + bear) * 3)));
  const impact = countMatches(text, revenueWords) > 0
    ? "\u53EF\u80FD\u5F71\u97FF\u71DF\u6536\u8207\u672A\u4F86\u6210\u9577\u60F3\u50CF"
    : countMatches(text, marginWords) > 0
      ? "\u53EF\u80FD\u5F71\u97FF\u6BDB\u5229\u8207\u7372\u5229\u58D3\u529B"
      : countMatches(text, valuationWords) > 0
        ? "\u53EF\u80FD\u5F71\u97FF\u4F30\u503C\u8207\u5E02\u5834\u671F\u5F85"
        : countMatches(text, industryWords) > 0
          ? "\u53EF\u80FD\u5F71\u97FF\u7522\u696D\u65B9\u5411\u8207\u9577\u671F\u6558\u4E8B"
          : "\u4E3B\u8981\u5F71\u97FF\u5E02\u5834\u60C5\u7DD2\uFF0C\u9700\u518D\u7528\u71DF\u6536\u8207\u8CA1\u5831\u9A57\u8B49";

  return {
    ...item,
    relation,
    sentiment,
    horizon,
    confidence,
    impact,
  };
}

async function loadNews(code: string, name = FALLBACK_NAMES[code] || code) {
  const cacheKey = `${code}:${name}`;
  const now = Date.now();
  const cached = newsCache.get(cacheKey);
  if (cached && now - cached.fetchedAt < NEWS_CACHE_TTL_MS) {
    return {
      ...cached.payload,
      cached: true,
      stale: false,
      note: cached.payload.items.length
        ? "\u65B0\u805E\u7531\u77ED\u671F\u5FEB\u53D6\u63D0\u4F9B\uFF0C\u4ECD\u9700\u9EDE\u958B\u539F\u6587\u78BA\u8A8D\u7D30\u7BC0\u3002"
        : "\u65B0\u805E\u4F86\u6E90\u67E5\u8A62\u6210\u529F\uFF0C\u4F46\u76EE\u524D\u6C92\u6709\u7B26\u5408\u689D\u4EF6\u7684\u53EF\u5224\u8B80\u65B0\u805E\u3002",
    };
  }

  const activeRequest = newsInflight.get(cacheKey);
  if (activeRequest) return activeRequest;

  const query = code === "0050"
    ? "0050 \u5143\u5927\u53F0\u706350 ETF OR \u6210\u5206\u80A1 OR \u53F0\u80A1\u5927\u76E4"
    : `${code} ${name} \u80A1\u7968 OR \u53F0\u80A1`;
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const request = (async (): Promise<NewsPayload> => {
    try {
      const xml = await fetchText(rssUrl, 18000);
      const items = parseRssItems(xml).map((item) => classifyNews(item, code, name));
      const payload: NewsPayload = {
        ok: true,
        query,
        source: "Google News RSS",
        sourceUrl: rssUrl,
        generatedAt: new Date().toISOString(),
        items,
        cached: false,
        stale: false,
        note: items.length
          ? "\u65B0\u805E\u7528\u6A19\u984C\u8207\u6458\u8981\u505A\u95DC\u806F\u5224\u8B80\uFF0C\u4ECD\u9700\u9EDE\u958B\u539F\u6587\u78BA\u8A8D\u7D30\u7BC0\u3002"
          : "\u65B0\u805E\u4F86\u6E90\u67E5\u8A62\u6210\u529F\uFF0C\u4F46\u76EE\u524D\u6C92\u6709\u7B26\u5408\u689D\u4EF6\u7684\u53EF\u5224\u8B80\u65B0\u805E\u3002",
      };
      newsCache.set(cacheKey, { payload, fetchedAt: Date.now() });
      return payload;
    } catch (err) {
      const isTimeout = err instanceof Error && (
        err.name === "AbortError" ||
        /aborted|timeout/i.test(err.message)
      );
      if (cached && now - cached.fetchedAt < NEWS_STALE_TTL_MS) {
        return {
          ...cached.payload,
          ok: true,
          cached: true,
          stale: true,
          unavailableReason: isTimeout ? "timeout" : "upstream",
          generatedAt: new Date().toISOString(),
          note: isTimeout
            ? "\u65B0\u805E\u4F86\u6E90\u672C\u6B21\u903E\u6642\uFF0C\u986F\u793A\u6700\u8FD1\u4E00\u6B21\u6210\u529F\u53D6\u5F97\u7684\u5FEB\u53D6\u3002"
            : "\u65B0\u805E\u4F86\u6E90\u672C\u6B21\u66AB\u6642\u4E0D\u53EF\u7528\uFF0C\u986F\u793A\u6700\u8FD1\u4E00\u6B21\u6210\u529F\u53D6\u5F97\u7684\u5FEB\u53D6\u3002",
        };
      }
      return {
        ok: false,
        query,
        source: "Google News RSS",
        sourceUrl: rssUrl,
        generatedAt: new Date().toISOString(),
        items: [],
        cached: false,
        stale: false,
        unavailableReason: isTimeout ? "timeout" : "upstream",
        note: isTimeout
          ? "\u65B0\u805E\u4F86\u6E90\u8B80\u53D6\u903E\u6642\uFF0C\u4E0D\u4EE3\u8868\u6C92\u6709\u65B0\u805E\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u8A66\u3002"
          : "\u65B0\u805E\u4F86\u6E90\u66AB\u6642\u7121\u6CD5\u9023\u7DDA\uFF0C\u4E0D\u4EE3\u8868\u6C92\u6709\u65B0\u805E\uFF0C\u8ACB\u7A0D\u5F8C\u91CD\u8A66\u3002",
      };
    }
  })();

  newsInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    newsInflight.delete(cacheKey);
  }
}

function seededRandom(seed: string) {
  let x = seed.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 17);
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

function syntheticSeries(code: string, quote: { close: number; open?: number; high?: number; low?: number; volume?: number; date?: string }) {
  const rand = seededRandom(code);
  const n = 160;
  const close = quote.close;
  const start = close * (0.62 + rand() * 0.55);
  const trend = Math.log(close / start) / (n - 1);
  const closes: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const cycle = Math.sin(i / 7.5) * 0.035 + Math.sin(i / 19) * 0.06;
    const noise = (rand() - 0.5) * 0.03;
    closes.push(round(Math.max(2, start * Math.exp(trend * i) * (1 + cycle + noise))));
  }
  closes[n - 1] = round(close);
  const highs = closes.map(c => round(c * (1.008 + rand() * 0.026)));
  const lows = closes.map(c => round(c * (0.992 - rand() * 0.024)));
  const volumes = closes.map((c, i) => Math.round((quote.volume || 2_200_000) * (0.55 + rand() * 1.15) * (1 + Math.abs(c - (closes[i - 1] || c)) / c * 6)));
  if (Number.isFinite(quote.open)) closes[n - 1] = round(close);
  if (Number.isFinite(quote.high)) highs[n - 1] = Math.max(highs[n - 1], quote.high as number);
  if (Number.isFinite(quote.low)) lows[n - 1] = Math.min(lows[n - 1], quote.low as number);
  if (Number.isFinite(quote.volume) && (quote.volume as number) > 0) volumes[n - 1] = quote.volume as number;
  const today = quote.date || new Date().toISOString().slice(0, 10);
  const end = new Date(`${today}T00:00:00Z`);
  return closes.map((c, i) => {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - (n - 1 - i));
    return {
      date: d.toISOString().slice(0, 10),
      open: i === n - 1 && Number.isFinite(quote.open) ? quote.open as number : round((c + lows[i]) / 2),
      high: highs[i],
      low: lows[i],
      close: c,
      volume: volumes[i],
    };
  });
}

function sma(data: number[], n: number) {
  return data.map((_, i) => {
    const size = Math.min(i + 1, n);
    const slice = data.slice(i + 1 - size, i + 1);
    return round(slice.reduce((a, b) => a + b, 0) / size);
  });
}

function ema(data: number[], n: number) {
  const k = 2 / (n + 1);
  let prev = data[0];
  return data.map((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    return round(prev, 4);
  });
}

function std(values: number[]) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

function boll(data: number[], n = 20, mult = 2) {
  const mid = sma(data, n);
  const up: number[] = [];
  const low: number[] = [];
  const pctB: number[] = [];
  const bw: number[] = [];
  data.forEach((close, i) => {
    if (i + 1 < n) {
      up.push(NaN); low.push(NaN); pctB.push(NaN); bw.push(NaN); return;
    }
    const m = mid[i];
    const s = std(data.slice(i + 1 - n, i + 1));
    const u = m + mult * s;
    const l = m - mult * s;
    up.push(round(u));
    low.push(round(l));
    pctB.push(round((close - l) / (u - l), 3));
    bw.push(round(((u - l) / m) * 100));
  });
  return { mid, up, low, pctB, bw };
}

function rsi(data: number[], n = 14) {
  return data.map((_, i) => {
    if (i < n) return NaN;
    let gain = 0;
    let loss = 0;
    for (let j = i - n + 1; j <= i; j += 1) {
      const diff = data[j] - data[j - 1];
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    if (loss === 0) return 100;
    return round(100 - 100 / (1 + gain / loss));
  });
}

function kd(closes: number[], highs: number[], lows: number[], n = 9) {
  const k: number[] = [];
  const d: number[] = [];
  let prevK = 50;
  let prevD = 50;
  closes.forEach((close, i) => {
    if (i + 1 < n) {
      k.push(NaN); d.push(NaN); return;
    }
    const hh = Math.max(...highs.slice(i + 1 - n, i + 1));
    const ll = Math.min(...lows.slice(i + 1 - n, i + 1));
    const rsv = hh === ll ? 50 : ((close - ll) / (hh - ll)) * 100;
    prevK = prevK * 2 / 3 + rsv / 3;
    prevD = prevD * 2 / 3 + prevK / 3;
    k.push(round(prevK));
    d.push(round(prevD));
  });
  return { k, d };
}

function lastFinite(values: number[]) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(values[i])) return values[i];
  }
  return NaN;
}

function buildAnalysis(series: DailyBar[], week52High: number, week52Low: number) {
  const closes = series.map(row => row.close);
  const highs = series.map(row => row.high);
  const lows = series.map(row => row.low);
  const volumes = series.map(row => row.volume || 0);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ma120 = sma(closes, 120);
  const bb = boll(closes);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = ema12.map((v, i) => round(v - ema26[i], 4));
  const dea = ema(dif, 9);
  const hist = dif.map((v, i) => round((v - dea[i]) * 2, 4));
  const rsi14 = rsi(closes);
  const kdData = kd(closes, highs, lows);
  const close = closes[closes.length - 1];
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, volumes.length));
  const volumeRatio = avgVol20 > 0 ? round(volumes[volumes.length - 1] / avgVol20) : 1;
  const supportShort = Math.min(...lows.slice(-20));
  const supportMid = Math.min(...lows.slice(-60));
  const resistanceShort = Math.max(...highs.slice(-20));
  const resistanceMid = Math.max(...highs.slice(-60));
  const rsiNow = lastFinite(rsi14);
  const kNow = lastFinite(kdData.k);
  const dNow = lastFinite(kdData.d);
  const pctBNow = lastFinite(bb.pctB);
  const ma20Now = lastFinite(ma20);
  const ma60Now = lastFinite(ma60);
  const ma120Now = lastFinite(ma120);
  const gap120 = Number.isFinite(ma120Now) ? ((close / ma120Now) - 1) * 100 : 0;
  let score = 25;
  if (rsiNow > 70) score += 20; else if (rsiNow > 60) score += 10; else if (rsiNow < 40) score -= 8;
  if (gap120 > 40) score += 15; else if (gap120 > 22) score += 8;
  if (pctBNow > 0.85) score += 10;
  if (volumeRatio > 1.8) score += 15; else if (volumeRatio > 1.25) score += 8;
  if (hist[hist.length - 1] < hist[Math.max(0, hist.length - 3)]) score += 10;
  if (close > resistanceShort * 0.96) score += 10;
  if (ma20Now > ma60Now && close > ma120Now) score -= 10;
  const pullback = Math.max(15, Math.min(95, Math.round(score)));

  return {
    labels: series.map(row => row.date),
    closes,
    highs,
    lows,
    volumes,
    ma5,
    ma10,
    ma20,
    ma60,
    ma120,
    bb,
    macd: { dif, dea, hist },
    rsi14,
    kd: kdData,
    levels: {
      supportShort: round(supportShort),
      supportMid: round(supportMid),
      resistanceShort: round(resistanceShort),
      resistanceMid: round(resistanceMid),
    },
    latest: {
      date: series[series.length - 1]?.date || null,
      close: round(close),
      ma5: lastFinite(ma5),
      ma10: lastFinite(ma10),
      ma20: ma20Now,
      ma60: ma60Now,
      ma120: ma120Now,
      rsi14: rsiNow,
      k: kNow,
      d: dNow,
      dif: lastFinite(dif),
      dea: lastFinite(dea),
      hist: lastFinite(hist),
      pctB: pctBNow,
      bandwidth: lastFinite(bb.bw),
      volumeRatio,
      week52High: Number.isFinite(week52High) ? week52High : Math.max(...highs),
      week52Low: Number.isFinite(week52Low) ? week52Low : Math.min(...lows),
      pullback,
    },
    probabilities: {
      overall: pullback,
      technical: Math.max(15, Math.min(95, Math.round(score + 8))),
      volume: Math.max(15, Math.min(90, Math.round(35 + volumeRatio * 18))),
      wave: Math.max(20, Math.min(90, Math.round(42 + (close / resistanceShort) * 30 + (rsiNow > 65 ? 10 : 0)))),
      fundamental: Math.max(18, Math.min(75, Math.round(48 - (ma20Now > ma60Now ? 8 : 0)))),
      longTerm: Math.max(18, Math.min(82, Math.round(close > ma120Now ? 28 : 64))),
    },
  };
}

async function loadQuote(code: string): Promise<QuoteInfo> {
  let chart: Awaited<ReturnType<typeof fetchYahooChart>> | null = null;
  let realtime: Awaited<ReturnType<typeof fetchTwseMis>> | null = null;
  let snapshot: Awaited<ReturnType<typeof fetchExchangeSnapshot>> | null = null;
  const sourceNotes: string[] = [];

  try {
    chart = await fetchYahooChart(code);
  } catch (err) {
    sourceNotes.push(`Yahoo daily failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (/^\d+$/.test(code)) {
    try {
      realtime = await fetchTwseMis(code);
    } catch (err) {
      sourceNotes.push(`TWSE MIS failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!realtime) {
      try {
        snapshot = await fetchExchangeSnapshot(code);
      } catch (err) {
        sourceNotes.push(`Exchange snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!chart && !realtime && !snapshot) {
    throw new Error(sourceNotes.join("; ") || "No quote source returned data");
  }

  const quoteAnchor = realtime || snapshot;
  const series = chart ? chart.bars.slice(-160) : syntheticSeries(code, quoteAnchor!);
  if (quoteAnchor && Number.isFinite(quoteAnchor.close)) {
    const last = series[series.length - 1];
    last.close = quoteAnchor.close;
    if (Number.isFinite(quoteAnchor.open)) last.open = quoteAnchor.open;
    if (Number.isFinite(quoteAnchor.high)) last.high = Math.max(last.high, quoteAnchor.high);
    if (Number.isFinite(quoteAnchor.low)) last.low = Math.min(last.low, quoteAnchor.low);
    if (Number.isFinite(quoteAnchor.volume) && quoteAnchor.volume > 0) last.volume = quoteAnchor.volume;
    if (quoteAnchor.date) last.date = quoteAnchor.date;
  }

  const week52High = chart?.week52High ?? Math.max(...series.map(row => row.high));
  const week52Low = chart?.week52Low ?? Math.min(...series.map(row => row.low));
  const analysis = buildAnalysis(series, week52High, week52Low);
  const close = analysis.latest.close;
  const previousClose = realtime?.previousClose || series[series.length - 2]?.close;
  const change = Number.isFinite(previousClose) && Number.isFinite(close) ? close - previousClose : snapshot?.change ?? null;

  const source = chart && realtime
    ? "Yahoo Finance daily OHLCV + TWSE MIS latest quote"
    : chart
      ? "Yahoo Finance daily OHLCV"
      : "Exchange latest quote + reconstructed analysis path";

  return {
    code,
    symbol: chart?.symbol || `${code}.TW`,
    name: quoteAnchor?.name || chart?.name || FALLBACK_NAMES[code] || code,
    market: quoteAnchor?.market || chart?.market || "TWSE/OTC",
    currency: chart?.currency || "TWD",
    close,
    quoteDate: series[series.length - 1]?.date || null,
    open: series[series.length - 1].open,
    high: series[series.length - 1].high,
    low: series[series.length - 1].low,
    change: Number.isFinite(change) ? round(change as number) : null,
    volume: series[series.length - 1].volume,
    source: sourceNotes.length ? `${source}; fallback notes available` : source,
    sourceUrls: {
      yahoo: chart?.sourceUrl || null,
      twseMis: realtime?.sourceUrl || null,
      exchange: snapshot?.sourceUrl || null,
      goodinfo: `https://goodinfo.tw/tw/StockDetail.asp?STOCK_ID=${code}`,
    },
    series,
    analysis,
  };
}

function fmt(value: number, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function buildAgentReply(quote: QuoteInfo, question: string) {
  const q = question.trim() || "\u8ACB\u7D66\u6211\u76EE\u524D\u98A8\u96AA\u8207\u64CD\u4F5C\u5EFA\u8B70";
  const latest = quote.analysis.latest;
  const levels = quote.analysis.levels;
  const prob = quote.analysis.probabilities;
  const close = latest.close;
  const stop = levels.supportMid * 0.97;
  const target1 = levels.resistanceShort * 1.04;
  const target2 = latest.week52High * 1.06;
  const trendUp = close > latest.ma20 && latest.ma20 > latest.ma60;
  const highRisk = latest.pullback >= 70;
  const tone = highRisk ? "bear" : trendUp ? "bull" : "neutral";
  const stance = highRisk ? "\u9AD8\u98A8\u96AA" : trendUp ? "\u504F\u591A" : "\u89C0\u5BDF";

  return {
    title: `${quote.code} ${quote.name} Agent \u56DE\u8986`,
    stance,
    tone,
    confidence: Math.max(45, Math.min(88, 100 - Math.abs(latest.pullback - 50))),
    question: q,
    answer: `\u76EE\u524D\u6536\u76E4 ${fmt(close)}\uFF0C\u56DE\u6A94\u6A5F\u7387 ${latest.pullback}%\u3002\u77ED\u7DDA\u652F\u6490 ${fmt(levels.supportShort)}\uFF0C\u4E2D\u7DDA\u652F\u6490 ${fmt(levels.supportMid)}\uFF0C\u77ED\u7DDA\u58D3\u529B ${fmt(levels.resistanceShort)}\u3002${highRisk ? "\u4E0D\u5EFA\u8B70\u8FFD\u9AD8\uFF0C\u7B49\u56DE\u6E2C\u6216\u91CF\u7E2E\u6574\u7406\u8F03\u597D\u3002" : trendUp ? "\u8DA8\u52E2\u4ECD\u504F\u591A\uFF0C\u4F46\u9032\u5834\u4ECD\u9700\u5206\u6279\u3002" : "\u76EE\u524D\u4EE5\u89C0\u5BDF\u548C\u63A7\u98A8\u96AA\u70BA\u4E3B\u3002"}`,
    keyPoints: [
      `\u5747\u7DDA\uFF1AMA20 ${fmt(latest.ma20)}\u3001MA60 ${fmt(latest.ma60)}\u3001MA120 ${fmt(latest.ma120)}\u3002`,
      `\u6307\u6A19\uFF1ARSI14 ${fmt(latest.rsi14, 1)}\u3001KD ${fmt(latest.k, 1)} / ${fmt(latest.d, 1)}\u3001MACD Hist ${fmt(latest.hist, 3)}\u3002`,
      `\u6A5F\u7387\uFF1A\u6574\u9AD4 ${prob.overall}%\u3001\u6280\u8853 ${prob.technical}%\u3001\u91CF\u80FD ${prob.volume}%\u3001\u6CE2\u6BB5 ${prob.wave}%\u3002`,
    ],
    actions: [
      `\u7B2C\u4E00\u89C0\u5BDF\u8CB7\u9EDE\uFF1A${fmt(levels.supportShort * 0.99)} - ${fmt(levels.supportShort * 1.01)}\u3002`,
      `\u7B2C\u4E8C\u5206\u6279\u8CB7\u9EDE\uFF1A${fmt(levels.supportMid * 0.99)} - ${fmt(levels.supportMid * 1.02)}\u3002`,
      `\u505C\u640D\uFF1A${fmt(stop)}\uFF1B\u76EE\u6A19\uFF1A${fmt(target1)} / ${fmt(target2)}\u3002`,
    ],
    watchlist: [
      "\u82E5\u8DCC\u7834 MA20 \u4E14\u7121\u6CD5\u6536\u56DE\uFF0C\u77ED\u7DDA\u7D50\u69CB\u8F49\u5F31\u3002",
      "\u82E5\u7A81\u7834\u58D3\u529B\u4F46\u91CF\u80FD\u6C92\u6709\u653E\u5927\uFF0C\u5BB9\u6613\u662F\u5047\u7A81\u7834\u3002",
      "\u82E5 RSI \u7DAD\u6301 70 \u4EE5\u4E0A\uFF0C\u4EE3\u8868\u5F37\u52E2\u4F46\u8FFD\u50F9\u98A8\u96AA\u540C\u6B65\u5347\u9AD8\u3002",
    ],
    disclaimer: "\u672C\u9801\u70BA\u6280\u8853\u5206\u6790\u8207\u60C5\u5883\u63A8\u4F30\u5DE5\u5177\uFF0C\u4E0D\u69CB\u6210\u6295\u8CC7\u5EFA\u8B70\u3002",
    generatedAt: new Date().toISOString(),
  };
}

export const handler = router({
  "GET /api/_healthcheck": [async () => json({ message: "Success" })],

  "GET /api/quote": [async ({ query }: any) => {
    const code = cleanCode(query.code);
    if (!code) return error("Missing stock code", 400);
    try {
      return json({ ok: true, quote: await loadQuote(code), generatedAt: new Date().toISOString() });
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to load quote data for ${code}: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/agent": [async ({ query }: any) => {
    const code = cleanCode(query.code);
    const question = String(query.question || "").slice(0, 500);
    if (!code) return error("Missing stock code", 400);
    try {
      const quote = await loadQuote(code);
      return json({
        ok: true,
        quote: {
          code: quote.code,
          symbol: quote.symbol,
          name: quote.name,
          market: quote.market,
          close: quote.close,
          source: quote.source,
          sourceUrls: quote.sourceUrls,
        },
        agent: buildAgentReply(quote, question),
      });
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to run analysis agent for ${code}: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/news": [async ({ query }: any) => {
    const code = cleanCode(query.code);
    const name = String(query.name || FALLBACK_NAMES[code] || code).slice(0, 40);
    if (!code) return error("Missing stock code", 400);
    return json(await loadNews(code, name));
  }],

  "GET /api/fundamentals": [async ({ query }: any) => {
    const code = cleanCode(query.code);
    if (!code || !/^\d{4,6}$/.test(code)) return error("Missing or invalid stock code", 400);
    try {
      const payload = await loadFundamentals(code);
      return json(payload, payload.ok ? 200 : 503);
    } catch (err) {
      return json({
        ok: false,
        partial: false,
        code,
        message: finMindPublicMessage(err),
        generatedAt: new Date().toISOString(),
      }, 503);
    }
  }],

  "GET /api/value-score": [async ({ query }: any) => {
    const code = cleanCode(query.code);
    if (!code || !/^\d{4,6}$/.test(code)) return error("Missing or invalid stock code", 400);
    try {
      return json({ ok: true, score: await loadValueScore(code), generatedAt: new Date().toISOString() });
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build value score for ${code}: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/screener": [async ({ query }: any) => {
    const mode = String(query.mode || "undervalued").replace(/[^a-z-]/g, "").slice(0, 32) || "undervalued";
    try {
      return json(await loadScreener(mode, query.universe), 200);
    } catch (err) {
      return json({
        ok: false,
        mode,
        message: `Unable to build screener: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/universe": [async () => {
    try {
      return json(await loadTaiwanCompanyUniverse(), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to load Taiwan company universe: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/workbench": [async () => {
    try {
      return json(await loadWorkbench(), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build workbench: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],
});
