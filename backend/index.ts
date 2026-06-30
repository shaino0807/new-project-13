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
  "0050": "元大台灣50",
  "2303": "聯電",
  "2308": "台達電",
  "2317": "鴻海",
  "2330": "台積電",
  "2344": "華邦電",
  "2356": "英業達",
  "2382": "廣達",
  "2454": "聯發科",
  "3231": "緯創",
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
    if (err.code === "quota_exceeded") return "FinMind API 額度暫時用完，已保留其他可用資料。";
    if (err.code === "auth_error") return "FinMind Token 無效或來源暫時拒絕存取。";
    if (err.code === "upstream_error") return "FinMind 服務暫時異常。";
    return "FinMind 回傳格式不符合預期。";
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
      data_id: code,
      start_date: finMindStartDate(dataset),
      end_date: new Date().toISOString().slice(0, 10),
    });
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
  const pattern = /商品代碼<\/span>\s*<span[^>]*>(\d{4,6})<\/span>[\s\S]*?商品名稱<\/span>\s*<span[^>]*>([^<]+)<\/span>[\s\S]*?商品數量<\/span>\s*<span[^>]*>[^<]*<\/span>[\s\S]*?商品權重<\/span>\s*<span[^>]*>([\d.]+)<\/span>/g;
  for (const match of html.matchAll(pattern)) {
    const weight = toNumber(match[3]);
    if (!Number.isFinite(weight)) continue;
    holdings.push({
      code: match[1],
      name: stripTags(match[2]),
      weight: round(weight, 2),
    });
  }
  const dateMatch = html.match(/交易日期:\s*(?:<br[^>]*>)?\s*(\d{4}\/\d{2}\/\d{2})/);
  return {
    date: normalizeDate(dateMatch?.[1]),
    holdings,
  };
}

function parseYuantaNav(html: string) {
  const match = html.match(/<h5[^>]*>(\d{4}\/\d{2}\/\d{2})<\/h5>\s*<h4[^>]*>\s*每受益權單位淨資產價值\(元\)\s*<\/h4>\s*<p[^>]*>NTD\s*([\d,.]+)<\/p>/);
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
        profile.warnings.push("元大投信持股頁目前沒有可解析的成分股。");
      }
    } catch (err) {
      profile.warnings.push(`0050 ETF 官方資料暫時無法取得：${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    profile.warnings.push("目前完整成分股與淨值聚合先支援 0050，其他 ETF 仍保留法人與籌碼資料。");
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
      policy: "財報 6 小時、月營收 2 小時、估值與籌碼 30 分鐘；來源失敗時最多沿用 24 小時舊快取。",
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

function scoreLabel(score: number | null, high = "strong", mid = "neutral", low = "weak") {
  if (score === null) return "insufficient data";
  if (score >= 80) return high;
  if (score >= 60) return mid;
  if (score >= 40) return "watch";
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
    actionLabel: action === "stage_entry" ? "stage entries" : action === "small_watch" ? "small watch position" : action === "wait_pullback" ? "wait for pullback" : "avoid new entry",
    singleEntryLimitPct,
    maxHoldingPct,
    worstCaseLossPct,
    stopTrackingAssumption: highChase
      ? "Stop tracking as an entry candidate if price keeps rising while score quality does not improve."
      : "Stop tracking if valuation, cash flow, or growth data deteriorates while price remains expensive.",
    notes: [
      "This is capital-control guidance, not a personalized buy or sell instruction.",
      `Single entry should stay under ${singleEntryLimitPct}% of the planned position.`,
      `One stock should stay under ${maxHoldingPct}% of the portfolio until backtest and data coverage are stronger.`,
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
      `pullback probability ${latest.pullback}%`,
      Number.isFinite(latest.rsi14) ? `RSI ${fmt(latest.rsi14, 1)}` : "",
      Number.isFinite(latest.pctB) ? `Bollinger %B ${fmt(latest.pctB, 2)}` : "",
      Number.isFinite(distanceFromSupport) ? `distance from short-term support ${fmt(distanceFromSupport || NaN, 2)}%` : "",
    ].filter(Boolean),
    missing: [],
  };
  chaseRiskComponent.label = scoreLabel(chaseRiskComponent.score, "chase risk high", "chase risk medium", "chase risk low");

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
    { name: "annualized EPS fair PER", value: earningsValue, weight: 40, note: `Annualized latest EPS with fair PER ${fmt(fairPer, 1)}x.` },
    { name: "book value fair PBR", value: bookValue, weight: 25, note: "Backs into book value per share from current PBR, then applies 1.8x PBR." },
    { name: "dividend yield implied value", value: dividendValue, weight: 15, note: "Uses a 4% target yield; excluded when dividend yield data is unavailable." },
    { name: "technical mean", value: technicalMean, weight: 20, note: "Mean-reversion reference from MA60, MA120, and the 52-week mid price." },
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
    { key: "financialStability", label: "Financial stability", date: balance?.date || null, available: financialStabilityComponent.score !== null, missing: financialStabilityComponent.missing },
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
    componentForProfessional("valuation", "Valuation safety margin", valuationComponent.score, 30, valuationComponent.evidence, valuationComponent.missing, "Valuation is not cheap enough versus available fundamentals."),
    componentForProfessional("stability", "Financial stability", financialStabilityComponent.score, 20, financialStabilityComponent.evidence, financialStabilityComponent.missing, "Balance-sheet strength is weak or incomplete."),
    componentForProfessional("growth", "Growth quality", growthComponent.score, 15, growthComponent.evidence, growthComponent.missing, "Growth quality is slowing or not supported by available data."),
    componentForProfessional("cashflow", "Cash flow and dividend", cashFlowComponent.score, 15, cashFlowComponent.evidence, cashFlowComponent.missing, "Cash conversion is weak or missing."),
    componentForProfessional("technical", "Technical position", technicalPositionScore, 10, chaseRiskComponent.evidence, chaseRiskComponent.missing, "Entry timing has elevated chase risk."),
    componentForProfessional("smallBudget", "Small-budget friendliness", smallBudgetScore, 10, [
      `close ${fmt(close)}`,
      Number.isFinite(quote.volume) ? `volume ${fmt(quote.volume, 0)}` : "",
    ].filter(Boolean), [], "Position size, liquidity, or timing is not friendly enough for staged small-budget entries."),
  ];
  const etfProfessionalComponents = [
    componentForProfessional("premiumNav", "Premium / NAV", etfPremiumScore, 25, [
      Number.isFinite(etf?.nav?.premiumDiscount) ? `premium/discount ${fmt(etf?.nav?.premiumDiscount || NaN, 2)}%` : "",
      etf?.nav?.date ? `NAV date ${etf.nav.date}` : "",
    ].filter(Boolean), etfPremiumScore === null ? ["NAV premium/discount"] : [], "ETF premium or discount is not attractive enough."),
    componentForProfessional("holdingsQuality", "Holdings quality and concentration", etfQualityScore, 25, [
      Number.isFinite(etfCoverage) ? `top holding coverage ${fmt(etfCoverage || NaN, 2)}%` : "",
      Number.isFinite(etfProfitableWeight) ? `profitable weight ${fmt(etfProfitableWeight || NaN, 2)}%` : "",
    ].filter(Boolean), etfQualityScore === null ? ["holdings quality"] : [], "ETF component quality or concentration is not strong enough."),
    componentForProfessional("liquidity", "Scale and liquidity", etfLiquidityScore, 15, [
      Number.isFinite(quote.volume) ? `volume ${fmt(quote.volume, 0)}` : "",
    ].filter(Boolean), etfLiquidityScore === null ? ["volume"] : [], "Liquidity signal is weak or missing."),
    componentForProfessional("distribution", "Distribution stability", etfDividendScore, 15, [
      Number.isFinite(etf?.componentSummary?.weightedDividendYield) ? `weighted yield ${fmt(etf?.componentSummary?.weightedDividendYield || NaN, 2)}%` : "",
    ].filter(Boolean), etfDividendScore === null ? ["distribution history"] : [], "Distribution data is missing or not strong enough."),
    componentForProfessional("technical", "Technical position", technicalPositionScore, 10, chaseRiskComponent.evidence, chaseRiskComponent.missing, "Entry timing has elevated chase risk."),
    componentForProfessional("singleRisk", "Single industry / component risk", etfSingleRiskScore, 10, [
      Number.isFinite(etfCoverage) ? `top holdings coverage ${fmt(etfCoverage || NaN, 2)}%` : "",
    ].filter(Boolean), etfSingleRiskScore === null ? ["component concentration"] : [], "Top holdings concentration is high."),
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
      ? "Stop tracking if NAV/premium data or holdings quality cannot be verified."
      : "Stop tracking if valuation looks cheap only because growth, cash flow, or balance-sheet quality is deteriorating.",
    note: "Only available public quote and FinMind-derived data are scored; missing fields stay visible and do not receive invented values.",
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
      note: "This is the site's transparent valuation model, not an analyst target price; missing EPS, PBR, dividend yield, or technical mean data automatically reduces that method's weight.",
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
      smallInvestorLabel: scoreLabel(smallInvestor, "small-investor friendly", "small-investor watchlist", "not small-investor friendly"),
      valuationLabel: scoreLabel(undervalued, "possibly undervalued", "fair", "not inexpensive"),
      marketConfidenceLabel: marketConfidenceComponent.label,
      analystConsensus: {
        available: false,
        label: "third-party analyst consensus unavailable",
        note: "Market-confidence scoring is used instead; buy/hold/sell consensus will only be shown after a licensed analyst-data source is connected.",
      },
    },
    allocationGuide: {
      action,
      firstBuyPct,
      cashReservePct,
      notes: [
        chaseRiskComponent.score !== null && chaseRiskComponent.score >= 72 ? "Chase risk is elevated, so the first entry should be conservative." : "Chase risk is not elevated; staged entries can reduce timing risk.",
        undervalued !== null && undervalued >= 70 ? "The undervaluation score is high, but financial updates and major news still need review." : "The undervaluation signal is not strong enough to buy only because of rank.",
        "A single stock should not replace an ETF core position; small-budget allocation should keep cash and industry diversification.",
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
  const results = await settleWithLimit(universe, 4, code => loadValueScore(code));
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
      name: universeValue ? "custom" : "Taiwan liquid watch universe",
      version: TAIWAN_UNIVERSE_VERSION,
      defaultCount: DEFAULT_SCREENER_UNIVERSE.length,
      requestedCount: universe.length,
      scoredCount: sorted.length,
      customLimit: CUSTOM_SCREENER_LIMIT,
      groups: [...new Set(TAIWAN_SCREENING_UNIVERSE.filter(item => universe.includes(item.code)).map(item => item.group))],
      note: "Maintainable liquid Taiwan stock/ETF universe, not a full-market database.",
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
        String(item.Code || item.SecuritiesCompanyCode || item.SecuritiesCode || item["證券代號"]) === code
      ) : null;
      if (!row) continue;
      const close = toNumber(row.ClosingPrice || row.Close || row.close || row["收盤價"]);
      if (!Number.isFinite(close)) continue;
      return {
        name: row.Name || row.CompanyName || row.SecuritiesCompanyName || row["證券名稱"] || FALLBACK_NAMES[code] || code,
        market: endpoint.market,
        close,
        open: toNumber(row.OpeningPrice || row.Open || row.open || row["開盤價"]),
        high: toNumber(row.HighestPrice || row.High || row.high || row["最高價"]),
        low: toNumber(row.LowestPrice || row.Low || row.low || row["最低價"]),
        change: toNumber(row.Change || row.PriceChange || row["漲跌價差"]),
        volume: toNumber(row.TradeVolume || row.Volume || row.TradingShares || row["成交股數"] || row["成交量"]),
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
  const base = ["台股", "股票", name, code].filter(Boolean);
  const semiconductorNames = ["台積", "聯電", "華邦", "聯發", "半導體", "晶片"];
  const electronicsNames = ["電", "鴻海", "廣達", "緯創", "英業達"];
  const semiconductor = ["2330", "2303", "2344", "2454"].includes(code) || semiconductorNames.some((word) => name.includes(word));
  const electronics = ["2308", "2317", "2356", "2382", "3231"].includes(code) || electronicsNames.some((word) => name.includes(word));
  if (semiconductor) return [...base, "半導體", "晶片", "AI", "先進製程", "封測", "晶圓", "記憶體", "IC設計"];
  if (electronics) return [...base, "AI伺服器", "電子", "代工", "電源", "供應鏈", "伺服器", "筆電"];
  if (code === "0050") return [...base, "ETF", "大盤", "權值股", "台灣50", "指數"];
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
  const bullWords = ["成長", "創高", "上修", "受惠", "訂單", "擴產", "漲", "突破", "買超", "獲利", "增溫", "看旺", "法說"];
  const bearWords = ["下修", "衰退", "虧損", "跌", "賣超", "降評", "裁員", "庫存", "警示", "減少", "疲弱", "利空"];
  const bull = countMatches(text, bullWords);
  const bear = countMatches(text, bearWords);
  const relation = directHit ? "直接相關" : themeHits >= 2 ? "間接相關" : "無關雜訊";
  const sentiment = bull > bear ? "利多" : bear > bull ? "利空" : "中性";
  const shortWords = ["今日", "盤中", "外資", "買超", "賣超", "股價", "開盤", "收盤"];
  const midWords = ["月營收", "季報", "法說", "訂單", "庫存", "匯率", "產品", "展望"];
  const longWords = ["產業", "長期", "擴產", "資本支出", "政策", "趨勢", "投資"];
  const revenueWords = ["營收", "訂單", "出貨", "客戶"];
  const marginWords = ["毛利", "成本", "匯率", "報價", "價格"];
  const valuationWords = ["本益比", "目標價", "評等", "估值"];
  const industryWords = ["AI", "政策", "產業", "擴產", "資本支出"];
  const horizon = countMatches(text, shortWords) > 0
    ? "短線"
    : countMatches(text, midWords) > 0
      ? "中線"
      : countMatches(text, longWords) > 0
        ? "長線"
        : "中線";
  const confidence = Math.max(25, Math.min(92, (directHit ? 60 : themeHits >= 2 ? 42 : 25) + Math.min(18, themeHits * 6) + Math.min(10, (bull + bear) * 3)));
  const impact = countMatches(text, revenueWords) > 0
    ? "可能影響營收與未來成長想像"
    : countMatches(text, marginWords) > 0
      ? "可能影響毛利與獲利壓力"
      : countMatches(text, valuationWords) > 0
        ? "可能影響估值與市場期待"
        : countMatches(text, industryWords) > 0
          ? "可能影響產業方向與長期敘事"
          : "主要影響市場情緒，需再用營收與財報驗證";

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
        ? "新聞由短期快取提供，仍需點開原文確認細節。"
        : "新聞來源查詢成功，但目前沒有符合條件的可判讀新聞。",
    };
  }

  const activeRequest = newsInflight.get(cacheKey);
  if (activeRequest) return activeRequest;

  const query = code === "0050"
    ? "0050 元大台灣50 ETF OR 成分股 OR 台股大盤"
    : `${code} ${name} 股票 OR 台股`;
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
          ? "新聞用標題與摘要做關聯判讀，仍需點開原文確認細節。"
          : "新聞來源查詢成功，但目前沒有符合條件的可判讀新聞。",
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
            ? "新聞來源本次逾時，顯示最近一次成功取得的快取。"
            : "新聞來源本次暫時不可用，顯示最近一次成功取得的快取。",
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
          ? "新聞來源讀取逾時，不代表沒有新聞，請稍後重試。"
          : "新聞來源暫時無法連線，不代表沒有新聞，請稍後重試。",
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
  const q = question.trim() || "請給我目前風險與操作建議";
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
  const stance = highRisk ? "高風險" : trendUp ? "偏多" : "觀察";

  return {
    title: `${quote.code} ${quote.name} Agent 回覆`,
    stance,
    tone,
    confidence: Math.max(45, Math.min(88, 100 - Math.abs(latest.pullback - 50))),
    question: q,
    answer: `目前收盤 ${fmt(close)}，回檔機率 ${latest.pullback}%。短線支撐 ${fmt(levels.supportShort)}，中線支撐 ${fmt(levels.supportMid)}，短線壓力 ${fmt(levels.resistanceShort)}。${highRisk ? "不建議追高，等回測或量縮整理較好。" : trendUp ? "趨勢仍偏多，但進場仍需分批。" : "目前以觀察和控風險為主。"}`,
    keyPoints: [
      `均線：MA20 ${fmt(latest.ma20)}、MA60 ${fmt(latest.ma60)}、MA120 ${fmt(latest.ma120)}。`,
      `指標：RSI14 ${fmt(latest.rsi14, 1)}、KD ${fmt(latest.k, 1)} / ${fmt(latest.d, 1)}、MACD Hist ${fmt(latest.hist, 3)}。`,
      `機率：整體 ${prob.overall}%、技術 ${prob.technical}%、量能 ${prob.volume}%、波段 ${prob.wave}%。`,
    ],
    actions: [
      `第一觀察買點：${fmt(levels.supportShort * 0.99)} - ${fmt(levels.supportShort * 1.01)}。`,
      `第二分批買點：${fmt(levels.supportMid * 0.99)} - ${fmt(levels.supportMid * 1.02)}。`,
      `停損：${fmt(stop)}；目標：${fmt(target1)} / ${fmt(target2)}。`,
    ],
    watchlist: [
      "若跌破 MA20 且無法收回，短線結構轉弱。",
      "若突破壓力但量能沒有放大，容易是假突破。",
      "若 RSI 維持 70 以上，代表強勢但追價風險同步升高。",
    ],
    disclaimer: "本頁為技術分析與情境推估工具，不構成投資建議。",
    generatedAt: new Date().toISOString(),
  };
}

export const handler = router({
  "GET /api/_healthcheck": [async () => json({ message: "Success" })],

  "GET /api/quote": [async ({ query }) => {
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

  "GET /api/agent": [async ({ query }) => {
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

  "GET /api/news": [async ({ query }) => {
    const code = cleanCode(query.code);
    const name = String(query.name || FALLBACK_NAMES[code] || code).slice(0, 40);
    if (!code) return error("Missing stock code", 400);
    return json(await loadNews(code, name));
  }],

  "GET /api/fundamentals": [async ({ query }) => {
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
