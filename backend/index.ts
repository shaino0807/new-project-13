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

type YahooChartRange = "1y" | "5y";

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
let finMindTokenDisabledUntil = 0;

async function getFinMindToken() {
  if (Date.now() < finMindTokenDisabledUntil) return "";
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
  if (dataset === "TaiwanStockDividend") return 6 * 60 * 60 * 1000;
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
  if (dataset === "TaiwanStockDividend") return isoDateDaysAgo(365 * 6 + 30);
  if (dataset === "TaiwanStockPER") return isoDateDaysAgo(365 * 5 + 30);
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function requestFinMindDataset(dataset: string, code: string, timeoutMs = 12000): Promise<FinMindDatasetResult> {
  const cacheKey = `${dataset}:${code}`;
  const inflightKey = timeoutMs >= 12000 ? cacheKey : `${cacheKey}:timeout:${timeoutMs}`;
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

  const activeRequest = finMindInflight.get(inflightKey);
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
    const requestUrlFor = (startDate?: string) => {
      const scoped = new URLSearchParams(params);
      if (dataset !== "TaiwanStockInfo" && startDate) scoped.set("start_date", startDate);
      return `${FINMIND_API_URL}?${scoped.toString()}`;
    };
    const fetchDataset = async (useToken: boolean, startDate?: string) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(requestUrlFor(startDate), {
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
      let data: FinMindRow[] | null = null;
      let lastError: unknown = null;
      const startDates = dataset === "TaiwanStockPER"
        ? [finMindStartDate(dataset), isoDateDaysAgo(120)]
        : [finMindStartDate(dataset)];
      const attempts: Array<{ useToken: boolean; startDate: string }> = [];
      startDates.forEach(startDate => {
        attempts.push({ useToken: false, startDate });
        if (token && dataset !== "TaiwanStockDividend") attempts.push({ useToken: true, startDate });
      });
      for (const attempt of attempts) {
        try {
          data = await fetchDataset(attempt.useToken, attempt.startDate);
          break;
        } catch (err) {
          lastError = err;
          if (attempt.useToken && err instanceof FinMindError && err.code === "auth_error") {
            finMindTokenPromise = null;
            finMindTokenDisabledUntil = Date.now() + 30 * 60 * 1000;
            break;
          }
          if (!(err instanceof FinMindError) || !["quota_exceeded", "auth_error", "upstream_error"].includes(err.code)) break;
        }
      }
      if (!data) throw lastError;
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

  finMindInflight.set(inflightKey, request);
  try {
    return await request;
  } finally {
    finMindInflight.delete(inflightKey);
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

function numericSeries(rows: FinMindRow[], key: string) {
  return rows
    .map(row => finiteOrNull(row[key]))
    .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
}

function percentileRank(values: number[], current: number | null | undefined) {
  if (!Number.isFinite(current) || !values.length) return null;
  const valid = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const below = valid.filter(value => value < (current as number)).length;
  const equal = valid.filter(value => value === (current as number)).length;
  return round(((below + equal * 0.5) / valid.length) * 100, 1);
}

function median(values: number[]) {
  const valid = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : round((valid[mid - 1] + valid[mid]) / 2, 4);
}

function buildValuationSummary(rows: FinMindRow[]) {
  const latest = latestRow(rows);
  if (!latest) return null;
  const datedRows = rows
    .filter(row => row.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const perSeries = numericSeries(datedRows, "PER");
  const pbrSeries = numericSeries(datedRows, "PBR");
  const dividendYieldSeries = numericSeries(datedRows, "dividend_yield");
  const per = finiteOrNull(latest.PER);
  const pbr = finiteOrNull(latest.PBR);
  const dividendYield = finiteOrNull(latest.dividend_yield);
  const perPercentile = percentileRank(perSeries, per);
  const pbrPercentile = percentileRank(pbrSeries, pbr);
  const dividendYieldPercentile = percentileRank(dividendYieldSeries, dividendYield);
  const selfCheapnessScore = strictWeightedScore([
    { score: perPercentile === null ? null : 100 - perPercentile, weight: 40 },
    { score: pbrPercentile === null ? null : 100 - pbrPercentile, weight: 35 },
    { score: dividendYieldPercentile, weight: 25 },
  ]);
  return {
    date: latest.date,
    per,
    pbr,
    dividendYield,
    history: {
      startDate: datedRows[0]?.date || null,
      endDate: datedRows[datedRows.length - 1]?.date || null,
      observations: datedRows.length,
      perPercentile,
      pbrPercentile,
      dividendYieldPercentile,
      perMedian: median(perSeries),
      pbrMedian: median(pbrSeries),
      dividendYieldMedian: median(dividendYieldSeries),
      cheapnessScore: selfCheapnessScore,
    },
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
  distribution: {
    source: string;
    sourceUrl: string;
    latestDate: string | null;
    observations: number;
    annualCashDistributions: Array<{ year: number; cash: number }>;
    trailingTwelveMonthCash: number | null;
    trailingYieldPct: number | null;
    continuityYears: number | null;
    missingYears: number[];
    continuityScore: number | null;
    payoutVolatilityScore: number | null;
    yieldReasonablenessScore: number | null;
    evidence: string[];
    missing: string[];
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

function firstFinite(...values: unknown[]) {
  for (const value of values) {
    const n = finiteOrNull(value);
    if (n !== null) return n;
  }
  return null;
}

function dividendRowDate(row: FinMindRow) {
  return normalizeDate(
    row.CashExDividendTradingDate
    || row.CashDividendPaymentDate
    || row.StockExDividendTradingDate
    || row.date,
  );
}

function cashDistributionFromRow(row: FinMindRow) {
  const direct = firstFinite(
    row.CashDividend,
    row.cash_dividend,
    row.dividend,
    row.CashDistribution,
    row.TotalCashDividend,
  );
  if (direct !== null) return direct;
  const parts = [
    row.CashEarningsDistribution,
    row.CashStatutorySurplus,
    row.CashCapitalReserve,
  ].map(value => finiteOrNull(value)).filter((value): value is number => value !== null && Number.isFinite(value) && value > 0);
  const total = parts.reduce((sum, value) => sum + value, 0);
  return total > 0 ? round(total, 4) : null;
}

function continuityScoreFromYears(count: number | null) {
  if (count === null) return null;
  if (count >= 5) return 92;
  if (count === 4) return 78;
  if (count === 3) return 62;
  if (count === 2) return 45;
  if (count === 1) return 28;
  return 12;
}

function volatilityScoreFromAnnual(values: number[]) {
  const usable = values.filter(value => Number.isFinite(value) && value > 0);
  if (usable.length < 3) return null;
  const mean = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  if (!mean) return null;
  const cv = std(usable) / mean;
  if (cv <= 0.15) return 90;
  if (cv <= 0.3) return 78;
  if (cv <= 0.5) return 60;
  if (cv <= 0.8) return 42;
  return 25;
}

function distributionYieldScore(yieldPct: number | null) {
  if (yieldPct === null) return null;
  if (yieldPct >= 3 && yieldPct <= 8) return 82;
  if (yieldPct >= 2 && yieldPct <= 10) return 68;
  if (yieldPct > 10 && yieldPct <= 12) return 45;
  if (yieldPct > 12) return 25;
  if (yieldPct >= 0.5) return 42;
  return 20;
}

function buildEtfDistributionHistory(rows: FinMindRow[], close: number | null) {
  const events = rows
    .map(row => {
      const date = dividendRowDate(row);
      const cash = cashDistributionFromRow(row);
      return date && cash !== null && cash > 0 ? { date, year: Number(date.slice(0, 4)), cash } : null;
    })
    .filter((row): row is { date: string; year: number; cash: number } => Boolean(row))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!events.length) {
    return {
      source: "FinMind TaiwanStockDividend",
      sourceUrl: FINMIND_SOURCE_URL,
      latestDate: null,
      observations: 0,
      annualCashDistributions: [],
      trailingTwelveMonthCash: null,
      trailingYieldPct: null,
      continuityYears: null,
      missingYears: [],
      continuityScore: null,
      payoutVolatilityScore: null,
      yieldReasonablenessScore: null,
      evidence: [],
      missing: ["distribution history"],
    };
  }
  const annual = new Map<number, number>();
  events.forEach(event => annual.set(event.year, round((annual.get(event.year) || 0) + event.cash, 4)));
  const latestDate = events[events.length - 1].date;
  const latestTime = Date.parse(latestDate);
  const trailingEvents = Number.isFinite(latestTime)
    ? events.filter(event => Date.parse(event.date) >= latestTime - 370 * 86400000)
    : events.slice(-4);
  const trailingCash = trailingEvents.length
    ? round(trailingEvents.reduce((sum, event) => sum + event.cash, 0), 4)
    : null;
  const latestYear = events[events.length - 1].year;
  const windowYears = Array.from({ length: 5 }, (_, index) => latestYear - 4 + index);
  const annualCashDistributions = windowYears.map(year => ({ year, cash: round(annual.get(year) || 0, 4) }));
  const continuityYears = annualCashDistributions.filter(item => item.cash > 0).length;
  const missingYears = annualCashDistributions.filter(item => item.cash <= 0).map(item => item.year);
  const trailingYieldPct = trailingCash !== null && close !== null && close > 0
    ? round((trailingCash / close) * 100, 2)
    : null;
  const volatilityScore = volatilityScoreFromAnnual(annualCashDistributions.map(item => item.cash));
  return {
    source: "FinMind TaiwanStockDividend",
    sourceUrl: FINMIND_SOURCE_URL,
    latestDate,
    observations: events.length,
    annualCashDistributions,
    trailingTwelveMonthCash: trailingCash,
    trailingYieldPct,
    continuityYears,
    missingYears,
    continuityScore: continuityScoreFromYears(continuityYears),
    payoutVolatilityScore: volatilityScore,
    yieldReasonablenessScore: distributionYieldScore(trailingYieldPct),
    evidence: [
      `distribution observations ${events.length}`,
      `latest distribution ${latestDate}`,
      trailingCash !== null ? `TTM cash distribution ${fmt(trailingCash, 4)}` : "",
      trailingYieldPct !== null ? `TTM distribution yield ${fmt(trailingYieldPct, 2)}%` : "",
      `paid years ${continuityYears}/5`,
      volatilityScore !== null ? `payout volatility score ${volatilityScore}` : "",
    ].filter(Boolean),
    missing: [
      trailingYieldPct === null ? "trailing distribution yield" : "",
      volatilityScore === null ? "3+ annual distribution observations" : "",
      continuityYears < 5 ? `missing distribution years ${missingYears.join(", ")}` : "",
    ].filter(Boolean),
  };
}

function buildEtfNavReturnStability(quote: QuoteInfo, distributionYieldPct: number | null, premiumDiscount: number | null) {
  const series = (quote.series || []).filter(row => Number.isFinite(row.close) && row.close > 0);
  if (series.length < 60) {
    return {
      score: Number.isFinite(premiumDiscount) ? Math.max(25, Math.min(80, Math.round(82 - Math.abs(premiumDiscount as number) * 12))) : null,
      evidence: [Number.isFinite(premiumDiscount) ? `premium/discount ${fmt(premiumDiscount as number, 2)}%` : ""].filter(Boolean),
      missing: ["price total-return history"],
    };
  }
  const first = series[0].close;
  const last = series[series.length - 1].close;
  const priceReturnPct = round(((last / first) - 1) * 100, 2);
  const maxClose = Math.max(...series.map(row => row.close));
  const drawdownPct = maxClose > 0 ? round((1 - last / maxClose) * 100, 2) : null;
  const totalReturnProxy = distributionYieldPct !== null ? round(priceReturnPct + distributionYieldPct, 2) : priceReturnPct;
  let score = totalReturnProxy >= 12 && (drawdownPct ?? 99) <= 12 ? 88
    : totalReturnProxy >= 5 && (drawdownPct ?? 99) <= 18 ? 76
      : totalReturnProxy >= 0 ? 62
        : totalReturnProxy >= -8 ? 42
          : 24;
  if (distributionYieldPct !== null && distributionYieldPct >= 8 && priceReturnPct < -5) score = Math.min(score, 45);
  if (premiumDiscount !== null && Number.isFinite(premiumDiscount) && Math.abs(premiumDiscount) > 3) score = Math.min(score, 55);
  return {
    score,
    evidence: [
      `1y price return ${fmt(priceReturnPct, 2)}%`,
      distributionYieldPct !== null ? `TTM distribution yield ${fmt(distributionYieldPct, 2)}%` : "",
      `total-return proxy ${fmt(totalReturnProxy, 2)}%`,
      drawdownPct !== null ? `drawdown from 1y high ${fmt(drawdownPct, 2)}%` : "",
      premiumDiscount !== null ? `premium/discount ${fmt(premiumDiscount, 2)}%` : "",
    ].filter(Boolean),
    missing: distributionYieldPct === null ? ["trailing distribution yield"] : [],
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

async function loadEtfProfile(code: string, name: string, options: { fast?: boolean } = {}): Promise<EtfProfile> {
  const cacheKey = `${code}:${options.fast ? "fast" : "full"}`;
  const cached = etfProfileCache.get(cacheKey);
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
    distribution: null,
    warnings: [],
  };

  const distributionPromise = withTimeout(
    requestFinMindDataset("TaiwanStockDividend", code, options.fast ? 2500 : 5000),
    options.fast ? 2500 : 5000,
    "ETF distribution history timed out",
  ).then(dividendRows => {
    profile.distribution = buildEtfDistributionHistory(dividendRows.data, null);
  }).catch(err => {
    profile.warnings.push(`ETF distribution history unavailable: ${finMindPublicMessage(err)}`);
  });

  if (code === "0050") {
    const holdingsUrl = "https://www.yuantaetfs.com/product/detail/0050/ratio";
    const navUrl = "https://www.yuantaetfs.com/tradeInfo/pcf/0050";
    try {
      const [holdingsHtml, navHtml, quote] = await Promise.all([
        fetchText(holdingsUrl, options.fast ? 7000 : 18000),
        fetchText(navUrl, options.fast ? 7000 : 18000),
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
      if (profile.holdings.length && !options.fast) {
        const components = await buildEtfComponentSummary(profile.holdings);
        profile.holdings = components.holdings;
        profile.componentSummary = components.summary;
      } else if (profile.holdings.length && options.fast) {
        profile.warnings.push("ETF holdings component summary skipped in fast workbench mode.");
      } else {
        profile.warnings.push("\u5143\u5927\u6295\u4FE1\u6301\u80A1\u9801\u76EE\u524D\u6C92\u6709\u53EF\u89E3\u6790\u7684\u6210\u5206\u80A1\u3002");
      }
    } catch (err) {
      profile.warnings.push(`0050 ETF \u5B98\u65B9\u8CC7\u6599\u66AB\u6642\u7121\u6CD5\u53D6\u5F97\uFF1A${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
      profile.warnings.push("\u76EE\u524D\u5B8C\u6574\u6210\u5206\u80A1\u8207\u6DE8\u503C\u805A\u5408\u5148\u652F\u63F4 0050\uFF0C\u5176\u4ED6 ETF \u4ECD\u4FDD\u7559\u6CD5\u4EBA\u8207\u7C4C\u78BC\u8CC7\u6599\u3002");
  }

  await distributionPromise;
  etfProfileCache.set(cacheKey, { data: profile, fetchedAt: Date.now() });
  return profile;
}

async function loadFundamentals(code: string, options: { fast?: boolean } = {}) {
  const authenticated = Boolean(await getFinMindToken());
  let infoResult: FinMindDatasetResult | null = null;
  try {
    infoResult = await requestFinMindDataset("TaiwanStockInfo", code, options.fast ? 5000 : 12000);
  } catch {
    infoResult = null;
  }
  const infoRows = infoResult?.data || [];
  const stockInfo = latestRow(infoRows);
  const isEtf = infoRows.some(row =>
    String(row?.industry_category || "").trim().toUpperCase().includes("ETF")
  ) || code === "0050";
  const assetType = isEtf ? "etf" : "stock";
  const datasets = options.fast
    ? assetType === "etf"
      ? [
          "TaiwanStockInstitutionalInvestorsBuySellWide",
        ]
      : [
          "TaiwanStockFinancialStatements",
          "TaiwanStockBalanceSheet",
          "TaiwanStockCashFlowsStatement",
          "TaiwanStockMonthRevenue",
          "TaiwanStockPER",
          "TaiwanStockInstitutionalInvestorsBuySellWide",
        ]
    : assetType === "etf"
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
  const results = await Promise.allSettled(datasets.map(dataset => requestFinMindDataset(dataset, code, options.fast ? 5000 : 12000)));
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
    ? await loadEtfProfile(code, stockInfo?.stock_name || FALLBACK_NAMES[code] || code, options)
    : null;
  const data = {
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
  };
  let officialFinancialFallback: Awaited<ReturnType<typeof loadOfficialFinancialFallback>> | null = null;
  let officialRevenueFallback: Awaited<ReturnType<typeof loadOfficialRevenueFallback>> | null = null;
  if (!options.fast && assetType === "stock" && (!data.profitability || !data.balanceSheet)) {
    try {
      officialFinancialFallback = await loadOfficialFinancialFallback(code);
      if (!data.profitability && officialFinancialFallback.profitability) {
        data.profitability = officialFinancialFallback.profitability as any;
      }
      if (!data.balanceSheet && officialFinancialFallback.balanceSheet) {
        data.balanceSheet = officialFinancialFallback.balanceSheet as any;
      }
      if (officialFinancialFallback.profitability || officialFinancialFallback.balanceSheet) {
        const fallbackFetchedAt = Date.parse(officialFinancialFallback.fetchedAt);
        if (Number.isFinite(fallbackFetchedAt)) fetchedTimes.push(fallbackFetchedAt);
      }
    } catch (err) {
      errors.push({
        dataset: "TWSE/TPEx MOPS fallback",
        code: "upstream_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!options.fast && assetType === "stock" && !data.revenue) {
    try {
      officialRevenueFallback = await loadOfficialRevenueFallback(code);
      if (officialRevenueFallback?.revenue) {
        data.revenue = officialRevenueFallback.revenue as any;
        const revenueFetchedAt = Date.parse(officialRevenueFallback.fetchedAt);
        if (Number.isFinite(revenueFetchedAt)) fetchedTimes.push(revenueFetchedAt);
      }
    } catch (err) {
      errors.push({
        dataset: "TWSE monthly revenue fallback",
        code: "upstream_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const fallbackApplied = Boolean(officialFinancialFallback?.profitability || officialFinancialFallback?.balanceSheet || officialRevenueFallback?.revenue);
  const cachedDataStatus = [...cachedDatasets];
  const staleDataStatus = [...staleDatasets];
  if (fallbackApplied) {
    if (officialFinancialFallback?.profitability || officialFinancialFallback?.balanceSheet) {
      cachedDataStatus.push("TWSE/TPEx MOPS fallback");
      staleDataStatus.push("TWSE/TPEx MOPS fallback");
    }
    if (officialRevenueFallback?.revenue) {
      cachedDataStatus.push("TWSE monthly revenue fallback");
      staleDataStatus.push("TWSE monthly revenue fallback");
    }
  }
  const hasActualData = Boolean(
    data.profitability ||
    data.revenue ||
    data.valuation ||
    data.cashFlow ||
    data.balanceSheet ||
    data.institutional ||
    data.foreignShareholding ||
    data.margin ||
    data.securitiesLending ||
    data.etf
  );

  return {
    ok: hasActualData,
    partial: errors.length > 0 || staleDatasets.length > 0 || fallbackApplied,
    code,
    assetType,
    source: fallbackApplied ? "FinMind + official fallback" : "FinMind",
    sourceUrl: FINMIND_SOURCE_URL,
    fallbackSourceUrl: fallbackApplied ? officialFinancialFallback?.sourceUrl || officialRevenueFallback?.sourceUrl || null : null,
    requestMode: authenticated ? "token" : "anonymous",
    generatedAt: new Date().toISOString(),
    fetchedAt: fetchedTimes.length ? new Date(Math.max(...fetchedTimes)).toISOString() : null,
    cache: {
      cachedDatasets: cachedDataStatus,
      staleDatasets: staleDataStatus,
      policy: "\u8CA1\u5831 6 \u5C0F\u6642\u3001\u6708\u71DF\u6536 2 \u5C0F\u6642\u3001\u4F30\u503C\u8207\u7C4C\u78BC 30 \u5206\u9418\uFF1B\u4F86\u6E90\u5931\u6557\u6642\u6700\u591A\u6CBF\u7528 24 \u5C0F\u6642\u820A\u5FEB\u53D6\u3002",
    },
    data,
    errors,
  };
}

type ScoreComponent = {
  score: number | null;
  label: string;
  weight: number;
  evidence: string[];
  missing: string[];
  groups?: Record<string, { score: number | null; weight: number; evidence: string[]; missing: string[] }>;
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
  scoreV2: any;
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
const MOPS_FINANCIAL_URL = "https://mops.twse.com.tw/mops/web";
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

function currentRocQuarterCandidates() {
  const now = new Date();
  const westernYear = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  let season = Math.max(1, Math.min(4, Math.floor((month - 1) / 3)));
  let rocYear = westernYear - 1911;
  const candidates: Array<{ year: number; season: number }> = [];
  for (let i = 0; i < 6; i += 1) {
    candidates.push({ year: rocYear, season });
    season -= 1;
    if (season < 1) {
      season = 4;
      rocYear -= 1;
    }
  }
  return candidates;
}

function decodeHtml(text: string) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function cleanMopsCell(html: string) {
  return decodeHtml(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function parseMopsNumeric(value: string | undefined) {
  if (!value) return null;
  const normalized = value
    .replace(/,/g, "")
    .replace(/[()]/g, match => match === "(" ? "-" : "")
    .replace(/[^\d.-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapMopsRow(html: string, code: string) {
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let headers: string[] = [];
  for (const row of rows) {
    const cellMatches = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
    const cells = cellMatches.map(cleanMopsCell).filter(Boolean);
    if (!cells.length) continue;
    if (/<th/i.test(row) || cells.some(cell => cell.includes("\u516C\u53F8\u4EE3\u865F") || cell.includes("\u516C\u53F8\u540D\u7A31"))) {
      headers = cells;
      continue;
    }
    if (!cells.includes(code)) continue;
    const mapped: Record<string, string> = {};
    if (headers.length === cells.length) {
      headers.forEach((header, index) => {
        mapped[header] = cells[index];
      });
    }
    cells.forEach((cell, index) => {
      mapped[`cell${index}`] = cell;
    });
    return mapped;
  }
  return null;
}

function pickMopsValue(row: Record<string, string> | null, includes: string[]) {
  if (!row) return null;
  for (const [key, value] of Object.entries(row)) {
    if (includes.every(part => key.includes(part))) {
      const parsed = parseMopsNumeric(value);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

async function fetchMopsFinancialRow(endpoint: "ajax_t163sb04" | "ajax_t163sb05", code: string) {
  const typeCandidates = ["sii", "otc", "rotc"];
  const quarterCandidates = currentRocQuarterCandidates();
  for (const { year, season } of quarterCandidates) {
    const settled = await Promise.allSettled(typeCandidates.map(async typek => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const body = new URLSearchParams({
          encodeURIComponent: "1",
          step: "1",
          firstin: "1",
          off: "1",
          TYPEK: typek,
          year: String(year),
          season: String(season),
        });
        const res = await fetch(`${MOPS_FINANCIAL_URL}/${endpoint}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });
        const text = await res.text();
        if (!res.ok || !text.includes(code)) return null;
        const mapped = mapMopsRow(text, code);
        if (mapped) {
          return {
            row: mapped,
            typek,
            date: `${year + 1911}Q${season}`,
          };
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    }));
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) {
        return result.value;
      }
    }
  }
  return null;
}

async function loadOfficialFinancialFallback(code: string) {
  const [income, balance] = await Promise.all([
    fetchMopsFinancialRow("ajax_t163sb04", code),
    fetchMopsFinancialRow("ajax_t163sb05", code),
  ]);
  const incomeRow = income?.row || null;
  const balanceRow = balance?.row || null;
  const revenue = pickMopsValue(incomeRow, ["\u71DF\u696D\u6536\u5165"]);
  const operatingIncome = pickMopsValue(incomeRow, ["\u71DF\u696D\u5229\u76CA"]);
  const pretaxIncome = pickMopsValue(incomeRow, ["\u7A05\u524D"]);
  const netIncome = pickMopsValue(incomeRow, ["\u6DE8\u5229"]);
  const eps = pickMopsValue(incomeRow, ["\u6BCF\u80A1\u76C8\u9918"]);
  const totalAssets = pickMopsValue(balanceRow, ["\u8CC7\u7522\u7E3D\u8A08"]);
  const liabilities = pickMopsValue(balanceRow, ["\u8CA0\u50B5\u7E3D\u8A08"]);
  const equity = pickMopsValue(balanceRow, ["\u6B0A\u76CA\u7E3D\u8A08"]);
  return {
    source: "TWSE/TPEx MOPS",
    sourceUrl: "https://mops.twse.com.tw/mops/web/index",
    fetchedAt: new Date().toISOString(),
    profitability: income && [revenue, operatingIncome, pretaxIncome, netIncome, eps].some(value => value !== null)
      ? {
          date: income.date,
          revenue,
          operatingIncome,
          pretaxIncome,
          netIncome,
          eps,
          revenueYoY: null,
          epsYoY: null,
        }
      : null,
    balanceSheet: balance && [totalAssets, liabilities, equity].some(value => value !== null)
      ? {
          date: balance.date,
          totalAssets,
          liabilities,
          equity,
          liabilityRatio: totalAssets ? (Number(liabilities || 0) / totalAssets) * 100 : null,
          currentRatio: null,
          cashAndEquivalents: null,
        }
      : null,
  };
}

async function requestOfficialMonthlyRevenueRows() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch("https://openapi.twse.com.tw/v1/opendata/t187ap05_L", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`TWSE monthly revenue HTTP ${res.status}: ${text.slice(0, 120)}`);
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error("TWSE monthly revenue returned a non-array payload");
    return rows as Array<Record<string, string>>;
  } finally {
    clearTimeout(timer);
  }
}

function officialRevenueDate(value: unknown) {
  const raw = String(value || "").replace(/[^0-9]/g, "");
  if (raw.length < 5) return new Date().toISOString().slice(0, 10);
  const year = Number(raw.slice(0, raw.length - 2)) + 1911;
  const month = raw.slice(-2);
  return `${year}-${month}-01`;
}

async function loadOfficialRevenueFallback(code: string) {
  const rows = await requestOfficialMonthlyRevenueRows();
  const row = rows.find(item => cleanCode(String(item["\u516C\u53F8\u4EE3\u865F"] || "")) === code) || null;
  if (!row) return null;
  const revenue = parseMopsNumeric(row["\u71DF\u696D\u6536\u5165-\u7576\u6708\u71DF\u6536"]);
  const previousYearRevenue = parseMopsNumeric(row["\u71DF\u696D\u6536\u5165-\u53BB\u5E74\u7576\u6708\u71DF\u6536"]);
  const yoy = parseMopsNumeric(row["\u71DF\u696D\u6536\u5165-\u53BB\u5E74\u540C\u6708\u589E\u6E1B(%)"]);
  if (revenue === null && yoy === null) return null;
  const date = officialRevenueDate(row["\u8CC7\u6599\u5E74\u6708"]);
  return {
    source: "TWSE OpenAPI monthly revenue",
    sourceUrl: "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
    fetchedAt: new Date().toISOString(),
    revenue: {
      date,
      createTime: row["\u51FA\u8868\u65E5\u671F"] || null,
      revenue,
      yoy,
      recent: [{
        date,
        year: Number(date.slice(0, 4)),
        month: Number(date.slice(5, 7)),
        revenue,
        yoy,
      }],
      latestAverageYoY: yoy,
      priorAverageYoY: null,
      acceleration: null,
      previousYearRevenue,
    },
  };
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

function strictWeightedScore(parts: Array<{ score: number | null; weight: number }>) {
  const totalWeight = parts.filter(part => part.weight > 0).reduce((sum, part) => sum + part.weight, 0);
  if (!totalWeight) return null;
  const scored = parts.reduce((sum, part) => {
    if (part.weight <= 0 || part.score === null || !Number.isFinite(part.score)) return sum;
    return sum + (part.score as number) * part.weight;
  }, 0);
  return Math.round(scored / totalWeight);
}

function weightedAvailability(parts: Array<{ score: number | null; weight: number }>) {
  const totalWeight = parts.filter(part => part.weight > 0).reduce((sum, part) => sum + part.weight, 0);
  if (!totalWeight) return 0;
  const availableWeight = parts
    .filter(part => part.weight > 0 && part.score !== null && Number.isFinite(part.score))
    .reduce((sum, part) => sum + part.weight, 0);
  return Math.round((availableWeight / totalWeight) * 100);
}

function gradeFromScoreV2(score: number | null, coveragePct: number): "A" | "B" | "C" | "D" | "X" {
  if (score === null || coveragePct < 45) return "X";
  let grade: "A" | "B" | "C" | "D" = score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D";
  if (coveragePct < 55) return "D";
  if (coveragePct < 70 && (grade === "A" || grade === "B")) return "C";
  if (coveragePct < 85 && grade === "A") return "B";
  return grade;
}

function signalScore(signals: Array<number | null>) {
  const usable = signals.filter((value): value is number => Number.isFinite(value));
  if (!usable.length) return null;
  const average = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  return Math.max(0, Math.min(100, Math.round(50 + average * 50)));
}

function scoreFromRange(value: number | null | undefined, bands: Array<[number, number]>) {
  if (!Number.isFinite(value)) return null;
  for (const [limit, score] of bands) {
    if ((value as number) <= limit) return score;
  }
  return bands[bands.length - 1]?.[1] ?? null;
}

function scoreTextValue(value: number | null | undefined) {
  return Number.isFinite(value) ? String(Math.round(value as number)) : "--";
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
  if (etf?.distribution && etf.distribution.trailingTwelveMonthCash !== null && Number.isFinite(close) && close > 0) {
    etf.distribution.trailingYieldPct = round((etf.distribution.trailingTwelveMonthCash / close) * 100, 2);
    etf.distribution.yieldReasonablenessScore = distributionYieldScore(etf.distribution.trailingYieldPct);
    etf.distribution.evidence = [
      ...etf.distribution.evidence.filter(item => !item.startsWith("TTM distribution yield")),
      `TTM distribution yield ${fmt(etf.distribution.trailingYieldPct, 2)}%`,
    ];
    etf.distribution.missing = etf.distribution.missing.filter(item => item !== "trailing distribution yield");
  }
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
    componentForProfessional("distribution", "\u914D\u606F\u54C1\u8CEA", etfDividendScore, 15, [
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
  const universeEntry = TAIWAN_SCREENING_UNIVERSE.find(item => item.code === quote.code);
  const industryGroup = universeEntry?.group || (fundamentals.assetType === "etf" ? "etf" : "unclassified");
  const isFinancialIndustry = /^28/.test(quote.code) || /financial|bank|insurance/i.test(industryGroup);
  const isSemiconductorIndustry = /semiconductor/i.test(industryGroup);
  const isCyclicalIndustry = /steel|materials|plastics|shipping|commodity/i.test(industryGroup);
  const isDividendProfile = /income|dividend/i.test(industryGroup);
  const growthAnchor = [
    revenue?.yoy,
    profit?.epsYoY,
    profit?.revenueYoY,
  ].filter((value): value is number => Number.isFinite(value));
  const normalizedGrowth = growthAnchor.length
    ? Math.max(-20, Math.min(45, growthAnchor.reduce((sum, value) => sum + value, 0) / growthAnchor.length))
    : null;
  const industryFairPer = isSemiconductorIndustry
    ? Math.max(12, Math.min(28, 18 + ((normalizedGrowth ?? 8) / 4)))
    : isFinancialIndustry
      ? Math.max(8, Math.min(14, 10 + ((normalizedGrowth ?? 3) / 12)))
      : isCyclicalIndustry
        ? Math.max(8, Math.min(16, 11 + ((normalizedGrowth ?? 0) / 8)))
        : Math.max(9, Math.min(22, 13 + ((normalizedGrowth ?? 5) / 6)));
  const industryTargetPbr = isFinancialIndustry ? 1.15 : isSemiconductorIndustry ? 2.4 : isCyclicalIndustry ? 1.25 : 1.6;
  const industryTargetYield = isDividendProfile ? 5.8 : isFinancialIndustry ? 5.2 : isCyclicalIndustry ? 4.8 : 3.6;
  const peg = Number.isFinite(valuation?.per) && (valuation?.per || 0) > 0 && normalizedGrowth !== null && normalizedGrowth > 0
    ? round((valuation?.per || 0) / normalizedGrowth, 2)
    : null;
  const pegScore = scoreFromRange(peg, [[0.75, 90], [1, 78], [1.5, 62], [2, 45], [999, 22]]);
  const valuationHistory = valuation?.history || null;
  const selfHistoryScore = valuationHistory?.cheapnessScore ?? null;
  const selfPerPercentile = valuationHistory?.perPercentile ?? null;
  const selfPbrPercentile = valuationHistory?.pbrPercentile ?? null;
  const selfYieldPercentile = valuationHistory?.dividendYieldPercentile ?? null;
  const selfPerMedian = valuationHistory?.perMedian ?? null;
  const selfPbrMedian = valuationHistory?.pbrMedian ?? null;
  const selfYieldMedian = valuationHistory?.dividendYieldMedian ?? null;
  const valuationV2Parts = [
    { score: perScore, weight: 20 },
    { score: pbrScore, weight: 15 },
    { score: yieldScore, weight: 10 },
    { score: rangeScore, weight: 15 },
    { score: pegScore, weight: 20 },
    { score: selfHistoryScore, weight: 20 },
  ];
  const valuationV2Component: ScoreComponent = {
    score: strictWeightedScore(valuationV2Parts),
    label: scoreLabel(strictWeightedScore(valuationV2Parts), "valuation v2 inexpensive", "valuation v2 fair", "valuation v2 expensive"),
    weight: 25,
    evidence: [
      ...valuationComponent.evidence,
      peg !== null ? `PEG ${fmt(peg, 2)}` : "",
      valuationHistory?.observations ? `self valuation history ${valuationHistory.observations} rows` : "",
      Number.isFinite(selfPerPercentile) ? `PER self percentile ${fmt(selfPerPercentile as number, 1)}` : "",
      Number.isFinite(selfPbrPercentile) ? `PBR self percentile ${fmt(selfPbrPercentile as number, 1)}` : "",
      Number.isFinite(selfYieldPercentile) ? `yield self percentile ${fmt(selfYieldPercentile as number, 1)}` : "",
      `industry group ${industryGroup}`,
    ].filter(Boolean),
    missing: [
      ...valuationComponent.missing,
      pegScore === null ? "PEG or positive growth" : "",
      selfHistoryScore === null ? "3-5 year self valuation history" : "",
    ].filter(Boolean),
  };
  const cashFlowV2Parts = [
    { score: ocfScore, weight: 35 },
    { score: fcfScore, weight: 35 },
    { score: cashChangeScore, weight: 15 },
    { score: endingCashScore, weight: 15 },
  ];
  const cashFlowV2Score = strictWeightedScore(cashFlowV2Parts);
  const growthV2Parts = [
    { score: monthlyRevenueScore, weight: 30 },
    { score: revenueMomentumScore, weight: 20 },
    { score: epsGrowthScore, weight: 30 },
    { score: quarterRevenueScore, weight: 20 },
  ];
  const growthV2Score = strictWeightedScore(growthV2Parts);
  const profitabilityV2Parts = [
    { score: epsScore, weight: 35 },
    { score: netIncomeScore, weight: 30 },
    { score: opIncomeScore, weight: 20 },
    { score: grossProfitScore, weight: 15 },
  ];
  const profitabilityV2Score = strictWeightedScore(profitabilityV2Parts);
  const stabilityV2Parts = [
    { score: debtScore, weight: 35 },
    { score: currentRatioScore, weight: 30 },
    { score: cashScore, weight: 20 },
    { score: equityScore, weight: 15 },
  ];
  const stabilityV2Score = strictWeightedScore(stabilityV2Parts);
  const lendingRiskScore = Number.isFinite(lending?.volumeRatio)
    ? ((lending?.volumeRatio || 0) >= 2 ? 28 : (lending?.volumeRatio || 0) >= 1.25 ? 48 : 66)
    : null;
  const capitalConfidenceParts = [
    { score: institutionalScore, weight: 35 },
    { score: foreignScore, weight: 25 },
    { score: marginRiskScore, weight: 20 },
    { score: lendingRiskScore, weight: 20 },
  ];
  const capitalConfidenceComponent: ScoreComponent = {
    score: strictWeightedScore(capitalConfidenceParts),
    label: scoreLabel(strictWeightedScore(capitalConfidenceParts), "capital confidence strong", "capital confidence neutral", "capital confidence weak"),
    weight: 10,
    evidence: [
      ...marketConfidenceComponent.evidence.filter(item => !item.startsWith("technical trend")),
      Number.isFinite(lending?.volumeRatio) ? `securities lending ratio ${fmt(lending?.volumeRatio || NaN, 2)}` : "",
    ].filter(Boolean),
    missing: [
      institutionalScore === null ? "institutional net buy/sell" : "",
      foreignScore === null ? "foreign ownership change" : "",
      marginRiskScore === null ? "margin balance change" : "",
      lendingRiskScore === null ? "securities lending volume" : "",
    ].filter(Boolean),
  };
  const rsiValues = quote.analysis.rsi14 || [];
  const prevRsi = rsiValues.length > 1 ? lastFinite(rsiValues.slice(0, -1)) : NaN;
  const kdK = quote.analysis.kd?.k || [];
  const kdD = quote.analysis.kd?.d || [];
  const prevK = kdK.length > 1 ? lastFinite(kdK.slice(0, -1)) : NaN;
  const prevD = kdD.length > 1 ? lastFinite(kdD.slice(0, -1)) : NaN;
  const histValues = quote.analysis.macd?.hist || [];
  const prevHist = histValues.length > 1 ? lastFinite(histValues.slice(0, -1)) : NaN;
  const maSignals = [latest.ma5, latest.ma10, latest.ma20, latest.ma60, latest.ma120]
    .map(ma => Number.isFinite(ma) ? (close > ma ? 1 : close < ma ? -1 : 0) : null);
  const trendStructureSignals = [
    ...maSignals,
    Number.isFinite(latest.ma20) && Number.isFinite(latest.ma60) ? (latest.ma20 > latest.ma60 ? 1 : latest.ma20 < latest.ma60 ? -1 : 0) : null,
    Number.isFinite(latest.ma60) && Number.isFinite(latest.ma120) ? (latest.ma60 > latest.ma120 ? 1 : latest.ma60 < latest.ma120 ? -1 : 0) : null,
  ];
  const trendSignalScore = signalScore(trendStructureSignals);
  const oscillatorSignalScore = signalScore([
    Number.isFinite(latest.dif) && Number.isFinite(latest.dea) ? (latest.dif > latest.dea ? 1 : latest.dif < latest.dea ? -1 : 0) : null,
    Number.isFinite(latest.hist) && Number.isFinite(prevHist) ? (latest.hist > prevHist ? 1 : latest.hist < prevHist ? -1 : 0) : null,
    Number.isFinite(latest.rsi14) && Number.isFinite(prevRsi)
      ? (latest.rsi14 < 30 && latest.rsi14 > prevRsi ? 1 : latest.rsi14 > 70 && latest.rsi14 < prevRsi ? -1 : latest.rsi14 >= 45 && latest.rsi14 <= 68 ? 0.35 : 0)
      : null,
    Number.isFinite(latest.k) && Number.isFinite(latest.d) && Number.isFinite(prevK) && Number.isFinite(prevD)
      ? (latest.k < 20 && latest.d < 20 && latest.k > latest.d ? 1 : latest.k > 80 && latest.d > 80 && latest.k < latest.d ? -1 : latest.k > latest.d ? 0.25 : -0.25)
      : null,
  ]);
  const technicalVolumeScore = Number.isFinite(latest.volumeRatio)
    ? (latest.volumeRatio >= 1.8 && close < latest.ma20 ? 30 : latest.volumeRatio >= 1.25 && close > latest.ma20 ? 78 : 55)
    : null;
  const volatilityPositionScore = Number.isFinite(latest.pctB)
    ? (latest.pctB > 0.95 ? 32 : latest.pctB > 0.8 ? 48 : latest.pctB >= 0.2 ? 66 : 44)
    : null;
  const technicalTrendParts = [
    { score: trendSignalScore, weight: 40 },
    { score: oscillatorSignalScore, weight: 30 },
    { score: technicalVolumeScore, weight: 15 },
    { score: volatilityPositionScore, weight: 15 },
  ];
  const technicalTrendComponent: ScoreComponent = {
    score: strictWeightedScore(technicalTrendParts),
    label: scoreLabel(strictWeightedScore(technicalTrendParts), "technical trend strong", "technical trend neutral", "technical trend weak"),
    weight: 10,
    evidence: [
      `MA confluence ${scoreTextValue(trendSignalScore)}`,
      `oscillator confluence ${scoreTextValue(oscillatorSignalScore)}`,
      Number.isFinite(latest.volumeRatio) ? `volume ratio ${fmt(latest.volumeRatio, 2)}` : "",
      Number.isFinite(latest.pctB) ? `Bollinger %B ${fmt(latest.pctB, 2)}` : "",
    ].filter(Boolean),
    missing: [
      trendSignalScore === null ? "moving averages" : "",
      oscillatorSignalScore === null ? "oscillators" : "",
      technicalVolumeScore === null ? "volume ratio" : "",
      volatilityPositionScore === null ? "Bollinger position" : "",
    ].filter(Boolean),
  };
  const trendRisk = technicalTrendComponent.score === null ? null : 100 - technicalTrendComponent.score;
  const oscillatorRisk = strictWeightedScore([
    { score: Number.isFinite(latest.rsi14) ? Math.max(10, Math.min(95, Math.round((latest.rsi14 - 35) * 1.45))) : null, weight: 50 },
    { score: Number.isFinite(latest.k) && Number.isFinite(latest.d) ? Math.max(10, Math.min(95, Math.round(((latest.k + latest.d) / 2 - 35) * 1.35))) : null, weight: 25 },
    { score: Number.isFinite(latest.pctB) ? Math.max(10, Math.min(95, Math.round(latest.pctB * 95))) : null, weight: 25 },
  ]);
  const volumeRisk = Number.isFinite(latest.volumeRatio)
    ? (latest.volumeRatio >= 1.8 ? 78 : latest.volumeRatio >= 1.25 ? 62 : 38)
    : null;
  const extensionRisk = Number.isFinite(distanceFromSupport)
    ? Math.max(15, Math.min(95, Math.round((distanceFromSupport as number) * 4)))
    : null;
  const chaseRiskV2Parts = [
    { score: trendRisk, weight: 25 },
    { score: oscillatorRisk, weight: 30 },
    { score: volumeRisk, weight: 20 },
    { score: extensionRisk, weight: 25 },
  ];
  const chaseRiskV2Groups = {
    trend: {
      score: trendRisk,
      weight: 25,
      evidence: technicalTrendComponent.evidence,
      missing: trendRisk === null ? ["moving average trend"] : [],
    },
    oscillator: {
      score: oscillatorRisk,
      weight: 30,
      evidence: [
        Number.isFinite(latest.rsi14) ? `RSI ${fmt(latest.rsi14, 1)}` : "",
        Number.isFinite(latest.k) && Number.isFinite(latest.d) ? `Stochastic K/D ${fmt(latest.k, 1)}/${fmt(latest.d, 1)}` : "",
        Number.isFinite(latest.pctB) ? `Bollinger %B ${fmt(latest.pctB, 2)}` : "",
      ].filter(Boolean),
      missing: oscillatorRisk === null ? ["RSI/Stochastic/Bollinger oscillator group"] : [],
    },
    volume: {
      score: volumeRisk,
      weight: 20,
      evidence: [Number.isFinite(latest.volumeRatio) ? `volume ratio ${fmt(latest.volumeRatio, 2)}` : ""].filter(Boolean),
      missing: volumeRisk === null ? ["volume ratio"] : [],
    },
    extension: {
      score: extensionRisk,
      weight: 25,
      evidence: [Number.isFinite(distanceFromSupport) ? `distance from short-term support ${fmt(distanceFromSupport as number, 2)}%` : ""].filter(Boolean),
      missing: extensionRisk === null ? ["support distance"] : [],
    },
  };
  const chaseRiskV2Component: ScoreComponent = {
    score: strictWeightedScore(chaseRiskV2Parts),
    label: scoreLabel(strictWeightedScore(chaseRiskV2Parts), "\u8FFD\u9AD8\u98A8\u96AA\u9AD8", "\u8FFD\u9AD8\u98A8\u96AA\u4E2D", "\u8FFD\u9AD8\u98A8\u96AA\u4F4E"),
    weight: 10,
    evidence: [
      `trend risk ${scoreTextValue(trendRisk)}`,
      `oscillator risk ${scoreTextValue(oscillatorRisk)}`,
      Number.isFinite(volumeRisk) ? `volume risk ${volumeRisk}` : "",
      Number.isFinite(extensionRisk) ? `extension risk ${extensionRisk}` : "",
    ].filter(Boolean),
    missing: [
      trendRisk === null ? "trend group" : "",
      oscillatorRisk === null ? "oscillator group" : "",
      volumeRisk === null ? "volume group" : "",
      extensionRisk === null ? "support distance" : "",
    ].filter(Boolean),
    groups: chaseRiskV2Groups,
  };
  const oneLotCost = Number.isFinite(close) ? close * 1000 : null;
  const entryCostScore = Number.isFinite(oneLotCost)
    ? ((oneLotCost as number) <= 50000 ? 90 : (oneLotCost as number) <= 100000 ? 76 : (oneLotCost as number) <= 300000 ? 58 : 42)
    : null;
  const liquidityV2Score = Number.isFinite(quote.volume)
    ? (quote.volume >= 5000000 ? 88 : quote.volume >= 1000000 ? 74 : quote.volume >= 200000 ? 55 : quote.volume > 0 ? 38 : null)
    : null;
  const volatilityV2Score = Number.isFinite(latest.atrPct)
    ? (latest.atrPct <= 2 ? 82 : latest.atrPct <= 4 ? 68 : latest.atrPct <= 7 ? 50 : 34)
    : null;
  const positionRiskV2Score = chaseRiskV2Component.score === null ? null : 100 - chaseRiskV2Component.score;
  const financialQualityV2Score = strictWeightedScore([
    { score: cashFlowV2Score, weight: 28 },
    { score: growthV2Score, weight: 22 },
    { score: profitabilityV2Score, weight: 25 },
    { score: stabilityV2Score, weight: 25 },
  ]);
  const smallInvestorV2Parts = [
    { score: entryCostScore, weight: 20 },
    { score: liquidityV2Score, weight: 25 },
    { score: volatilityV2Score, weight: 20 },
    { score: positionRiskV2Score, weight: 15 },
    { score: financialQualityV2Score, weight: 20 },
  ];
  const smallInvestorV2 = strictWeightedScore(smallInvestorV2Parts);
  const hasQuoteV2 = Boolean(quote.quoteDate && Number.isFinite(close));
  const hasEpsV2 = Number.isFinite(profit?.eps);
  const hasCashFlowV2 = cashFlowV2Score !== null && weightedAvailability(cashFlowV2Parts) >= 50;
  const criticalMissing = [
    !hasQuoteV2 ? "quote" : "",
    fundamentals.assetType === "stock" && !hasEpsV2 ? "EPS" : "",
    fundamentals.assetType === "stock" && !hasCashFlowV2 ? "cash flow" : "",
  ].filter(Boolean);
  const dataConfidenceScore = Math.max(0, Math.min(100,
    dataCoveragePct
    - criticalMissing.length * 12
    - fundamentals.cache.staleDatasets.length * 5
  ));
  const historicalFairCandidates = [
    {
      value: Number.isFinite(valuation?.per) && (valuation?.per || 0) > 0 && Number.isFinite(selfPerMedian)
        ? round((close / (valuation?.per || 1)) * (selfPerMedian as number))
        : null,
      weight: 40,
    },
    {
      value: Number.isFinite(valuation?.pbr) && (valuation?.pbr || 0) > 0 && Number.isFinite(selfPbrMedian)
        ? round((close / (valuation?.pbr || 1)) * (selfPbrMedian as number))
        : null,
      weight: 35,
    },
    {
      value: Number.isFinite(valuation?.dividendYield) && (valuation?.dividendYield || 0) > 0 && Number.isFinite(selfYieldMedian) && (selfYieldMedian || 0) > 0
        ? round(close * ((valuation?.dividendYield || 0) / (selfYieldMedian as number)))
        : null,
      weight: 25,
    },
  ];
  const historicalFairWeight = historicalFairCandidates
    .filter(item => item.value !== null && Number.isFinite(item.value))
    .reduce((sum, item) => sum + item.weight, 0);
  const historicalFairValue = historicalFairWeight
    ? round(historicalFairCandidates.reduce((sum, item) => sum + (item.value !== null && Number.isFinite(item.value) ? item.value * item.weight : 0), 0) / historicalFairWeight)
    : null;
  const stockFairWeights = isFinancialIndustry
    ? { earnings: 25, book: 40, dividend: 15, history: 20 }
    : isSemiconductorIndustry
      ? { earnings: 45, book: 20, dividend: 10, history: 25 }
      : isCyclicalIndustry
        ? { earnings: 25, book: 40, dividend: 10, history: 25 }
        : isDividendProfile
          ? { earnings: 25, book: 20, dividend: 25, history: 30 }
          : { earnings: 35, book: 25, dividend: 10, history: 30 };
  const stockFairMethodsV2 = [
    {
      name: "industry earnings multiple",
      value: Number.isFinite(profit?.eps) && (profit?.eps || 0) > 0 ? round((profit?.eps || 0) * 4 * industryFairPer) : null,
      weight: stockFairWeights.earnings,
      note: `group ${industryGroup}; fair PER ${fmt(industryFairPer, 1)}`,
    },
    {
      name: "industry book multiple",
      value: Number.isFinite(valuation?.pbr) && (valuation?.pbr || 0) > 0 ? round((close / (valuation?.pbr || 1)) * industryTargetPbr) : null,
      weight: stockFairWeights.book,
      note: `group ${industryGroup}; fair PBR ${fmt(industryTargetPbr, 2)}`,
    },
    {
      name: "sector dividend support",
      value: Number.isFinite(valuation?.dividendYield) && (valuation?.dividendYield || 0) > 0 && cashFlowV2Score !== null && cashFlowV2Score >= 55
        ? round(close * ((valuation?.dividendYield || 0) / industryTargetYield))
        : null,
      weight: stockFairWeights.dividend,
      note: `sector yield reference ${fmt(industryTargetYield, 1)}%; requires cash-flow support`,
    },
    {
      name: "3-5 year self valuation percentile",
      value: historicalFairValue,
      weight: stockFairWeights.history,
      note: `self medians PER ${scoreTextValue(selfPerMedian)}, PBR ${scoreTextValue(selfPbrMedian)}, yield ${scoreTextValue(selfYieldMedian)}; workbench adds same-industry peer percentile when a peer batch is available`,
    },
  ];
  const etfNavReturnStability = buildEtfNavReturnStability(
    quote,
    etf?.distribution?.trailingYieldPct ?? null,
    etf?.nav?.premiumDiscount ?? null,
  );
  const etfDistributionQualityParts = [
    { score: etf?.distribution?.continuityScore ?? null, weight: 30 },
    { score: etf?.distribution?.payoutVolatilityScore ?? null, weight: 25 },
    { score: etf?.distribution?.yieldReasonablenessScore ?? null, weight: 15 },
    { score: etfNavReturnStability.score, weight: 15 },
    { score: etfLiquidityScore, weight: 15 },
  ];
  const etfDistributionQualityScore = strictWeightedScore(etfDistributionQualityParts);
  const etfFairMethodsV2 = [
    {
      name: "NAV fair value",
      value: Number.isFinite(etf?.nav?.value) ? etf!.nav.value : null,
      weight: 50,
      note: "uses official ETF NAV when available",
    },
    {
      name: "holdings quality support",
      value: etfQualityScore !== null && Number.isFinite(etf?.nav?.marketPrice)
        ? round((etf!.nav.marketPrice || close) * (0.75 + etfQualityScore / 200))
        : null,
      weight: 25,
      note: "uses available major-holding quality proxy",
    },
    {
      name: "distribution quality support",
      value: etfDistributionQualityScore !== null && Number.isFinite(etf?.nav?.marketPrice)
        ? round((etf!.nav.marketPrice || close) * (0.65 + etfDistributionQualityScore / 200))
        : null,
      weight: 25,
      note: "uses distribution continuity, payout volatility, yield reasonableness, total-return proxy, and liquidity",
    },
  ];
  const fairMethodsV2 = fundamentals.assetType === "etf" ? etfFairMethodsV2 : stockFairMethodsV2;
  const fairMethodWeight = fairMethodsV2.reduce((sum, item) => sum + item.weight, 0);
  const fairMethodAvailableWeight = fairMethodsV2
    .filter(item => item.value !== null && Number.isFinite(item.value))
    .reduce((sum, item) => sum + item.weight, 0);
  const fairValueV2 = fairMethodAvailableWeight
    ? round(fairMethodsV2.reduce((sum, item) => sum + (item.value !== null && Number.isFinite(item.value) ? item.value * item.weight : 0), 0) / fairMethodAvailableWeight)
    : null;
  const fairValueV2Confidence = fairMethodWeight ? Math.round((fairMethodAvailableWeight / fairMethodWeight) * 100) : 0;
  const upsidePctV2 = fairValueV2 && close > 0 ? round(((fairValueV2 / close) - 1) * 100, 2) : null;
  const upsideScoreV2 = Number.isFinite(upsidePctV2)
    ? Math.max(5, Math.min(95, Math.round(50 + (upsidePctV2 as number))))
    : null;
  const downsideScoreV2 = Number.isFinite(upsidePctV2)
    ? Math.max(5, Math.min(95, Math.round(50 - (upsidePctV2 as number))))
    : null;
  const undervaluedV2Parts = [
    { score: valuationV2Component.score, weight: 25 },
    { score: upsideScoreV2, weight: 20 },
    { score: cashFlowV2Score, weight: 15 },
    { score: stabilityV2Score, weight: 10 },
    { score: profitabilityV2Score, weight: 10 },
    { score: growthV2Score, weight: 10 },
    { score: technicalTrendComponent.score, weight: 5 },
    { score: dataConfidenceScore, weight: 5 },
  ];
  const undervaluedV2 = strictWeightedScore(undervaluedV2Parts);
  const weakProfitCashFlowV2 = strictWeightedScore([
    { score: profitabilityV2Score === null ? null : 100 - profitabilityV2Score, weight: 50 },
    { score: cashFlowV2Score === null ? null : 100 - cashFlowV2Score, weight: 50 },
  ]);
  const overvaluedV2Parts = [
    { score: valuationV2Component.score === null ? null : 100 - valuationV2Component.score, weight: 25 },
    { score: downsideScoreV2, weight: 20 },
    { score: growthV2Score === null ? null : 100 - growthV2Score, weight: 15 },
    { score: weakProfitCashFlowV2, weight: 15 },
    { score: stabilityV2Score === null ? null : 100 - stabilityV2Score, weight: 10 },
    { score: chaseRiskV2Component.score, weight: 10 },
    { score: 100 - dataConfidenceScore, weight: 5 },
  ];
  const overvaluedV2 = strictWeightedScore(overvaluedV2Parts);
  const professionalV2Components = fundamentals.assetType === "etf"
    ? [
        componentForProfessional("premiumNav", "\u6298\u6EA2\u50F9\u8207\u6DE8\u503C", etfPremiumScore, 20, etfProfessionalComponents[0].evidence, etfProfessionalComponents[0].missing, "ETF premium or NAV data is not attractive enough."),
        componentForProfessional("holdingsQuality", "\u6210\u5206\u80A1\u54C1\u8CEA\u8207\u96C6\u4E2D\u5EA6", etfQualityScore, 20, etfProfessionalComponents[1].evidence, etfProfessionalComponents[1].missing, "ETF holdings quality or concentration needs review."),
        componentForProfessional("distributionQuality", "\u914D\u606F\u54C1\u8CEA", etfDistributionQualityScore, 20, [
          ...(etf?.distribution?.evidence || []),
          ...etfNavReturnStability.evidence,
        ].filter(Boolean), [
          ...(etf?.distribution?.missing || []),
          ...etfNavReturnStability.missing,
          etfDistributionQualityScore === null ? "distribution quality inputs" : "",
        ].filter(Boolean), "High yield is not enough without continuity and NAV/total-return support."),
        componentForProfessional("liquidity", "\u898F\u6A21\u8207\u6D41\u52D5\u6027", etfLiquidityScore, 15, etfProfessionalComponents[2].evidence, etfProfessionalComponents[2].missing, "Liquidity data is weak or missing."),
        componentForProfessional("technicalTrend", "\u6280\u8853\u8DA8\u52E2", technicalTrendComponent.score, 15, technicalTrendComponent.evidence, technicalTrendComponent.missing, "Technical trend is weak or incomplete."),
        componentForProfessional("singleRisk", "\u55AE\u4E00\u7522\u696D\u6216\u6210\u5206\u98A8\u96AA", etfSingleRiskScore, 10, etfProfessionalComponents[5].evidence, etfProfessionalComponents[5].missing, "Top holding concentration is high or unavailable."),
      ]
    : [
        componentForProfessional("valuation", "\u4F30\u503C\u4FBF\u5B9C\u5EA6", valuationV2Component.score, 20, valuationV2Component.evidence, valuationV2Component.missing, "\u4F30\u503C\u6216 PEG \u4E0D\u5920\u6709\u5438\u5F15\u529B\u3002"),
        componentForProfessional("cashflow", "\u73FE\u91D1\u6D41", cashFlowV2Score, 15, cashFlowComponent.evidence, cashFlowComponent.missing, "\u73FE\u91D1\u6D41\u5F31\u6216\u7F3A\u95DC\u9375\u6B04\u4F4D\u3002"),
        componentForProfessional("stability", "\u8CA1\u52D9\u7A69\u5065", stabilityV2Score, 15, financialStabilityComponent.evidence, financialStabilityComponent.missing, "\u8CA1\u52D9\u7A69\u5065\u5EA6\u4E0D\u8DB3\u3002"),
        componentForProfessional("growth", "\u6210\u9577\u54C1\u8CEA", growthV2Score, 15, growthComponent.evidence, growthComponent.missing, "\u6210\u9577\u8CC7\u6599\u504F\u5F31\u6216\u4E0D\u5B8C\u6574\u3002"),
        componentForProfessional("profitability", "\u7372\u5229\u80FD\u529B", profitabilityV2Score, 10, profitabilityComponent.evidence, profitabilityComponent.missing, "\u7372\u5229\u80FD\u529B\u4E0D\u8DB3\u6216 EPS \u7F3A\u6F0F\u3002"),
        componentForProfessional("capitalConfidence", "\u7C4C\u78BC\u4FE1\u5FC3", capitalConfidenceComponent.score, 10, capitalConfidenceComponent.evidence, capitalConfidenceComponent.missing, "\u6CD5\u4EBA\u3001\u5916\u8CC7\u6216\u878D\u8CC7\u8A0A\u865F\u4E0D\u7406\u60F3\u3002"),
        componentForProfessional("technicalTrend", "\u6280\u8853\u8DA8\u52E2", technicalTrendComponent.score, 10, technicalTrendComponent.evidence, technicalTrendComponent.missing, "\u8DA8\u52E2\u6216\u9707\u76EA\u6307\u6A19\u4E0D\u652F\u6301\u3002"),
        componentForProfessional("smallBudget", "\u5C0F\u8CC7\u53CB\u5584", smallInvestorV2, 10, [
          Number.isFinite(oneLotCost) ? `one lot cost ${fmt(oneLotCost || NaN, 0)}` : "",
          Number.isFinite(quote.volume) ? `volume ${fmt(quote.volume, 0)}` : "",
          Number.isFinite(latest.atrPct) ? `ATR 14 ${fmt(latest.atrPct, 2)}%` : "",
          Number.isFinite(latest.bandwidth) ? `Bollinger bandwidth ${fmt(latest.bandwidth, 2)}%` : "",
        ].filter(Boolean), [
          entryCostScore === null ? "entry cost" : "",
          liquidityV2Score === null ? "liquidity" : "",
          volatilityV2Score === null ? "ATR volatility" : "",
        ].filter(Boolean), "\u96F6\u80A1\u6210\u672C\u3001\u6D41\u52D5\u6027\u3001\u6CE2\u52D5\u6216\u55AE\u7B46\u90E8\u4F4D\u98A8\u96AA\u4E0D\u5920\u7406\u60F3\u3002"),
      ];
  const professionalV2Total = strictWeightedScore(professionalV2Components.map(item => ({ score: item.score, weight: item.weight })));
  const professionalV2Grade = gradeFromScoreV2(professionalV2Total, dataConfidenceScore);
  const rankingEligibility = {
    undervalued: hasQuoteV2 && valuationV2Component.score !== null && fairValueV2 !== null && fairValueV2Confidence >= 40 && (fundamentals.assetType === "etf" || (hasEpsV2 && hasCashFlowV2)) && dataCoveragePct >= 55,
    overvalued: hasQuoteV2 && valuationV2Component.score !== null && fairValueV2 !== null && fairValueV2Confidence >= 40 && dataCoveragePct >= 55,
    cashflow: hasCashFlowV2,
    growth: growthV2Score !== null && weightedAvailability(growthV2Parts) >= 50,
    smallInvestor: smallInvestorV2 !== null && hasQuoteV2 && dataCoveragePct >= 55,
    chaseRisk: chaseRiskV2Component.score !== null && weightedAvailability(chaseRiskV2Parts) >= 60,
    todayWatch: professionalV2Total !== null && professionalV2Total >= 65 && (chaseRiskV2Component.score || 100) < 72 && dataConfidenceScore >= 70,
    watchlist: ["A", "B", "C"].includes(professionalV2Grade) && dataConfidenceScore >= 55,
  };
  const scoreV2 = {
    modelVersion: fundamentals.assetType === "etf" ? "etf-v2-parallel-2026-07" : "stock-v2-parallel-2026-07",
    status: "parallel_only",
    clientActive: false,
    sourceMethod: "Score v2 uses fixed-weight scoring, data confidence caps, separated capital confidence and technical trend modules, and TradingView-style grouped technical signals.",
    comparison: {
      v1Total: professionalTotal,
      v2Total: professionalV2Total,
      delta: professionalTotal !== null && professionalV2Total !== null ? professionalV2Total - professionalTotal : null,
      v1Grade: professionalGrade,
      v2Grade: professionalV2Grade,
    },
    confidence: {
      score: dataConfidenceScore,
      coveragePercent: dataCoveragePct,
      criticalMissing,
      fairValueMethodCoverage: fairValueV2Confidence,
      caps: [
        "coverage >=85 normal",
        "coverage 70-84 max grade B",
        "coverage 55-69 max grade C",
        "coverage 45-54 max grade D",
        "coverage <45 grade X",
      ],
    },
    fairValue: {
      value: fairValueV2,
      upsidePct: upsidePctV2,
      methodCoverage: fairValueV2Confidence,
      industryGroup,
      methods: fairMethodsV2,
      history: valuation?.history || null,
      note: "Fixed PBR 1.8 and fixed 4% target yield are removed in v2; stock fair value now blends industry-group references with the stock's own 3-5 year valuation medians. Workbench-level same-industry peer percentiles are added when a peer batch has enough comparable stocks.",
    },
    scores: {
      undervalued: undervaluedV2,
      overvalued: overvaluedV2,
      smallInvestor: smallInvestorV2,
      valuation: valuationV2Component,
      cashFlow: { ...cashFlowComponent, score: cashFlowV2Score },
      growth: { ...growthComponent, score: growthV2Score },
      profitability: { ...profitabilityComponent, score: profitabilityV2Score },
      financialStability: { ...financialStabilityComponent, score: stabilityV2Score },
      capitalConfidence: capitalConfidenceComponent,
      technicalTrend: technicalTrendComponent,
      chaseRisk: chaseRiskV2Component,
      smallInvestorDetail: {
        score: smallInvestorV2,
        groups: {
          entryCost: { score: entryCostScore, weight: 20 },
          liquidity: { score: liquidityV2Score, weight: 25 },
          volatility: { score: volatilityV2Score, weight: 20 },
          positionRisk: { score: positionRiskV2Score, weight: 15 },
          financialQuality: { score: financialQualityV2Score, weight: 20 },
        },
      },
      etfDistributionQuality: etfDistributionQualityScore,
    },
    weights: {
      undervalued: { valuation: 25, upside: 20, cashFlow: 15, financialStability: 10, profitability: 10, growth: 10, technicalPosition: 5, dataConfidence: 5 },
      overvalued: { expensiveValuation: 25, downside: 20, weakGrowth: 15, weakProfitCashFlow: 15, financialRisk: 10, chaseRisk: 10, dataConfidenceRisk: 5 },
      smallInvestor: { entryCost: 20, liquidity: 25, volatility: 20, positionRisk: 15, financialQuality: 20 },
      chaseRisk: { trend: 25, oscillator: 30, volume: 20, extension: 25 },
      etfDistributionQuality: { continuity: 30, payoutVolatility: 25, yieldReasonableness: 15, navTotalReturnStability: 15, scaleLiquidity: 15 },
    },
    rankingEligibility,
    professionalRating: {
      total: professionalV2Total,
      grade: professionalV2Grade,
      gradeLabel: gradeLabel(professionalV2Grade),
      components: professionalV2Components,
      note: "Score v2 is visible for internal comparison only and does not replace customer-facing v1 scores yet.",
    },
    pendingCalibration: [
      "same-industry valuation percentile store",
      "official ETF NAV total-return history beyond the current market-price proxy",
      "review /api/workbench scoreV2Summary.chaseRiskCalibration before cutting suggested weights into live scoring",
    ],
  };

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
    scoreV2,
    warnings,
    fundamentals,
  };
}

async function loadValueScore(code: string, options: { fast?: boolean } = {}) {
  const [quote, fundamentals] = await Promise.all([
    loadQuote(code),
    loadFundamentals(code, options),
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

async function loadScreener(mode: string, universeValue: unknown, options: { fast?: boolean } = {}) {
  const universe = parseScreenerUniverse(universeValue);
  const isDefaultUniverse = !universeValue && universe.length === DEFAULT_SCREENER_UNIVERSE.length;
  const scoreLimit = isDefaultUniverse ? Math.max(1, universe.length) : 4;
  const [marketUniverseResult, results] = await Promise.all([
    withTimeout(loadTaiwanCompanyUniverse(), 12000, "Taiwan company universe timed out").catch(err => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    })),
    settleWithLimit(universe, scoreLimit, code => loadValueScore(code, options)),
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

function valuationMetric(item: ValueScore, key: "per" | "pbr" | "dividendYield") {
  const value = item.fundamentals?.data?.valuation?.[key];
  return Number.isFinite(value) && (value as number) > 0 ? value as number : null;
}

function fairValueFromPeerMedians(item: ValueScore, medians: { per: number | null; pbr: number | null; dividendYield: number | null }) {
  const close = item.close;
  const per = valuationMetric(item, "per");
  const pbr = valuationMetric(item, "pbr");
  const dividendYield = valuationMetric(item, "dividendYield");
  const candidates = [
    { value: per !== null && medians.per !== null ? round((close / per) * medians.per) : null, weight: 40 },
    { value: pbr !== null && medians.pbr !== null ? round((close / pbr) * medians.pbr) : null, weight: 35 },
    { value: dividendYield !== null && medians.dividendYield !== null ? round(close * (dividendYield / medians.dividendYield)) : null, weight: 25 },
  ];
  const availableWeight = candidates
    .filter(item => item.value !== null && Number.isFinite(item.value))
    .reduce((sum, item) => sum + item.weight, 0);
  return availableWeight
    ? round(candidates.reduce((sum, item) => sum + (item.value !== null && Number.isFinite(item.value) ? item.value * item.weight : 0), 0) / availableWeight)
    : null;
}

function applyPeerValuationPercentiles(items: ValueScore[]) {
  const groups = new Map<string, ValueScore[]>();
  items.forEach(item => {
    const group = item.scoreV2?.fairValue?.industryGroup || TAIWAN_SCREENING_UNIVERSE.find(entry => entry.code === item.code)?.group || "unclassified";
    if (item.professionalRating.assetModel !== "stock" || group === "unclassified") return;
    groups.set(group, [...(groups.get(group) || []), item]);
  });
  const summary: Array<{ group: string; peerCount: number; appliedCount: number }> = [];
  groups.forEach((groupItems, group) => {
    if (groupItems.length < 2) return;
    const perValues = groupItems.map(item => valuationMetric(item, "per")).filter((value): value is number => value !== null);
    const pbrValues = groupItems.map(item => valuationMetric(item, "pbr")).filter((value): value is number => value !== null);
    const dividendYieldValues = groupItems.map(item => valuationMetric(item, "dividendYield")).filter((value): value is number => value !== null);
    const medians = {
      per: median(perValues),
      pbr: median(pbrValues),
      dividendYield: median(dividendYieldValues),
    };
    let appliedCount = 0;
    groupItems.forEach(item => {
      const perPercentile = percentileRank(perValues, valuationMetric(item, "per"));
      const pbrPercentile = percentileRank(pbrValues, valuationMetric(item, "pbr"));
      const dividendYieldPercentile = percentileRank(dividendYieldValues, valuationMetric(item, "dividendYield"));
      const peerScore = strictWeightedScore([
        { score: perPercentile === null ? null : 100 - perPercentile, weight: 40 },
        { score: pbrPercentile === null ? null : 100 - pbrPercentile, weight: 35 },
        { score: dividendYieldPercentile, weight: 25 },
      ]);
      if (peerScore === null) return;
      appliedCount += 1;
      const peerFairValue = fairValueFromPeerMedians(item, medians);
      item.scoreV2.fairValue.peer = {
        group,
        peerCount: groupItems.length,
        perPercentile,
        pbrPercentile,
        dividendYieldPercentile,
        medians,
        cheapnessScore: peerScore,
        fairValue: peerFairValue,
        note: "same-industry percentile is calculated inside the current controlled workbench batch; it does not compare across unrelated industries.",
      };
      item.scoreV2.scores.peerValuation = {
        score: peerScore,
        label: scoreLabel(peerScore, "same-industry valuation cheap", "same-industry valuation neutral", "same-industry valuation expensive"),
        weight: 30,
        evidence: [
          `peer group ${group}`,
          `peer count ${groupItems.length}`,
          Number.isFinite(perPercentile) ? `PER peer percentile ${fmt(perPercentile as number, 1)}` : "",
          Number.isFinite(pbrPercentile) ? `PBR peer percentile ${fmt(pbrPercentile as number, 1)}` : "",
          Number.isFinite(dividendYieldPercentile) ? `yield peer percentile ${fmt(dividendYieldPercentile as number, 1)}` : "",
        ].filter(Boolean),
        missing: [],
      };
      const valuationComponent = item.scoreV2.scores.valuation;
      if (valuationComponent) {
        const blendedValuation = strictWeightedScore([
          { score: valuationComponent.score, weight: 70 },
          { score: peerScore, weight: 30 },
        ]);
        valuationComponent.groups = {
          ...(valuationComponent.groups || {}),
          sameIndustryPeer: {
            score: peerScore,
            weight: 30,
            evidence: item.scoreV2.scores.peerValuation.evidence,
            missing: [],
          },
        };
        valuationComponent.score = blendedValuation;
        valuationComponent.evidence = [...(valuationComponent.evidence || []), `same-industry peer valuation ${scoreTextValue(peerScore)}`];
        item.scoreV2.scores.undervalued = strictWeightedScore([
          { score: item.scoreV2.scores.undervalued, weight: 75 },
          { score: peerScore, weight: 25 },
        ]);
        item.scoreV2.scores.overvalued = strictWeightedScore([
          { score: item.scoreV2.scores.overvalued, weight: 75 },
          { score: 100 - peerScore, weight: 25 },
        ]);
        const valuationProfessional = item.scoreV2.professionalRating?.components?.find((component: any) => component.key === "valuation");
        if (valuationProfessional) {
          valuationProfessional.score = blendedValuation;
          valuationProfessional.evidence = [...(valuationProfessional.evidence || []), `same-industry peer valuation ${scoreTextValue(peerScore)}`];
        }
        const total = strictWeightedScore((item.scoreV2.professionalRating?.components || []).map((component: any) => ({ score: component.score, weight: component.weight })));
        item.scoreV2.professionalRating.total = total;
        item.scoreV2.professionalRating.grade = gradeFromScoreV2(total, item.scoreV2.confidence?.score ?? 0);
        item.scoreV2.professionalRating.gradeLabel = gradeLabel(item.scoreV2.professionalRating.grade);
        item.scoreV2.comparison.v2Total = total;
        item.scoreV2.comparison.v2Grade = item.scoreV2.professionalRating.grade;
        item.scoreV2.comparison.delta = item.professionalRating.total !== null && total !== null ? total - item.professionalRating.total : null;
      }
    });
    if (appliedCount) summary.push({ group, peerCount: groupItems.length, appliedCount });
  });
  return summary;
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

function maxFutureDrawdownPct(series: DailyBar[], index: number, horizon: number) {
  const entry = series[index]?.close;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const future = series.slice(index + 1, index + 1 + horizon);
  if (!future.length) return null;
  const minLow = Math.min(...future.map(row => Number.isFinite(row.low) ? row.low : row.close));
  return round(Math.max(0, (1 - minLow / entry) * 100), 2);
}

function liftWeight(lift: number | null, sampleSize: number, totalSamples: number) {
  if (lift === null || !Number.isFinite(lift) || sampleSize < 8 || !totalSamples) return 0;
  const sampleConfidence = Math.min(1, sampleSize / Math.max(20, totalSamples * 0.35));
  return Math.max(0, lift - 1) * sampleConfidence;
}

function normalizeCalibrationWeights(raw: Record<string, number>, fallback: Record<string, number>) {
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (!total) return fallback;
  const entries = Object.entries(raw).map(([key, value]) => [key, Math.round((value / total) * 100)] as const);
  const drift = 100 - entries.reduce((sum, [, value]) => sum + value, 0);
  if (entries.length) entries[0] = [entries[0][0], entries[0][1] + drift];
  return Object.fromEntries(entries);
}

function calibrateChaseRiskFromHistory(quote: QuoteInfo) {
  const series = quote.series || [];
  if (series.length < 140) {
    return {
      ok: false,
      code: quote.code,
      message: "Not enough price history for chase-risk calibration.",
    };
  }
  const closes = series.map(row => row.close);
  const lows = series.map(row => row.low);
  const volumes = series.map(row => row.volume || 0);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ma120 = sma(closes, 120);
  const rsi14 = rsi(closes, 14);
  const bb = boll(closes);
  const horizons = [
    { days: 5, threshold: 5 },
    { days: 10, threshold: 8 },
    { days: 20, threshold: 10 },
  ];
  const signalDefs = [
    {
      key: "trend",
      label: "trend extension",
      test: (i: number) => Number.isFinite(ma20[i]) && Number.isFinite(ma60[i]) && Number.isFinite(ma120[i])
        && closes[i] > ma20[i] && ma20[i] > ma60[i] && ma60[i] > ma120[i],
    },
    {
      key: "oscillator",
      label: "RSI/Stochastic overheating proxy",
      test: (i: number) => Number.isFinite(rsi14[i]) && rsi14[i] >= 70,
    },
    {
      key: "volume",
      label: "volume expansion",
      test: (i: number) => {
        if (i < 20) return false;
        const avgVol = volumes.slice(i - 19, i + 1).reduce((sum, value) => sum + value, 0) / 20;
        return avgVol > 0 && volumes[i] / avgVol >= 1.8;
      },
    },
    {
      key: "extension",
      label: "Bollinger/support extension",
      test: (i: number) => {
        const support20 = Math.min(...lows.slice(Math.max(0, i - 19), i + 1));
        const supportDistance = support20 > 0 ? ((closes[i] / support20) - 1) * 100 : null;
        return (Number.isFinite(bb.pctB[i]) && bb.pctB[i] >= 0.9)
          || (supportDistance !== null && supportDistance >= 12);
      },
    },
  ];
  const start = series.length >= 220 ? 120 : 60;
  const end = series.length - Math.max(...horizons.map(item => item.days)) - 1;
  const totalSamples = Math.max(0, end - start + 1);
  if (totalSamples < 30) {
    return {
      ok: false,
      code: quote.code,
      message: "Not enough forward windows for chase-risk calibration.",
    };
  }
  const baseRates = horizons.map(horizon => {
    let events = 0;
    for (let i = start; i <= end; i += 1) {
      const drawdown = maxFutureDrawdownPct(series, i, horizon.days);
      if (drawdown !== null && drawdown >= horizon.threshold) events += 1;
    }
    return {
      days: horizon.days,
      threshold: horizon.threshold,
      samples: totalSamples,
      eventRate: round((events / totalSamples) * 100, 1),
    };
  });
  const signals = signalDefs.map(signal => {
    const matched: number[] = [];
    for (let i = start; i <= end; i += 1) {
      if (signal.test(i)) matched.push(i);
    }
    const outcomes = horizons.map((horizon, horizonIndex) => {
      const events = matched.filter(index => {
        const drawdown = maxFutureDrawdownPct(series, index, horizon.days);
        return drawdown !== null && drawdown >= horizon.threshold;
      }).length;
      const eventRate = matched.length ? round((events / matched.length) * 100, 1) : null;
      const baseRate = baseRates[horizonIndex].eventRate;
      const lift = eventRate !== null && baseRate > 0 ? round(eventRate / baseRate, 2) : null;
      return {
        days: horizon.days,
        threshold: horizon.threshold,
        events,
        eventRate,
        lift,
      };
    });
    const averageLift = outcomes.some(item => item.lift !== null)
      ? round(outcomes.reduce((sum, item) => sum + (item.lift || 0), 0) / outcomes.filter(item => item.lift !== null).length, 2)
      : null;
    return {
      key: signal.key,
      label: signal.label,
      sampleSize: matched.length,
      sampleRate: round((matched.length / totalSamples) * 100, 1),
      averageLift,
      outcomes,
    };
  });
  const rawWeights = Object.fromEntries(signals.map(signal => [
    signal.key,
    liftWeight(signal.averageLift, signal.sampleSize, totalSamples),
  ]));
  return {
    ok: true,
    code: quote.code,
    name: quote.name,
    source: quote.source,
    sourceUrl: quote.sourceUrls.yahoo || null,
    rule: "For each historical bar, test whether RSI, trend, volume, or Bollinger/support extension preceded a 5/8/10% max drawdown within 5/10/20 trading days.",
    period: {
      start: series[start]?.date || null,
      end: series[end]?.date || null,
      bars: series.length,
      samples: totalSamples,
      lookbackYears: round(series.length / 252, 1),
    },
    baseRates,
    signals,
    recommendedWeights: normalizeCalibrationWeights(rawWeights, { trend: 25, oscillator: 30, volume: 20, extension: 25 }),
    currentWeights: { trend: 25, oscillator: 30, volume: 20, extension: 25 },
    status: "parallel_observation_only",
  };
}

let workbenchCache: { data: any; fetchedAt: number } | null = null;

async function loadWorkbench() {
  const screener = await loadScreener("undervalued", undefined, { fast: true });
  const items = screener.items;
  const peerValuationSummary = applyPeerValuationPercentiles(items);
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
  const rankedV2 = {
    observationPool: topItems(items, item => item.scoreV2?.professionalRating?.total !== null, item => item.scoreV2?.professionalRating?.total, 16),
    todayWatch: topItems(items, item => Boolean(item.scoreV2?.rankingEligibility?.todayWatch), item => item.scoreV2?.professionalRating?.total),
    watchlist: topItems(items, item => Boolean(item.scoreV2?.rankingEligibility?.watchlist), item => item.scoreV2?.scores?.smallInvestor),
    chaseRisk: topItems(items, item => Boolean(item.scoreV2?.rankingEligibility?.chaseRisk) && (item.scoreV2?.scores?.chaseRisk?.score || 0) >= 72, item => item.scoreV2?.scores?.chaseRisk?.score),
    undervalued: topItems(items, item => Boolean(item.scoreV2?.rankingEligibility?.undervalued), item => item.scoreV2?.scores?.undervalued),
    overvalued: topItems(items, item => Boolean(item.scoreV2?.rankingEligibility?.overvalued), item => item.scoreV2?.scores?.overvalued),
    cashflow: topItems(items, item => Boolean(item.scoreV2?.rankingEligibility?.cashflow), item => item.scoreV2?.scores?.cashFlow?.score),
    growth: topItems(items, item => Boolean(item.scoreV2?.rankingEligibility?.growth), item => item.scoreV2?.scores?.growth?.score),
    smallInvestor: topItems(items, item => Boolean(item.scoreV2?.rankingEligibility?.smallInvestor), item => item.scoreV2?.scores?.smallInvestor),
    etf: topItems(items, item => item.professionalRating.assetModel === "etf" && item.scoreV2?.professionalRating?.total !== null, item => item.scoreV2?.professionalRating?.total),
  };
  const scoreV2Comparisons = items.map(item => ({
    code: item.code,
    name: item.name,
    assetModel: item.professionalRating.assetModel,
    v1Total: item.professionalRating.total,
    v1Grade: item.professionalRating.grade,
    v2Total: item.scoreV2?.professionalRating?.total ?? null,
    v2Grade: item.scoreV2?.professionalRating?.grade ?? "X",
    delta: item.scoreV2?.comparison?.delta ?? null,
    confidence: item.scoreV2?.confidence?.score ?? null,
    criticalMissing: item.scoreV2?.confidence?.criticalMissing || [],
    eligible: item.scoreV2?.rankingEligibility || {},
  })).sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const rankingChangeModes = ["todayWatch", "watchlist", "chaseRisk", "undervalued", "overvalued", "cashflow", "growth", "smallInvestor", "etf"] as const;
  const itemNames = new Map(items.map(item => [item.code, item.name]));
  const rankingChanges = rankingChangeModes.map(mode => {
    const v1List = ranked[mode] || [];
    const v2List = rankedV2[mode] || [];
    const v1Ranks = new Map(v1List.map((item, index) => [item.code, index + 1]));
    const v2Ranks = new Map(v2List.map((item, index) => [item.code, index + 1]));
    const codes = [...new Set([...v1List.map(item => item.code), ...v2List.map(item => item.code)])];
    return {
      mode,
      v1Top: v1List.slice(0, 5).map(item => item.code),
      v2Top: v2List.slice(0, 5).map(item => item.code),
      changes: codes.map(code => {
        const v1Rank = v1Ranks.get(code) || null;
        const v2Rank = v2Ranks.get(code) || null;
        const rankDelta = v1Rank !== null && v2Rank !== null ? v1Rank - v2Rank : null;
        return {
          code,
          name: itemNames.get(code) || code,
          v1Rank,
          v2Rank,
          rankDelta,
          status: v1Rank === null ? "new" : v2Rank === null ? "dropped" : rankDelta === 0 ? "unchanged" : "changed",
        };
      }).sort((a, b) => {
        const aMoved = Math.abs(a.rankDelta ?? 99);
        const bMoved = Math.abs(b.rankDelta ?? 99);
        return bMoved - aMoved;
      }).slice(0, 8),
    };
  });
  const backtestCodes = ["0050", "2330", "2317", "2454"];
  const backtestQuotes = await settleWithLimit(backtestCodes, 4, async code => withTimeout(loadQuote(code), 12000, `quote timed out for ${code}`));
  const calibrationQuotes = await settleWithLimit(backtestCodes, 2, async code => withTimeout(loadHistoricalQuoteForCalibration(code), 22000, `5y calibration quote timed out for ${code}`));
  const backtests = backtestQuotes.map((result, index) => result.status === "fulfilled" ? runTechnicalBacktest(result.value) : {
    ok: false,
    code: backtestCodes[index],
    trades: 0,
    message: result.reason instanceof Error ? result.reason.message : String(result.reason),
  });
  const calibrationResults = calibrationQuotes.map((result, index) => result.status === "fulfilled" ? calibrateChaseRiskFromHistory(result.value) : {
    ok: false,
    code: backtestCodes[index],
    message: result.reason instanceof Error ? result.reason.message : String(result.reason),
  });
  const payload = {
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
    rankedV2,
    scoreV2Summary: {
      modelVersion: "score-v2-parallel-2026-07",
      clientActive: false,
      status: "parallel_only",
      comparedCount: scoreV2Comparisons.length,
      eligibleCounts: {
        undervalued: items.filter(item => item.scoreV2?.rankingEligibility?.undervalued).length,
        overvalued: items.filter(item => item.scoreV2?.rankingEligibility?.overvalued).length,
        cashflow: items.filter(item => item.scoreV2?.rankingEligibility?.cashflow).length,
        growth: items.filter(item => item.scoreV2?.rankingEligibility?.growth).length,
        smallInvestor: items.filter(item => item.scoreV2?.rankingEligibility?.smallInvestor).length,
        chaseRisk: items.filter(item => item.scoreV2?.rankingEligibility?.chaseRisk).length,
      },
      averageConfidence: items.length
        ? Math.round(items.reduce((sum, item) => sum + (item.scoreV2?.confidence?.score || 0), 0) / items.length)
        : null,
      peerValuation: {
        status: peerValuationSummary.length ? "applied" : "insufficient_peers",
        groups: peerValuationSummary,
        note: "Same-industry peer percentiles are calculated only within the controlled workbench batch and are used to adjust v2 valuation, undervalued, overvalued, and professional totals before ranking.",
      },
      chaseRiskCalibration: {
        status: calibrationResults.some((item: any) => item.ok) ? "parallel_observation_only" : "insufficient_history",
        results: calibrationResults,
        note: "Historical pullback calibration is visible in the admin/workbench layer only; live customer-facing v1 and v2 chase-risk weights are not cut over from these suggested weights yet.",
      },
      largestDeltas: scoreV2Comparisons.slice(0, 10),
      rankingChanges,
      note: "Score v2 rankings are returned for internal comparison only; v1 remains the customer-facing ranking until an explicit cutover.",
    },
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
      results: backtests,
    },
  };
  workbenchCache = { data: payload, fetchedAt: Date.now() };
  return payload;
}

async function fetchYahooChart(code: string, range: YahooChartRange = "1y") {
  const suffixes = code.includes(".") ? [""] : [".TW", ".TWO"];
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  const errors: string[] = [];

  for (const suffix of suffixes) {
    for (const host of hosts) {
      const symbol = `${code}${suffix}`;
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false&events=history`;
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

async function loadHistoricalQuoteForCalibration(code: string): Promise<QuoteInfo> {
  const chart = await fetchYahooChart(code, "5y");
  const series = chart.bars;
  const week52Slice = series.slice(-252);
  const week52High = week52Slice.length ? Math.max(...week52Slice.map(row => row.high)) : chart.week52High;
  const week52Low = week52Slice.length ? Math.min(...week52Slice.map(row => row.low)) : chart.week52Low;
  const analysis = buildAnalysis(series, Number.isFinite(week52High) ? week52High : chart.week52High, Number.isFinite(week52Low) ? week52Low : chart.week52Low);
  const last = series[series.length - 1];
  const previous = series[series.length - 2];
  return {
    code,
    symbol: chart.symbol,
    name: chart.name,
    market: chart.market,
    currency: chart.currency,
    close: last.close,
    quoteDate: last.date,
    open: last.open,
    high: last.high,
    low: last.low,
    change: previous && Number.isFinite(previous.close) ? round(last.close - previous.close) : null,
    volume: last.volume,
    source: "Yahoo Finance 5y daily OHLCV for admin calibration",
    sourceUrls: {
      yahoo: chart.sourceUrl,
      twseMis: null,
      exchange: null,
    },
    series,
    analysis,
  };
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
const NEWS_CACHE_TTL_MS = 3 * 60 * 1000;
const NEWS_STALE_TTL_MS = 60 * 60 * 1000;

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

async function loadNews(code: string, name = FALLBACK_NAMES[code] || code, options: { force?: boolean } = {}) {
  const cacheKey = `${code}:${name}`;
  const now = Date.now();
  const cached = newsCache.get(cacheKey);
  if (!options.force && cached && now - cached.fetchedAt < NEWS_CACHE_TTL_MS) {
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

function atr(highs: number[], lows: number[], closes: number[], n = 14) {
  const trueRanges = highs.map((high, i) => {
    if (i === 0) return high - lows[i];
    return Math.max(
      high - lows[i],
      Math.abs(high - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  });
  return trueRanges.map((_, i) => {
    if (i + 1 < n) return NaN;
    return round(trueRanges.slice(i + 1 - n, i + 1).reduce((sum, value) => sum + value, 0) / n);
  });
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
  const atr14 = atr(highs, lows, closes, 14);
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
  const atrNow = lastFinite(atr14);
  const atrPctNow = Number.isFinite(atrNow) && close > 0 ? round((atrNow / close) * 100, 2) : NaN;
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
    atr14,
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
      atr14: atrNow,
      atrPct: atrPctNow,
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
    const force = String(query.force || "") === "1" || String(query.refresh || "").toLowerCase() === "true";
    if (!code) return error("Missing stock code", 400);
    return json(await loadNews(code, name, { force }));
  }],

  "GET /api/fundamentals": [async ({ query }: any) => {
    const code = cleanCode(query.code);
    if (!code || !/^\d{4,6}$/.test(code)) return error("Missing or invalid stock code", 400);
    try {
      const payload = await loadFundamentals(code);
      return json(payload.ok ? payload : { ...payload, ok: true, partial: true, upstreamOk: false }, 200);
    } catch (err) {
      return json({
        ok: true,
        partial: true,
        upstreamOk: false,
        code,
        message: finMindPublicMessage(err),
        generatedAt: new Date().toISOString(),
      }, 200);
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
      return json(await withTimeout(loadWorkbench(), 65000, "workbench timed out"), 200);
    } catch (err) {
      if (workbenchCache) {
        return json({
          ...workbenchCache.data,
          ok: true,
          partial: true,
          cache: {
            status: "stale",
            fetchedAt: new Date(workbenchCache.fetchedAt).toISOString(),
            ageSeconds: Math.round((Date.now() - workbenchCache.fetchedAt) / 1000),
          },
          warning: `Workbench is serving the latest cached snapshot because refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        }, 200);
      }
      return json({
        ok: false,
        message: `Unable to build workbench: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],
});
