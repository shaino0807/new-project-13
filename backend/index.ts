import { router, json, error, secrets, db } from "@appdeploy/sdk";

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

type YahooChartRange = "6mo" | "1y" | "5y";

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

function encodeText(value: unknown) {
  return encodeURIComponent(String(value ?? ""));
}

function encodeTextTree(value: any): any {
  if (typeof value === "string") return encodeText(value);
  if (Array.isArray(value)) return value.map(item => encodeTextTree(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeTextTree(item)]));
  }
  return value;
}

const SWING_SKILL_BUNDLE = {
  version: "project-local-2026-07-12",
  sourceRoot: "project-skills",
  orchestrator: {
    name: "taiwan-stock-swing-orchestrator",
    path: "project-skills/taiwan-stock-swing-orchestrator/SKILL.md",
  },
  specialists: [
    { stage: "macro", name: "senior-macro-strategist", path: "project-skills/senior-macro-strategist/SKILL.md" },
    { stage: "screener", name: "taiwan-stock-screener", path: "project-skills/taiwan-stock-screener/SKILL.md" },
    { stage: "valuation", name: "comparable-company-analysis", path: "project-skills/comparable-company-analysis/SKILL.md" },
    { stage: "deep-analysis", name: "senior-stock-investment-analysis", path: "project-skills/senior-stock-investment-analysis/SKILL.md" },
    { stage: "technical", name: "daily-market-technical-analysis", path: "project-skills/daily-market-technical-analysis/SKILL.md" },
    { stage: "signal", name: "kline-long-short-signal", path: "project-skills/kline-long-short-signal/SKILL.md" },
  ],
  stageOrder: ["macro", "screener", "user-selection-gate", "valuation", "deep-analysis", "technical", "signal", "summary"],
  gate: {
    required: true,
    input: "selected stock codes",
    rule: "macro and screener run first; valuation, deep analysis, technical, signal, and final synthesis run only after user-selected codes are present",
  },
  outputContract: [
    "macroView",
    "candidateTables",
    "valuationComparison",
    "fundamentalThesis",
    "dailyTechnicalFramework",
    "klineLongShortSignal",
    "finalResearchReport",
  ],
};

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const SWING_REPORT_JOB_TABLE = "swing_report_jobs_v1";
let openAiApiKeyPromise: Promise<string> | null = null;
let openAiReportModelPromise: Promise<string> | null = null;

async function getOpenAiApiKey() {
  if (!openAiApiKeyPromise) {
    openAiApiKeyPromise = secrets.readSecret("OPENAI_API_KEY").catch(() => "");
  }
  const key = await openAiApiKeyPromise;
  if (!key) openAiApiKeyPromise = null;
  return key;
}

async function getOpenAiReportModel() {
  if (!openAiReportModelPromise) {
    openAiReportModelPromise = secrets.readSecret("OPENAI_REPORT_MODEL").catch(() => "");
  }
  const model = await openAiReportModelPromise;
  return String(model || "gpt-4.1-nano").trim() || "gpt-4.1-nano";
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
  technicalSnapshot: {
    latest: QuoteInfo["analysis"]["latest"];
    levels: QuoteInfo["analysis"]["levels"];
    probabilities: QuoteInfo["analysis"]["probabilities"];
  };
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
const CUSTOM_SCREENER_LIMIT = 80;
const DEFAULT_FULL_MARKET_SEED_LIMIT = 64;
const EXPANDED_SWING_SEED_CODES = [
  "1101", "1102", "1216", "1301", "1303", "1402", "1476", "1590", "1605", "2002",
  "2049", "2201", "2207", "2301", "2303", "2308", "2313", "2317", "2324", "2327",
  "2330", "2344", "2352", "2353", "2356", "2357", "2360", "2368", "2376", "2377",
  "2379", "2382", "2383", "2395", "2408", "2409", "2412", "2449", "2454", "2474",
  "2481", "2603", "2609", "2615", "2633", "2880", "2881", "2882", "2883", "2884",
  "2885", "2886", "2887", "2891", "2892", "3008", "3017", "3034", "3035", "3045",
  "3081", "3189", "3231", "3260", "3324", "3363", "3443", "3450", "3481", "3529",
  "3533", "3653", "3661", "3665", "3711", "4919", "4938", "5269", "5347", "5483",
  "5871", "5876", "5880", "6239", "6257", "6269", "6274", "6415", "6446", "6488",
  "6505", "6669", "6770", "6781", "6805", "8046", "8069", "8150", "8299", "8996",
];
const COMPANY_THEME_DETAILS: Record<string, string> = {
  "1101": "\u6c34\u6ce5\u8207\u5efa\u6750\uff1b\u53f0\u7063\u5167\u9700\u3001\u623f\u5e02\u8207\u57fa\u5efa\u984c\u6750\u3002",
  "1102": "\u6c34\u6ce5\u8207\u5efa\u6750\uff1b\u5167\u9700\u666f\u6c23\u8207\u71df\u5efa\u5faa\u74b0\u3002",
  "1216": "\u98df\u54c1\u8207\u901a\u8def\u9f8d\u982d\uff1b\u9632\u79a6\u578b\u5167\u9700\u8207\u6d88\u8cbb\u984c\u6750\u3002",
  "1590": "\u5de5\u696d\u6a5f\u5668\u4eba\u8207\u81ea\u52d5\u5316\uff1b\u667a\u6167\u88fd\u9020\u8207\u6a5f\u5668\u4eba\u984c\u6750\u3002",
  "2303": "\u6210\u719f\u88fd\u7a0b\u6676\u5713\u4ee3\u5de5\uff1b\u534a\u5c0e\u9ad4\u5faa\u74b0\u3001\u96fb\u6e90\u7ba1\u7406\u8207\u8eca\u7528\u984c\u6750\u3002",
  "2308": "\u96fb\u6e90\u7ba1\u7406\u3001\u6563\u71b1\u8207\u5de5\u696d\u81ea\u52d5\u5316\uff1bAI \u4f3a\u670d\u5668\u96fb\u6e90/\u6563\u71b1\u984c\u6750\u3002",
  "2313": "PCB \u5370\u5237\u96fb\u8def\u677f\uff1b\u9ad8\u968e\u8f09\u677f\u3001AI \u4f3a\u670d\u5668\u8207\u901a\u8a0a\u677f\u984c\u6750\u3002",
  "2317": "\u96fb\u5b50\u4ee3\u5de5\u8207 AI \u4f3a\u670d\u5668\u7d44\u88dd\uff1b\u8cc7\u6599\u4e2d\u5fc3\u3001\u96fb\u52d5\u8eca\u8207\u6a5f\u5668\u4eba\u984c\u6750\u3002",
  "2330": "\u6676\u5713\u4ee3\u5de5\u9f8d\u982d\uff1bAI/HPC\u3001\u5148\u9032\u88fd\u7a0b\u8207 CoWoS \u5148\u9032\u5c01\u88dd\u984c\u6750\u3002",
  "2344": "DRAM \u8207\u8a18\u61b6\u9ad4 IC\uff1b\u8a18\u61b6\u9ad4\u5faa\u74b0\u3001AI \u908a\u7de3\u8207\u8eca\u7528\u9700\u6c42\u3002",
  "2356": "\u7b46\u96fb\u8207\u4f3a\u670d\u5668 ODM\uff1bAI \u4f3a\u670d\u5668\u3001PC/AI PC \u984c\u6750\u3002",
  "2357": "\u54c1\u724c PC\u3001\u4e3b\u6a5f\u677f\u8207\u96fb\u7af6\uff1bAI PC \u8207\u908a\u7de3 AI \u984c\u6750\u3002",
  "2368": "PCB \u8207\u4f3a\u670d\u5668\u677f\uff1bAI \u4f3a\u670d\u5668\u3001\u9ad8\u5c64\u6578 PCB \u984c\u6750\u3002",
  "2379": "\u7db2\u8def\u8207\u591a\u5a92\u9ad4 IC \u8a2d\u8a08\uff1bAI PC\u3001\u7db2\u901a\u8207\u8eca\u7528\u6676\u7247\u984c\u6750\u3002",
  "2382": "\u96f2\u7aef\u8207 AI \u4f3a\u670d\u5668 ODM\uff1b\u8cc7\u6599\u4e2d\u5fc3\u3001GB200/AI \u4f3a\u670d\u5668\u984c\u6750\u3002",
  "2383": "PCB \u8207\u9ad8\u901f\u50b3\u8f38\u677f\uff1bAI \u4f3a\u670d\u5668\u3001\u8f09\u677f\u8207\u9ad8\u983b\u6750\u6599\u984c\u6750\u3002",
  "2395": "\u5de5\u696d\u96fb\u8166\u8207\u908a\u7de3\u904b\u7b97\uff1b\u667a\u6167\u5de5\u5ee0\u3001AIoT \u8207\u5de5\u63a7\u984c\u6750\u3002",
  "2408": "DRAM \u8a18\u61b6\u9ad4\uff1b\u8a18\u61b6\u9ad4\u5831\u50f9\u5faa\u74b0\u8207 AI \u5b58\u5132\u9700\u6c42\u3002",
  "2409": "\u9762\u677f\u8207\u986f\u793a\u5668\uff1b\u9762\u677f\u5831\u50f9\u3001AI PC \u986f\u793a\u8207\u8eca\u7528\u986f\u793a\u984c\u6750\u3002",
  "2449": "IC \u6e2c\u8a66\uff1bAI/HPC\u3001ASIC \u8207\u9ad8\u968e\u6676\u7247\u6e2c\u8a66\u984c\u6750\u3002",
  "2454": "IC \u8a2d\u8a08\u9f8d\u982d\uff1b\u624b\u6a5f SoC\u3001AI \u908a\u7de3\u8207\u8eca\u7528\u6676\u7247\u984c\u6750\u3002",
  "3008": "\u624b\u6a5f\u93e1\u982d\u8207\u5149\u5b78\uff1b\u9ad8\u50f9\u80a1\u3001\u860b\u679c\u4f9b\u61c9\u93c8\u8207\u8eca\u7528\u5149\u5b78\u984c\u6750\u3002",
  "3017": "\u6563\u71b1\u6a21\u7d44\uff1bAI \u4f3a\u670d\u5668\u6c34\u51b7/\u98a8\u51b7\u3001\u9ad8\u529f\u8017\u6676\u7247\u6563\u71b1\u984c\u6750\u3002",
  "3034": "\u9762\u677f\u9a45\u52d5 IC \u8207 IC \u8a2d\u8a08\uff1bAI PC\u3001\u986f\u793a\u8207\u8eca\u7528\u986f\u793a\u984c\u6750\u3002",
  "3081": "\u5149\u901a\u8a0a\u8207 III-V \u534a\u5c0e\u9ad4\uff1bCPO\u3001800G/1.6T \u5149\u901a\u8a0a\u984c\u6750\u3002",
  "3231": "\u4f3a\u670d\u5668\u8207 PC ODM\uff1bAI \u4f3a\u670d\u5668\u3001\u8cc7\u6599\u4e2d\u5fc3\u8207 PC \u5faa\u74b0\u984c\u6750\u3002",
  "3324": "\u6563\u71b1\u6a21\u7d44\uff1bAI \u4f3a\u670d\u5668\u6563\u71b1\u3001\u6c34\u51b7\u8207\u9ad8\u529f\u8017\u7cfb\u7d71\u984c\u6750\u3002",
  "3363": "\u5149\u901a\u8a0a\u5143\u4ef6\uff1bCPO\u3001\u9ad8\u901f\u5149\u6a21\u7d44\u8207\u8cc7\u6599\u4e2d\u5fc3\u984c\u6750\u3002",
  "3450": "\u5149\u901a\u8a0a\u5143\u4ef6\uff1bCPO\u3001800G/1.6T \u5149\u901a\u8a0a\u8207\u8cc7\u6599\u4e2d\u5fc3\u984c\u6750\u3002",
  "3711": "\u5c01\u6e2c\u8207\u5148\u9032\u5c01\u88dd\uff1bAI \u6676\u7247\u5c01\u6e2c\u3001OSAT \u8207\u5148\u9032\u5c01\u88dd\u984c\u6750\u3002",
  "6239": "\u8a18\u61b6\u9ad4\u5c01\u6e2c\uff1bDRAM/NAND \u5faa\u74b0\u8207\u5b58\u5132\u9700\u6c42\u984c\u6750\u3002",
  "6257": "IC \u6e2c\u8a66\uff1b\u8a18\u61b6\u9ad4\u8207\u7cfb\u7d71\u6676\u7247\u6e2c\u8a66\u984c\u6750\u3002",
  "6269": "FPCB \u8207\u9ad8\u901f\u50b3\u8f38\u677f\uff1b\u624b\u6a5f\u3001\u8eca\u7528\u8207 AI \u4f3a\u670d\u5668\u96f6\u7d44\u4ef6\u984c\u6750\u3002",
  "6669": "AI \u4f3a\u670d\u5668\u6574\u6a5f\u8207\u8cc7\u6599\u4e2d\u5fc3\uff1b\u9ad8\u50f9\u9ad8\u6210\u9577 AI \u4f3a\u670d\u5668\u984c\u6750\u3002",
  "8046": "ABF \u8f09\u677f\uff1bAI/HPC \u6676\u7247\u8f09\u677f\u8207\u9ad8\u968e\u5c01\u88dd\u984c\u6750\u3002",
};

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
    companies,
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
    companies,
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
    technicalSnapshot: {
      latest: quote.analysis.latest,
      levels: quote.analysis.levels,
      probabilities: quote.analysis.probabilities,
    },
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
  if (!raw) return [];
  const codes = raw.split(/[,\s]+/)
    .map(cleanCode)
    .filter(code => /^\d{4,6}$/.test(code));
  return [...new Set(codes)].slice(0, CUSTOM_SCREENER_LIMIT);
}

function industryThemeScore(company: { code: string; name: string; type: string; industry: string }) {
  const text = `${company.name || ""} ${company.industry || ""}`;
  if (COMPANY_THEME_DETAILS[company.code]) return 100;
  if (/\u534a\u5c0e\u9ad4|\u96fb\u5b50\u96f6\u7d44\u4ef6|\u5149\u96fb|\u96fb\u8166|\u901a\u4fe1|\u5176\u4ed6\u96fb\u5b50|\u8cc7\u8a0a/i.test(text)) return 88;
  if (/\u91d1\u878d|\u96fb\u6a5f|\u6a5f\u68b0|\u751f\u6280|\u822a\u904b|\u7d21\u7e54|\u5316\u5de5|\u6c34\u6ce5|\u92fc\u9435/i.test(text)) return 70;
  return 52;
}

function buildDefaultScreenerUniverse(marketUniverseResult: any) {
  const companies = Array.isArray(marketUniverseResult?.companies) ? marketUniverseResult.companies : [];
  const byCode = new Map<string, any>(companies.map((company: any) => [company.code, company]));
  const selected: string[] = [];
  const add = (code: string) => {
    const clean = cleanCode(code);
    if (!/^\d{4}$/.test(clean)) return;
    if (selected.includes(clean)) return;
    if (byCode.size && !byCode.has(clean)) return;
    selected.push(clean);
  };
  EXPANDED_SWING_SEED_CODES.forEach(add);
  [...companies]
    .filter((company: any) => /^\d{4}$/.test(company.code))
    .sort((a: any, b: any) => {
      const scoreDiff = industryThemeScore(b) - industryThemeScore(a);
      if (scoreDiff) return scoreDiff;
      return String(a.code).localeCompare(String(b.code));
    })
    .forEach((company: any) => {
      if (selected.length < DEFAULT_FULL_MARKET_SEED_LIMIT) add(company.code);
    });
  if (!selected.length) return DEFAULT_SCREENER_UNIVERSE;
  return selected.slice(0, DEFAULT_FULL_MARKET_SEED_LIMIT);
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
  const customUniverse = parseScreenerUniverse(universeValue);
  const marketUniverseResult = await withTimeout(loadTaiwanCompanyUniverse(), 12000, "Taiwan company universe timed out").catch(err => ({
    ok: false,
    message: err instanceof Error ? err.message : String(err),
  }));
  const isDefaultUniverse = customUniverse.length === 0;
  const universe = isDefaultUniverse ? buildDefaultScreenerUniverse(marketUniverseResult) : customUniverse;
  const scoreLimit = isDefaultUniverse ? 10 : 4;
  const results = await settleWithLimit(universe, scoreLimit, code => loadValueScore(code, options));
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
      defaultSeedLimit: DEFAULT_FULL_MARKET_SEED_LIMIT,
      defaultSeedSource: isDefaultUniverse ? "full-market company universe plus cross-industry swing seed" : "custom input",
      groups: [...new Set(TAIWAN_SCREENING_UNIVERSE.filter(item => universe.includes(item.code)).map(item => item.group))],
      note: isDefaultUniverse
        ? "Full Taiwan company universe is loaded first; this request scores a broader cross-industry seed from that universe to avoid synchronous 2,500-stock upstream timeouts."
        : "Custom input mode scores only the submitted stock list.",
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

async function fetchYahooSymbolChart(symbol: string, label: string, range: YahooChartRange = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false&events=history`;
  const data = await fetchJson(url, 9000);
  const result = data?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!result || !quote || timestamps.length < 30) throw new Error(`${label} chart unavailable`);
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
  if (bars.length < 30) throw new Error(`${label} chart has too few usable bars`);
  const closes = bars.map(row => row.close);
  const latest = bars[bars.length - 1];
  const previous = bars[Math.max(0, bars.length - 22)];
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  return {
    label,
    symbol,
    date: latest.date,
    close: round(latest.close),
    changePct20: previous?.close ? round(((latest.close / previous.close) - 1) * 100, 2) : null,
    ma20: lastFinite(ma20),
    ma60: lastFinite(ma60),
    trend: latest.close > lastFinite(ma20) && lastFinite(ma20) > lastFinite(ma60) ? "risk-on" : latest.close > lastFinite(ma20) ? "range-bound" : "defensive",
    sourceUrl: url,
  };
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

function ymd(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function parseTwseRocDate(value: string) {
  const parts = String(value || "").split("/");
  if (parts.length !== 3) return "";
  const year = Number(parts[0]) + 1911;
  const month = String(Number(parts[1])).padStart(2, "0");
  const day = String(Number(parts[2])).padStart(2, "0");
  return Number.isFinite(year) ? `${year}-${month}-${day}` : "";
}

async function fetchTwseStockDayTrend(code: string) {
  const urls: string[] = [];
  const rows: Array<DailyBar & { tradingValue: number }> = [];
  const now = new Date();
  for (let i = 0; i < 4; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymd(date)}&stockNo=${encodeURIComponent(code)}&response=json`;
    urls.push(url);
    try {
      const data = await fetchJson(url, 6500);
      const batch = Array.isArray(data?.data) ? data.data : [];
      batch.forEach((row: any[]) => {
        const dateText = parseTwseRocDate(row[0]);
        const close = toNumber(row[6]);
        if (!dateText || !Number.isFinite(close)) return;
        rows.push({
          date: dateText,
          volume: toNumber(row[1]),
          tradingValue: toNumber(row[2]),
          open: toNumber(row[3]),
          high: toNumber(row[4]),
          low: toNumber(row[5]),
          close,
        });
      });
    } catch {
      // Keep trying earlier months; the caller receives a clear fallback when usable rows are insufficient.
    }
  }
  const unique = [...new Map(rows.map(row => [row.date, row])).values()]
    .filter(row => Number.isFinite(row.close))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (unique.length < 25) throw new Error(`TWSE STOCK_DAY has only ${unique.length} usable rows for ${code}`);
  const closes = unique.map(row => row.close);
  const ma20Values = sma(closes, 20);
  const latest = unique[unique.length - 1];
  const ma20 = lastFinite(ma20Values);
  const ma20FiveAgo = ma20Values.length > 5 ? ma20Values[ma20Values.length - 6] : NaN;
  const tradingValue3m = unique.slice(-60).reduce((sum, row) => sum + (Number.isFinite(row.tradingValue) ? row.tradingValue : 0), 0);
  const slopePct = Number.isFinite(ma20) && Number.isFinite(ma20FiveAgo) && ma20FiveAgo > 0
    ? round(((ma20 / ma20FiveAgo) - 1) * 100, 2)
    : null;
  return {
    ok: true,
    code,
    latestDate: latest.date,
    latestClose: latest.close,
    latestVolume: latest.volume,
    latestTradingValue: latest.tradingValue,
    tradingValue100m: Number.isFinite(latest.tradingValue) ? round(latest.tradingValue / 100000000, 2) : null,
    tradingValue3m100m: tradingValue3m > 0 ? round(tradingValue3m / 100000000, 2) : null,
    ma20: Number.isFinite(ma20) ? round(ma20) : null,
    ma20FiveAgo: Number.isFinite(ma20FiveAgo) ? round(ma20FiveAgo) : null,
    ma20Slope5dPct: slopePct,
    closeVs20MaPct: Number.isFinite(ma20) && ma20 > 0 ? round(((latest.close / ma20) - 1) * 100, 2) : null,
    source: "TWSE STOCK_DAY",
    sourceUrls: urls,
  };
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

function cleanNewsText(value: string) {
  return stripTags(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+-\s+(Yahoo\u80a1\u5e02|Google News|Reuters|Bloomberg|CNBC|MoneyDJ|Anue|\u4e2d\u592e\u793e|\u7d93\u6fdf\u65e5\u5831|\u5de5\u5546\u6642\u5831)\s*$/i, "")
    .trim();
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

async function loadSwingMacroNews() {
  const topics = [
    { key: "taiwan", label: "\u53f0\u80a1", query: "\u53f0\u80a1 \u5927\u76e4 \u5916\u8cc7 \u671f\u8ca8 \u9078\u64c7\u6b0a" },
    { key: "us", label: "\u7f8e\u80a1", query: "S&P 500 Nasdaq Dow futures earnings risk sentiment" },
    { key: "etf", label: "ETF", query: "\u53f0\u7063 ETF \u7f8e\u80a1 ETF \u50b5\u5238 ETF \u8cc7\u91d1\u6d41\u5411" },
    { key: "rates", label: "\u7f8e\u50b5\u8207\u5229\u7387", query: "US Treasury yield Fed rate CPI PCE bond market" },
    { key: "fx", label: "\u532f\u7387", query: "\u7f8e\u5143 \u65b0\u53f0\u5e63 \u65e5\u5713 \u532f\u7387 \u5916\u8cc7" },
    { key: "commodities", label: "\u80fd\u6e90\u8207\u8cb4\u91d1\u5c6c", query: "oil gold copper commodities inflation market" },
    { key: "crypto", label: "\u52a0\u5bc6\u8ca8\u5e63", query: "Bitcoin Ethereum crypto ETF risk appetite" },
    { key: "derivatives", label: "\u671f\u8ca8\u8207\u9078\u64c7\u6b0a", query: "\u53f0\u6307\u671f \u9078\u64c7\u6b0a VIX futures options market" },
    { key: "calendar", label: "\u7e3d\u7d93\u65e5\u66c6", query: "\u7e3d\u7d93\u65e5\u66c6 CPI PCE FOMC nonfarm payrolls Taiwan export orders" },
    { key: "semiconductor", label: "\u534a\u5c0e\u9ad4", query: "\u534a\u5c0e\u9ad4 AI \u53f0\u7a4d\u96fb \u4f9b\u61c9\u93c8" },
  ];
  const results = await settleWithLimit(topics, 2, async topic => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic.query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const xml = await fetchText(url, 12000);
    const items = parseRssItems(xml).slice(0, 3);
    const enriched = await settleWithLimit(items, 2, item => enrichMacroNewsItem(item, topic.label, url));
    return enriched.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  });
  const importanceRank: Record<string, number> = { "\u9ad8": 3, "\u4e2d": 2, "\u4f4e": 1 };
  const items = results
    .flatMap(result => result.status === "fulfilled" ? result.value : [])
    .sort((a, b) => (importanceRank[b.importance] || 0) - (importanceRank[a.importance] || 0));
  const errors = results.map((result, index) => result.status === "rejected"
    ? { topic: topics[index].label, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }
    : null
  ).filter(Boolean);
  return {
    ok: items.length > 0,
    generatedAt: new Date().toISOString(),
    source: "Google News RSS plus readable article-page excerpts when available",
    items: items.slice(0, 10),
    errors,
  };
}

function extractArticleText(html: string) {
  const meta = [...html.matchAll(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/gi)]
    .map(match => decodeHtml(match[1] || ""))
    .join(" ");
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return cleanNewsText(`${meta} ${decodeHtml(body)}`).slice(0, 1800);
}

function articleEvidencePoints(text: string, fallback: string) {
  const source = cleanNewsText(text || fallback || "");
  if (!source) return [];
  const parts = source
    .split(/[\u3002.!?\uff1b;]\s*/)
    .map(part => part.trim())
    .filter(part => part.length >= 18 && part.length <= 180)
    .filter(part => !/\bfunction\b|\bfromCharCode\b|\breturn\b|\bvar\b|\bconst\b|\blet\b|[{}`]/i.test(part));
  return [...new Set(parts)].slice(0, 3);
}

function isGoogleNewsWrapperText(text: string) {
  return /Comprehensive up-to-date news coverage|aggregated from sources all over the world by Google News|Google News/i.test(text);
}

function extractPublisherUrlFromGoogleNewsHtml(html: string) {
  const decoded = decodeHtml(html)
    .replace(/\\u003d/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/");
  const urls = [...decoded.matchAll(/https?:\/\/[^\s"'<>\\]+/g)].map(match => match[0]);
  return urls.find(url =>
    !/google\.com|googleusercontent\.com|gstatic\.com|google-analytics\.com|googletagmanager\.com|doubleclick\.net|schema\.org|w3\.org|youtube\.com|youtu\.be/i.test(url) &&
    !/\.(png|jpg|jpeg|gif|webp|svg|ico|js|css|json|xml)(\?|$)/i.test(url)
  ) || "";
}

async function enrichMacroNewsItem(item: NewsItem, topic: string, sourceUrl: string) {
  let articleText = "";
  let articleReadStatus = "\u50c5\u8b80\u53d6 RSS \u6a19\u984c\u8207\u6458\u8981";
  let publisherUrl = "";
  try {
    const html = await fetchText(item.link, 9000);
    const extracted = extractArticleText(html);
    const isGoogleWrapper = /news\.google\.com/i.test(item.link) || isGoogleNewsWrapperText(extracted);
    if (isGoogleWrapper) {
      publisherUrl = "";
      articleText = "";
    } else {
      articleText = extracted;
    }
    if (articleText.length >= 120 && !isGoogleNewsWrapperText(articleText)) {
      articleReadStatus = publisherUrl ? "\u5df2\u8b80\u53d6\u539f\u59cb\u65b0\u805e\u9801\u5167\u6587\u6458\u8981" : "\u5df2\u8b80\u53d6\u65b0\u805e\u9801\u5167\u6587\u6458\u8981";
    } else {
      articleText = "";
      articleReadStatus = publisherUrl
        ? "\u539f\u59cb\u65b0\u805e\u9801\u5167\u6587\u7121\u6cd5\u53d6\u5f97\uff0c\u6539\u7528 RSS \u6a19\u984c\u8207\u6458\u8981"
        : "\u4f86\u6e90\u70ba Google News RSS wrapper\uff0c\u672a\u53d6\u5f97\u53ef\u9760\u539f\u6587\u7db2\u5740\uff0c\u6539\u7528 RSS \u6a19\u984c\u8207\u6458\u8981";
    }
  } catch (err) {
    articleReadStatus = "\u65b0\u805e\u9801\u5167\u6587\u66ab\u6642\u7121\u6cd5\u8b80\u53d6\uff0c\u6539\u7528 RSS \u6a19\u984c\u8207\u6458\u8981";
  }
  return {
    ...classifyMacroNews(item, topic, articleText, articleReadStatus),
    sourceUrl,
    publisherUrl,
    link: publisherUrl || item.link,
  };
}

function classifyMacroNews(item: NewsItem, topic: string, articleText = "", articleReadStatus = "\u50c5\u8b80\u53d6 RSS \u6a19\u984c\u8207\u6458\u8981") {
  const cleanTitle = cleanNewsText(item.title);
  const cleanSnippet = cleanNewsText(item.snippet);
  const articleEvidence = articleEvidencePoints(articleText, cleanSnippet || cleanTitle);
  const articleBasis = articleEvidence.join(" ");
  const text = `${cleanTitle} ${cleanSnippet} ${articleBasis}`.toLowerCase();
  const hasRate = /fed|fomc|rate|yield|\u5229\u7387|\u964d\u606f|\u7f8e\u5143|\u532f\u7387|\u516c\u50b5/.test(text);
  const hasTaiwan = /\u53f0\u80a1|\u52a0\u6b0a|\u5916\u8cc7|twse|\u65b0\u53f0\u5e63|\u53f0\u5e63/.test(text);
  const hasSemi = /ai|tsmc|nvidia|\u534a\u5c0e\u9ad4|\u53f0\u7a4d|\u4f3a\u670d\u5668|\u4f9b\u61c9\u93c8|\u6676\u7247/.test(text);
  const hasRisk = /\u901a\u81a8|\u8870\u9000|\u95dc\u7a05|\u5730\u7de3|\u8dcc|\u8ce3\u58d3|\u8b66\u793a|\u964d\u8a55|\u8d70\u5f31/.test(text);
  const hasGrowth = /\u6210\u9577|\u5275\u9ad8|\u8ca1\u5831|\u71df\u6536|\u8a02\u55ae|\u4e0a\u4fee|\u8cb7\u8d85|\u9700\u6c42/.test(text);
  const importance = hasRate || hasTaiwan || hasSemi ? "\u9ad8" : hasRisk || hasGrowth ? "\u4e2d" : "\u4f4e";
  const sourceSummary = articleEvidence[0] || (cleanSnippet && cleanSnippet !== cleanTitle ? cleanSnippet : cleanTitle);
  const matchedDrivers = [
    hasTaiwan ? "\u53f0\u80a1\u98a8\u96aa\u504f\u597d/\u8cc7\u91d1\u9762" : "",
    hasRate ? "\u5229\u7387\u3001\u532f\u7387\u6216\u8cc7\u91d1\u6210\u672c" : "",
    hasSemi ? "AI/\u534a\u5c0e\u9ad4\u4f9b\u61c9\u93c8" : "",
    hasGrowth ? "\u71df\u6536\u3001\u9700\u6c42\u6216\u6210\u9577\u52d5\u80fd" : "",
    hasRisk ? "\u901a\u81a8\u3001\u8dcc\u52e2\u6216\u653f\u7b56\u98a8\u96aa" : "",
  ].filter(Boolean);
  const marketImpact = hasRisk
    ? "\u9700\u964d\u4f4e\u8ffd\u50f9\u4fe1\u5fc3\uff0c\u512a\u5148\u6aa2\u67e5\u5019\u9078\u80a1\u662f\u5426\u96e2 20MA \u904e\u9060\u6216\u91cf\u50f9\u5931\u8861\u3002"
    : hasGrowth || hasSemi
      ? "\u5c0d AI\u3001\u534a\u5c0e\u9ad4\u8207\u9ad8\u6210\u4ea4\u503c\u984c\u6750\u6709\u52a0\u6eab\u6548\u679c\uff0c\u4f46\u4ecd\u9700\u7528 20MA \u8207\u5931\u6548\u7dda\u63a7\u5236\u98a8\u96aa\u3002"
      : "\u5c6c\u80cc\u666f\u8cc7\u8a0a\uff0c\u53ea\u4f5c\u70ba\u4eca\u65e5\u5e02\u5834\u6c23\u6c1b\u8207\u98a8\u96aa\u6eab\u5ea6\u53c3\u8003\u3002";
  const screeningUse = hasRate
    ? "\u5f71\u97ff\u8cc7\u91d1\u98a8\u96aa\u504f\u597d\u8207\u532f\u7387\uff0c\u7be9\u9078\u6642\u63d0\u9ad8\u6d41\u52d5\u6027\u8207\u5931\u6548\u689d\u4ef6\u6b0a\u91cd\u3002"
    : hasTaiwan
      ? "\u76f4\u63a5\u5f71\u97ff\u53f0\u80a1\u6ce2\u6bb5\u5019\u9078\uff0c\u512a\u5148\u6aa2\u67e5\u5916\u8cc7\u3001\u6210\u4ea4\u503c\u8207 20MA \u7d50\u69cb\u3002"
      : hasSemi
        ? "\u8207 AI\u3001\u534a\u5c0e\u9ad4\u3001\u96fb\u5b50\u6b0a\u503c\u984c\u6750\u76f8\u95dc\uff0c\u4e3b\u984c\u5951\u5408\u5ea6\u52a0\u6b0a\u89c0\u5bdf\u3002"
        : "\u4e0d\u76f4\u63a5\u6539\u8b8a\u5019\u9078\u540d\u55ae\uff0c\u4f46\u6703\u7d0d\u5165\u5e02\u5834\u6c23\u6c1b\u5224\u8b80\u3002";
  const conclusion = hasRisk
    ? "\u7d50\u8ad6\uff1a\u9019\u5247\u65b0\u805e\u5c0d\u8ffd\u9ad8\u4e0d\u5229\uff0c\u5019\u9078\u80a1\u9700\u5148\u770b\u56de\u6e2c\u6216\u5931\u6548\u7dda\u3002"
    : hasSemi || hasGrowth
      ? "\u7d50\u8ad6\uff1a\u984c\u6750\u4ecd\u6709\u652f\u6490\uff0c\u4f46\u53ea\u80fd\u52a0\u5206\uff0c\u4e0d\u80fd\u53d6\u4ee3\u50f9\u683c\u8207\u91cf\u80fd\u78ba\u8a8d\u3002"
      : hasRate || hasTaiwan
        ? "\u7d50\u8ad6\uff1a\u9019\u662f\u5e02\u5834\u72c0\u614b\u5224\u65b7\u7684\u6838\u5fc3\u8cc7\u8a0a\uff0c\u6703\u5f71\u97ff\u4eca\u65e5\u5019\u9078\u80a1\u7684\u98a8\u96aa\u5206\u5c64\u3002"
        : "\u7d50\u8ad6\uff1a\u76ee\u524d\u5c6c\u80cc\u666f\u8ffd\u8e64\uff0c\u4e0d\u55ae\u7368\u6539\u8b8a\u64cd\u4f5c\u5047\u8a2d\u3002";
  const reason = matchedDrivers.length
    ? `\u539f\u56e0\uff1a\u65b0\u805e\u4e2d\u547d\u4e2d ${matchedDrivers.join("\u3001")}\uff0c\u9019\u4e9b\u56e0\u5b50\u6703\u5f71\u97ff 1-3 \u500b\u6708\u6ce2\u6bb5\u7684\u8cc7\u91d1\u6d41\u5411\u3001\u4f30\u503c\u5bb9\u5fcd\u5ea6\u6216\u984c\u6750\u6301\u7e8c\u6027\u3002`
    : "\u539f\u56e0\uff1a\u76ee\u524d\u6c92\u6709\u547d\u4e2d\u5229\u7387\u3001\u53f0\u80a1\u3001AI/\u534a\u5c0e\u9ad4\u6216\u660e\u78ba\u98a8\u96aa\u95dc\u9375\u8a5e\uff0c\u56e0\u6b64\u964d\u70ba\u80cc\u666f\u8ffd\u8e64\u3002";
  const focus = hasRisk
    ? "\u91cd\u9ede\u5224\u8b80\uff1a\u9019\u5247\u65b0\u805e\u7684\u6838\u5fc3\u4e0d\u662f\u984c\u6750\u52a0\u5206\uff0c\u800c\u662f\u63d0\u9192\u8cc7\u91d1\u6216\u4f30\u503c\u98a8\u96aa\uff0c\u56e0\u6b64\u7be9\u9078\u6642\u8981\u5148\u6aa2\u67e5\u8ffd\u9ad8\u8207\u5931\u6548\u7dda\u3002"
    : hasSemi || hasGrowth
      ? "\u91cd\u9ede\u5224\u8b80\uff1a\u9019\u5247\u65b0\u805e\u7684\u6838\u5fc3\u662f AI/\u534a\u5c0e\u9ad4\u6216\u6210\u9577\u52d5\u80fd\u662f\u5426\u5ef6\u7e8c\uff0c\u53ef\u4f5c\u70ba\u4e3b\u984c\u5951\u5408\u5ea6\u52a0\u5206\u3002"
      : hasRate
        ? "\u91cd\u9ede\u5224\u8b80\uff1a\u9019\u5247\u65b0\u805e\u7684\u6838\u5fc3\u662f\u5229\u7387\u3001\u532f\u7387\u6216\u8cc7\u91d1\u6210\u672c\uff0c\u6703\u5f71\u97ff\u5916\u8cc7\u98a8\u96aa\u504f\u597d\u8207\u9ad8\u4f30\u503c\u80a1\u5bb9\u5fcd\u5ea6\u3002"
        : hasTaiwan
          ? "\u91cd\u9ede\u5224\u8b80\uff1a\u9019\u5247\u65b0\u805e\u7684\u6838\u5fc3\u662f\u53f0\u80a1\u8cc7\u91d1\u9762\u6216\u5927\u76e4\u60c5\u7dd2\uff0c\u6703\u76f4\u63a5\u5f71\u97ff\u4eca\u65e5\u5019\u9078\u80a1\u7684\u512a\u5148\u9806\u5e8f\u3002"
          : "\u91cd\u9ede\u5224\u8b80\uff1a\u9019\u5247\u65b0\u805e\u76ee\u524d\u672a\u547d\u4e2d\u9ad8\u5f71\u97ff\u5e02\u5834\u4e3b\u8ef8\uff0c\u5148\u4f5c\u70ba\u80cc\u666f\u8ffd\u8e64\u3002";
  const keyPoints = [
    `\u5c0f\u8cc7/\u6ce2\u6bb5\u4ea4\u6613\u8005\u5148\u770b\uff1a${focus.replace(/^\u91cd\u9ede\u5224\u8b80\uff1a/, "")}`,
    matchedDrivers.length ? `\u8fa8\u8b58\u5230\u7684\u4e3b\u8ef8\uff1a${matchedDrivers.join("\u3001")}\u3002` : "\u8fa8\u8b58\u5230\u7684\u4e3b\u8ef8\uff1a\u672a\u547d\u4e2d\u9ad8\u5f71\u97ff\u95dc\u9375\u8a5e\uff0c\u5148\u5217\u80cc\u666f\u8ffd\u8e64\u3002",
    articleEvidence[1] ? `\u6587\u7ae0\u5167\u5bb9\u6458\u53e5\uff1a${articleEvidence[1]}` : `\u4f86\u6e90\u6458\u8981\uff1a${sourceSummary || "\u4f86\u6e90\u6458\u8981\u4e0d\u8db3\uff0c\u50c5\u4f9d\u6a19\u984c\u8207\u4e3b\u984c\u95dc\u9375\u8a5e\u5224\u8b80\u3002"}`,
    reason,
  ];
  return {
    topic,
    title: cleanTitle || item.title,
    link: item.link,
    source: item.source,
    publishedAt: item.publishedAt,
    snippet: item.snippet,
    importance,
    keyPoints,
    conclusion,
    reason,
    sourceSummary,
    articleReadStatus,
    articleEvidence,
    marketImpact,
    screeningUse,
    riskFlag: hasRisk ? "\u98a8\u96aa\u8b66\u793a" : hasGrowth || hasSemi ? "\u984c\u6750\u652f\u6490" : "\u80cc\u666f\u8cc7\u8a0a",
    horizon: hasRate || hasTaiwan ? "\u4eca\u65e5\u81f3 1 \u9031" : hasSemi || hasGrowth ? "1-3 \u500b\u6708" : "\u80cc\u666f\u8ffd\u8e64",
  };
}

function macroDirection(changePct20: number | null | undefined, trend: string | null | undefined, inverse = false) {
  const value = Number.isFinite(changePct20) ? changePct20 as number : null;
  const riskOn = trend === "risk-on" || (value !== null && (inverse ? value < 0 : value > 0));
  const riskOff = trend === "defensive" || (value !== null && (inverse ? value > 2 : value < -2));
  return riskOn ? "\u504f\u6b63\u5411" : riskOff ? "\u504f\u98a8\u96aa" : "\u4e2d\u6027\u89c0\u5bdf";
}

function macroAssetRow(name: string, item: any, interpretation: string, inverse = false) {
  if (!item) {
    return {
      name,
      status: "\u8cc7\u6599\u6682\u7f3a",
      change: "--",
      interpretation: `${interpretation}\uff1b\u672c\u6b21\u5373\u6642\u5831\u50f9\u672a\u53d6\u5f97\uff0c\u4e0d\u5f37\u884c\u5224\u8b80\u3002`,
      sourceUrl: null,
    };
  }
  const change = Number.isFinite(item.changePct20) ? `${item.changePct20 > 0 ? "+" : ""}${item.changePct20}% / 20\u65e5` : "--";
  return {
    name,
    status: macroDirection(item.changePct20, item.trend, inverse),
    close: item.close,
    date: item.date,
    change,
    interpretation,
    sourceUrl: item.sourceUrl || null,
  };
}

function topicNews(items: any[], topic: string, limit = 2) {
  return items.filter(item => item.topic === topic).slice(0, limit);
}

function topicTitles(items: any[], topic: string, limit = 2) {
  return topicNews(items, topic, limit).map(item => item.title).filter(Boolean);
}

function topicCounts(items: any[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const topic = item?.topic || "\u5176\u4ed6";
    const weight = item?.importance === "\u9ad8" ? 3 : item?.importance === "\u4e2d" ? 2 : 1;
    counts.set(topic, (counts.get(topic) || 0) + weight);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([topic, score]) => ({ topic, score }));
}

function newsEvidence(items: any[], limit = 2) {
  return items.slice(0, limit).map((item: any) => `${item.topic || "\u65b0\u805e"}\uff1a\u300c${item.title || item.conclusion || "\u4f86\u6e90\u6458\u8981"}\u300d`);
}

function buildMacroBriefing(riskScore: number, labelZh: string, macroNews: any, assets: any = {}) {
  const items = Array.isArray(macroNews?.items) ? macroNews.items : [];
  const highItems = items.filter((item: any) => item.importance === "\u9ad8").slice(0, 4);
  const riskItems = items.filter((item: any) => item.riskFlag === "\u98a8\u96aa\u8b66\u793a").slice(0, 3);
  const themeItems = items.filter((item: any) => item.riskFlag === "\u984c\u6750\u652f\u6490").slice(0, 3);
  const rankedTopics = topicCounts(items);
  const dominantTopics = rankedTopics.slice(0, 3).map(item => item.topic);
  const assetRadar = [
    macroAssetRow("\u53f0\u80a1 / ETF", assets.tw ? { close: assets.tw.close, date: assets.tw.quoteDate, changePct20: assets.tw.analysis?.latest?.ma20 ? round(((assets.tw.close / assets.tw.analysis.latest.ma20) - 1) * 100, 2) : null, trend: assets.tw.analysis?.latest?.close > assets.tw.analysis?.latest?.ma20 ? "risk-on" : "defensive", sourceUrl: assets.tw.sourceUrls?.yahoo || assets.tw.sourceUrls?.twse || null } : null, "\u5224\u65b7\u53f0\u80a1\u958b\u76e4\u98a8\u96aa\u504f\u597d\uff0c\u91cd\u9ede\u770b\u662f\u5426\u7ad9\u7a69 20MA \u8207\u6210\u4ea4\u503c\u6709\u6c92\u6709\u653e\u5927\u3002"),
    macroAssetRow("\u7f8e\u80a1", assets.spx, "\u7f8e\u80a1\u662f\u53f0\u80a1\u76e4\u524d\u60c5\u7dd2\u7684\u6838\u5fc3\u53c3\u8003\uff1bS&P 500 \u8207 Nasdaq ETF \u540c\u5411\u504f\u5f37\u6642\uff0c\u53f0\u80a1\u96fb\u5b50\u6b0a\u503c\u8f03\u5bb9\u6613\u6709\u627f\u63a5\u8cb7\u76e4\u3002"),
    macroAssetRow("Nasdaq / ETF", assets.qqq, "\u4ee3\u8868\u6210\u9577\u80a1\u8207 AI \u79d1\u6280\u80a1\u98a8\u96aa\u504f\u597d\uff1b\u82e5\u8f49\u5f31\uff0cAI \u4f3a\u670d\u5668\u8207\u534a\u5c0e\u9ad4\u8ffd\u50f9\u8981\u964d\u7d1a\u3002"),
    macroAssetRow("\u7f8e\u50b5 / \u5229\u7387", assets.ust10y, "\u7f8e\u50b5\u6b96\u5229\u7387\u4e0a\u884c\u901a\u5e38\u58d3\u6291\u9ad8\u4f30\u503c\u6210\u9577\u80a1\uff1b\u56de\u843d\u5247\u6709\u5229\u8cc7\u91d1\u56de\u6d41\u98a8\u96aa\u8cc7\u7522\u3002", true),
    macroAssetRow("\u532f\u7387 / USD-TWD", assets.fx, "\u7f8e\u5143\u5c0d\u65b0\u53f0\u5e63\u8d70\u5f37\u6642\uff0c\u5916\u8cc7\u8cb7\u76e4\u901a\u5e38\u8f03\u4fdd\u5b88\uff1b\u65b0\u53f0\u5e63\u8f49\u5f37\u5247\u6709\u5229\u5916\u8cc7\u98a8\u96aa\u504f\u597d\u3002", true),
    macroAssetRow("\u80fd\u6e90 / \u539f\u6cb9", assets.oil, "\u539f\u6cb9\u4e0a\u884c\u6703\u63d0\u9ad8\u901a\u81a8\u8207\u904b\u8f38\u6210\u672c\u654f\u611f\u5ea6\uff1b\u80fd\u6e90\u80a1\u53ef\u80fd\u53d7\u60e0\uff0c\u4f46\u5927\u76e4\u4f30\u503c\u53ef\u80fd\u627f\u58d3\u3002"),
    macroAssetRow("\u8cb4\u91d1\u5c6c / \u9ec3\u91d1", assets.gold, "\u9ec3\u91d1\u8f49\u5f37\u901a\u5e38\u4ee3\u8868\u964d\u606f\u9810\u671f\u6216\u907f\u96aa\u9700\u6c42\u5347\u6eab\uff1b\u9700\u540c\u6642\u770b\u7f8e\u50b5\u8207\u7f8e\u5143\u3002"),
    macroAssetRow("\u52a0\u5bc6\u8ca8\u5e63", assets.crypto, "\u6bd4\u7279\u5e63\u53ef\u4f5c\u70ba\u9ad8\u98a8\u96aa\u8cc7\u7522\u60c5\u7dd2\u6307\u6a19\uff1b\u504f\u5f37\u4e0d\u7b49\u65bc\u53f0\u80a1\u6703\u6f32\uff0c\u4f46\u53ef\u8f14\u52a9\u5224\u65b7\u6295\u6a5f\u98a8\u96aa\u504f\u597d\u3002"),
    macroAssetRow("\u534a\u5c0e\u9ad4 / \u53f0\u7a4d\u96fb", assets.tsmc ? { close: assets.tsmc.close, date: assets.tsmc.quoteDate, changePct20: assets.tsmc.analysis?.latest?.ma20 ? round(((assets.tsmc.close / assets.tsmc.analysis.latest.ma20) - 1) * 100, 2) : null, trend: assets.tsmc.analysis?.latest?.close > assets.tsmc.analysis?.latest?.ma20 ? "risk-on" : "defensive", sourceUrl: assets.tsmc.sourceUrls?.yahoo || assets.tsmc.sourceUrls?.twse || null } : null, "\u53f0\u80a1\u96fb\u5b50\u6b0a\u503c\u8207 AI \u4f9b\u61c9\u93c8\u7684\u6838\u5fc3 proxy\uff1b\u82e5\u5f37\u65bc\u5927\u76e4\uff0c\u4e3b\u984c\u80a1\u8f03\u5bb9\u6613\u64f4\u6563\u3002"),
  ];
  const riskAssets = assetRadar.filter(item => item.status === "\u504f\u98a8\u96aa").map(item => item.name);
  const supportiveAssets = assetRadar.filter(item => item.status === "\u504f\u6b63\u5411").map(item => item.name);
  const leadingNewsEvidence = newsEvidence(highItems.length ? highItems : items, 2);
  const marketStatusEvidence = [
    supportiveAssets.length ? `\u8de8\u8cc7\u7522\u652f\u6490\uff1a${supportiveAssets.slice(0, 3).join("\u3001")}` : "",
    riskAssets.length ? `\u9700\u9632\u5b88\uff1a${riskAssets.slice(0, 3).join("\u3001")}` : "",
    dominantTopics.length ? `\u65b0\u805e\u8a0e\u8ad6\u96c6\u4e2d\u5728\uff1a${dominantTopics.join("\u3001")}` : "",
    leadingNewsEvidence.length ? `\u4e3b\u8981\u4f86\u6e90\uff1a${leadingNewsEvidence.join("\uff1b")}` : "",
  ].filter(Boolean);
  const marketReasons = [
    supportiveAssets.length ? `\u8de8\u8cc7\u7522\u8a0a\u865f\u4e2d\uff0c${supportiveAssets.slice(0, 3).join("\u3001")} \u504f\u6b63\u5411\uff0c\u6240\u4ee5\u4e0d\u5c6c\u65bc\u7d14\u9632\u5b88\u76e4\u3002` : "\u76ee\u524d\u6c92\u6709\u5927\u91cf\u8cc7\u7522\u540c\u6b65\u986f\u793a\u98a8\u96aa\u504f\u597d\uff0c\u958b\u76e4\u61c9\u4fdd\u7559\u89c0\u5bdf\u7a7a\u9593\u3002",
    riskAssets.length ? `${riskAssets.slice(0, 3).join("\u3001")} \u540c\u6642\u504f\u98a8\u96aa\uff0c\u8868\u793a\u5e02\u5834\u4e0d\u662f\u5168\u9762\u8ffd\u50f9\u74b0\u5883\u3002` : "\u8de8\u8cc7\u7522\u98a8\u96aa\u8a0a\u865f\u6682\u4e0d\u6975\u7aef\uff0c\u53ef\u4ee5\u4ee5\u91cf\u50f9\u8207\u4e3b\u984c\u5ef6\u7e8c\u4f5c\u7b2c\u4e00\u5c64\u5224\u8b80\u3002",
    rankedTopics.length ? `\u65b0\u805e\u8a0e\u8ad6\u5bc6\u5ea6\u6700\u9ad8\u7684\u4e3b\u8ef8\u662f ${dominantTopics.join("\u3001")}\uff0c\u4e0d\u662f\u5c07\u6240\u6709\u91d1\u878d\u9805\u76ee\u4e00\u6b21\u5217\u51fa\u3002` : "\u65b0\u805e\u6d41\u4e2d\u9ad8\u91cd\u8981\u5ea6\u8a0a\u865f\u4e0d\u591a\uff0c\u4eca\u65e5\u66f4\u9700\u56de\u5230\u5831\u50f9\u8207\u6210\u4ea4\u503c\u78ba\u8a8d\u3002",
    leadingNewsEvidence.length ? `\u53ef\u5c0d\u7167\u65b0\u805e\u4f86\u6e90\uff1a${leadingNewsEvidence.join("\uff1b")}\u3002` : "\u672c\u6b21\u672a\u6709\u8db3\u5920\u7684\u9ad8\u91cd\u8981\u65b0\u805e\u53ef\u4f5c\u70ba\u5f37\u8b49\u64da\u3002",
  ];
  const marketConclusion = riskScore >= 72
    ? `\u76e4\u524d\u5e02\u5834\u72c0\u614b\uff1a\u5168\u7403\u98a8\u96aa\u504f\u597d\u504f\u5f37\u3002\u5224\u65b7\u4f86\u81ea ${marketStatusEvidence.slice(0, 3).join("\uff1b") || "\u8de8\u8cc7\u7522\u8207\u65b0\u805e\u7d9c\u5408\u8a0a\u865f"}\u3002`
    : riskScore >= 56
      ? `\u76e4\u524d\u5e02\u5834\u72c0\u614b\uff1a\u9078\u64c7\u6027\u504f\u591a\uff0c\u4e0d\u662f\u5168\u9762\u8ffd\u50f9\u76e4\u3002\u539f\u56e0\u662f ${marketStatusEvidence.slice(0, 3).join("\uff1b") || "\u652f\u6490\u8207\u98a8\u96aa\u8a0a\u865f\u540c\u6642\u5b58\u5728"}\u3002`
      : riskScore >= 42
        ? `\u76e4\u524d\u5e02\u5834\u72c0\u614b\uff1a\u5340\u9593\u76e4\u6216\u8f2a\u52d5\u76e4\u6a5f\u7387\u8f03\u9ad8\u3002\u4e3b\u56e0\u662f ${marketStatusEvidence.slice(0, 3).join("\uff1b") || "\u5e02\u5834\u8a0e\u8ad6\u5206\u6563\u4e14\u8cc7\u7522\u8a0a\u865f\u672a\u540c\u6b65"}\u3002`
        : `\u76e4\u524d\u5e02\u5834\u72c0\u614b\uff1a\u504f\u9632\u5b88\u3002\u4e3b\u8981\u4f86\u81ea ${marketStatusEvidence.slice(0, 3).join("\uff1b") || "\u98a8\u96aa\u8cc7\u7522\u548c\u65b0\u805e\u8a0a\u865f\u4e0d\u652f\u6301\u653e\u5927\u90e8\u4f4d"}\u3002`;
  const allMarketFocus = [
    {
      title: "\u80a1\u5e02\u8207 ETF",
      topics: ["\u53f0\u80a1", "\u7f8e\u80a1", "ETF", "\u534a\u5c0e\u9ad4"],
      body: topicTitles(items, "\u53f0\u80a1", 1)[0] || topicTitles(items, "\u7f8e\u80a1", 1)[0] || "\u76e4\u524d\u5148\u770b\u53f0\u80a1 ETF\u3001\u96fb\u5b50\u6b0a\u503c\u8207\u7f8e\u80a1\u6307\u6578\u662f\u5426\u540c\u6b65\u3002",
      watch: "\u82e5\u53f0\u80a1\u958b\u9ad8\u4f46\u6210\u4ea4\u503c\u6c92\u6709\u653e\u5927\uff0c\u5f37\u52e2\u80a1\u61c9\u964d\u4f4e\u8ffd\u50f9\u6b0a\u91cd\u3002",
    },
    {
      title: "\u5229\u7387\u3001\u7f8e\u50b5\u8207\u532f\u7387",
      topics: ["\u7f8e\u50b5\u8207\u5229\u7387", "\u532f\u7387"],
      body: topicTitles(items, "\u7f8e\u50b5\u8207\u5229\u7387", 1)[0] || topicTitles(items, "\u532f\u7387", 1)[0] || "\u7f8e\u50b5\u6b96\u5229\u7387\u8207 USD/TWD \u662f\u5224\u65b7\u5916\u8cc7\u98a8\u96aa\u504f\u597d\u7684\u4e3b\u8ef8\u3002",
      watch: "\u82e5\u6b96\u5229\u7387\u8207\u7f8e\u5143\u540c\u6b65\u8d70\u5f37\uff0c\u9ad8\u4f30\u503c\u6210\u9577\u80a1\u7684\u8ffd\u50f9\u689d\u4ef6\u8981\u66f4\u56b4\u683c\u3002",
    },
    {
      title: "\u80fd\u6e90\u3001\u8cb4\u91d1\u5c6c\u8207\u901a\u81a8",
      topics: ["\u80fd\u6e90\u8207\u8cb4\u91d1\u5c6c"],
      body: topicTitles(items, "\u80fd\u6e90\u8207\u8cb4\u91d1\u5c6c", 1)[0] || "\u539f\u6cb9\u3001\u9ec3\u91d1\u8207\u9285\u50f9\u7528\u4f86\u89c0\u5bdf\u901a\u81a8\u58d3\u529b\u3001\u907f\u96aa\u9700\u6c42\u8207\u666f\u6c23\u5faa\u74b0\u3002",
      watch: "\u82e5\u539f\u6cb9\u6025\u6f32\u4f46\u9ec3\u91d1\u4e5f\u8f49\u5f37\uff0c\u8868\u793a\u5e02\u5834\u53ef\u80fd\u540c\u6642\u64d4\u5fc3\u901a\u81a8\u8207\u98a8\u96aa\u4e8b\u4ef6\u3002",
    },
    {
      title: "\u52a0\u5bc6\u8ca8\u5e63\u8207\u6295\u6a5f\u98a8\u96aa",
      topics: ["\u52a0\u5bc6\u8ca8\u5e63"],
      body: topicTitles(items, "\u52a0\u5bc6\u8ca8\u5e63", 1)[0] || "\u6bd4\u7279\u5e63\u8207\u52a0\u5bc6 ETF \u7528\u4f86\u88dc\u5145\u5224\u65b7\u6295\u6a5f\u60c5\u7dd2\uff0c\u4e0d\u55ae\u7368\u4f5c\u70ba\u53f0\u80a1\u8cb7\u8ce3\u8a0a\u865f\u3002",
      watch: "\u82e5\u52a0\u5bc6\u8ca8\u5e63\u8f49\u5f31\u4f46\u7f8e\u80a1\u4ecd\u5f37\uff0c\u4ee3\u8868\u98a8\u96aa\u504f\u597d\u6c92\u6709\u5168\u9762\u64f4\u6563\uff0c\u5009\u4f4d\u61c9\u4fdd\u5b88\u3002",
    },
    {
      title: "\u671f\u8ca8\u3001\u9078\u64c7\u6b0a\u8207\u6ce2\u52d5\u7387",
      topics: ["\u671f\u8ca8\u8207\u9078\u64c7\u6b0a"],
      body: topicTitles(items, "\u671f\u8ca8\u8207\u9078\u64c7\u6b0a", 1)[0] || "\u671f\u8ca8\u6b63\u9006\u50f9\u5dee\u3001\u9078\u64c7\u6b0a\u672a\u5e73\u5009\u8207 VIX \u53ef\u8f14\u52a9\u5224\u65b7\u958b\u76e4\u8ffd\u50f9\u98a8\u96aa\u3002",
      watch: "\u82e5\u671f\u8ca8\u958b\u9ad8\u4f46\u9078\u64c7\u6b0a\u907f\u96aa\u90e8\u4f4d\u589e\u52a0\uff0c\u8ffd\u50f9\u4e0d\u61c9\u653e\u5927\u90e8\u4f4d\u3002",
    },
    {
      title: "\u7e3d\u7d93\u65e5\u66c6",
      topics: ["\u7e3d\u7d93\u65e5\u66c6"],
      body: topicTitles(items, "\u7e3d\u7d93\u65e5\u66c6", 1)[0] || "\u76e4\u524d\u9700\u7559\u610f CPI\u3001PCE\u3001FOMC\u3001\u975e\u8fb2\u5c31\u696d\u3001\u53f0\u7063\u5916\u92b7\u8a02\u55ae\u8207\u51fa\u53e3\u6578\u64da\u3002",
      watch: "\u82e5\u91cd\u8981\u6578\u64da\u516c\u5e03\u524d\u5e02\u5834\u5df2\u5927\u6f32\uff0c\u61c9\u6e1b\u5c11\u76e4\u4e2d\u8ffd\u9ad8\uff0c\u7b49\u6578\u64da\u843d\u5730\u5f8c\u518d\u8a55\u4f30\u3002",
    },
  ];
  const selectedFocus = allMarketFocus.filter(item => item.topics.some(topic => dominantTopics.includes(topic)));
  const marketFocus = (selectedFocus.length ? selectedFocus : allMarketFocus).slice(0, 3);
  const keyObservations = [
    {
      indicator: "\u7f8e\u80a1 / Nasdaq ETF / \u53f0\u80a1\u958b\u76e4\u6210\u4ea4\u503c",
      watch: "\u770b\u7f8e\u80a1\u548c Nasdaq ETF \u662f\u5426\u5ef6\u7e8c\u8d70\u5f37\uff0c\u518d\u5c0d\u7167\u53f0\u80a1\u958b\u76e4 30-60 \u5206\u9418\u6210\u4ea4\u503c\u6709\u6c92\u6709\u653e\u5927\u3002",
      sentiment: "\u82e5\u7f8e\u80a1\u5f37\u4e14\u53f0\u80a1\u653e\u91cf\uff0c\u60c5\u7dd2\u504f\u98a8\u96aa\u504f\u597d\uff1b\u82e5\u958b\u9ad8\u91cf\u7e2e\uff0c\u60c5\u7dd2\u5bb9\u6613\u8f49\u6210\u89c0\u671b\u6216\u7372\u5229\u4e86\u7d50\u3002",
      market: "\u653e\u91cf\u6642\u4e3b\u984c\u80a1\u8f03\u5bb9\u6613\u64f4\u6563\uff1b\u91cf\u7e2e\u6642\u5bb9\u6613\u51fa\u73fe\u6307\u6578\u5f37\u3001\u500b\u80a1\u8ffd\u9ad8\u56de\u843d\u3002",
      institutions: "\u5916\u8cc7\u8207\u6295\u4fe1\u901a\u5e38\u6703\u5148\u52a0\u78bc\u6d41\u52d5\u6027\u6700\u597d\u7684\u6b0a\u503c\u80a1\u3001ETF \u6216\u4e3b\u984c\u9f8d\u982d\u3002",
      policy: "\u653f\u5e9c\u901a\u5e38\u4e0d\u6703\u5c0d\u55ae\u65e5\u8d70\u52e2\u8868\u614b\uff0c\u4f46\u82e5\u6ce2\u52d5\u653e\u5927\uff0c\u9700\u7559\u610f\u4ea4\u6613\u6240\u3001\u91d1\u7ba1\u6703\u6216\u592e\u884c\u5c0d\u5e02\u5834\u7a69\u5b9a\u7684\u8aaa\u660e\u3002",
      summary: "\u5148\u770b\u7f8e\u80a1\u548c Nasdaq ETF\uff0c\u518d\u78ba\u8a8d\u53f0\u80a1\u958b\u76e4\u6210\u4ea4\u503c\u662f\u5426\u653e\u5927\u3002",
    },
    {
      indicator: "\u7f8e\u50b5\u6b96\u5229\u7387 / USD-TWD / \u5916\u8cc7\u8cb7\u8ce3\u8d85",
      watch: "\u770b\u7f8e\u50b5\u6b96\u5229\u7387\u662f\u5426\u4e0a\u884c\uff0cUSD/TWD \u662f\u5426\u8d70\u5f37\uff0c\u4ee5\u53ca\u53f0\u80a1\u5916\u8cc7\u662f\u5426\u7e7c\u7e8c\u8cb7\u8d85\u3002",
      sentiment: "\u82e5\u5229\u7387\u548c\u7f8e\u5143\u540c\u6b65\u8d70\u5f37\uff0c\u5e02\u5834\u5c0d\u9ad8\u4f30\u503c\u6210\u9577\u80a1\u6703\u66f4\u8b39\u614e\uff1b\u82e5\u56de\u843d\uff0c\u98a8\u96aa\u504f\u597d\u6703\u6539\u5584\u3002",
      market: "\u5229\u7387\u58d3\u529b\u4e0a\u5347\u6642\uff0c\u9ad8 PE\u3001\u9ad8\u4e56\u96e2\u80a1\u6613\u5148\u4fee\u6b63\uff1b\u5229\u7387\u56de\u843d\u6642\uff0c\u96fb\u5b50\u6210\u9577\u80a1\u8f03\u5bb9\u6613\u91cd\u65b0\u8a55\u50f9\u3002",
      institutions: "\u5916\u8cc7\u53ef\u80fd\u964d\u4f4e\u6b0a\u503c\u96fb\u5b50\u90e8\u4f4d\uff1b\u6295\u4fe1\u5247\u53ef\u80fd\u8f49\u5411\u73fe\u91d1\u6d41\u7a69\u5b9a\u6216\u9ad8\u6b96\u5229\u7387\u65cf\u7fa4\u3002",
      policy: "\u82e5\u532f\u7387\u6ce2\u52d5\u904e\u5927\uff0c\u8981\u7559\u610f\u592e\u884c\u5c0d\u532f\u5e02\u7a69\u5b9a\u7684\u8a0a\u606f\uff1b\u82e5\u8cc7\u91d1\u5927\u5e45\u5916\u6d41\uff0c\u91d1\u7ba1\u6703\u53ef\u80fd\u5f37\u8abf\u5e02\u5834\u98a8\u96aa\u63a7\u7ba1\u3002",
      summary: "\u7f8e\u50b5\u548c\u532f\u7387\u662f\u5224\u65b7\u5916\u8cc7\u98a8\u96aa\u504f\u597d\u7684\u7b2c\u4e8c\u5c64\u6307\u6a19\u3002",
    },
    {
      indicator: `${marketFocus[0]?.title || "\u4eca\u65e5\u4e3b\u8ef8"} / \u65b0\u805e\u8a0e\u8ad6\u5bc6\u5ea6 / 20MA \u7d50\u69cb`,
      watch: "\u770b\u4eca\u65e5\u65b0\u805e\u8a0e\u8ad6\u6700\u96c6\u4e2d\u7684\u4e3b\u8ef8\uff0c\u662f\u5426\u540c\u6642\u6709\u6210\u4ea4\u503c\u300120MA \u4e0a\u5f4e\u548c\u984c\u6750\u64f4\u6563\u914d\u5408\u3002",
      sentiment: "\u82e5\u65b0\u805e\u71b1\u5ea6\u548c\u6280\u8853\u7d50\u69cb\u540c\u6b65\uff0c\u5e02\u5834\u6703\u66f4\u9858\u610f\u8ffd\u9010\u9818\u6f32\u4e3b\u984c\uff1b\u82e5\u53ea\u6709\u65b0\u805e\u6c92\u6709\u91cf\u50f9\uff0c\u60c5\u7dd2\u5bb9\u6613\u9000\u56de\u89c0\u671b\u3002",
      market: "\u540c\u6b65\u6642\u4e3b\u984c\u80a1\u6703\u64f4\u6563\u5230\u7b2c\u4e8c\u7dda\u6a19\u7684\uff1b\u4e0d\u540c\u6b65\u6642\u5e38\u898b\u9f8d\u982d\u6490\u76e4\u3001\u5f8c\u6392\u8ffd\u9ad8\u5931\u6557\u3002",
      institutions: "\u6a5f\u69cb\u901a\u5e38\u6703\u5148\u9078\u6d41\u52d5\u6027\u8db3\u3001\u8ca1\u5831\u53ef\u9a57\u8b49\u3001\u984c\u6750\u6709\u57fa\u672c\u9762\u652f\u6490\u7684\u6a19\u7684\u3002",
      policy: "\u82e5\u4e3b\u8ef8\u6d89\u53ca\u653f\u7b56\u7522\u696d\uff0c\u9700\u7559\u610f\u884c\u653f\u9662\u3001\u7d93\u6fdf\u90e8\u3001\u570b\u767c\u6703\u6216\u4ea4\u6613\u6240\u5c0d\u7522\u696d\u8207\u5e02\u5834\u98a8\u96aa\u7684\u8aaa\u660e\u3002",
      summary: "\u628a\u4eca\u65e5\u65b0\u805e\u4e3b\u8ef8\u548c\u6210\u4ea4\u503c\u300120MA \u7d50\u69cb\u5c0d\u8d77\u4f86\uff0c\u624d\u5224\u65b7\u80fd\u4e0d\u80fd\u9032\u5165\u9078\u80a1\u3002",
    },
  ];
  const today = new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
  return {
    title: `\u53f0\u7063\u76e4\u524d\u7e3d\u7d93\u7b56\u7565\u5831\u544a\uff5c${today} \u53f0\u7063\u6642\u9593`,
    onePage: {
      marketTheme: marketFocus.map(item => item.title).join("\u3001"),
      marketThemeReason: dominantTopics.length ? `\u4f9d\u65b0\u805e\u8a0e\u8ad6\u5bc6\u5ea6\u548c\u91cd\u8981\u5ea6\uff0c\u4eca\u65e5\u512a\u5148\u770b ${dominantTopics.slice(0, 3).join("\u3001")}\u3002` : "\u65b0\u805e\u8a0e\u8ad6\u5c1a\u672a\u5f62\u6210\u55ae\u4e00\u4e3b\u8ef8\uff0c\u5148\u4ee5\u8de8\u8cc7\u7522\u8a0a\u865f\u5224\u65b7\u3002",
      riskTemperature: `${labelZh} / ${riskScore}`,
      keyWatch: keyObservations[0].summary,
      portfolioImpact: "\u9019\u500b\u5340\u584a\u53ea\u5b9a\u7fa9\u76e4\u524d\u5e02\u5834\u74b0\u5883\uff0c\u5f8c\u7e8c\u9078\u80a1\u4ecd\u9700\u56de\u5230\u6210\u4ea4\u503c\u300120MA\u3001\u5931\u6548\u7dda\u8207\u500b\u80a1\u8cc7\u6599\u3002",
    },
    reasoning: {
      marketConclusion,
      marketReasons,
      marketFocus,
      keyObservations,
      keyNews: highItems.slice(0, 3).map((item: any) => ({
        topic: item.topic,
        title: item.title,
        conclusion: item.conclusion,
        reason: item.reason,
      })),
    },
    annotations: [],
    assetRadar,
    crossAssetPulse: assetRadar.map(item => ({ name: item.name, view: item.status, evidence: [item.interpretation] })),
    scenarios: [
      { name: "\u958b\u76e4\u504f\u591a", view: "\u7f8e\u80a1\u8207 Nasdaq ETF \u5f37\u3001USD/TWD \u4e0d\u6025\u5347\u3001\u53f0\u80a1\u958b\u76e4\u6210\u4ea4\u503c\u653e\u5927\uff1a\u53ef\u7528\u5c0f\u90e8\u4f4d\u505a\u5f37\u52e2\u4e3b\u984c\u3002" },
      { name: "\u958b\u76e4\u9707\u76ea", view: "\u6307\u6578\u958b\u9ad8\u4f46\u532f\u7387\u8207\u7f8e\u50b5\u4e0d\u914d\u5408\uff1a\u5148\u770b 30-60 \u5206\u9418\u6210\u4ea4\u503c\u8207\u9818\u6f32\u80a1\u662f\u5426\u64f4\u6563\u3002" },
      { name: "\u98a8\u96aa\u964d\u6eab", view: "\u7f8e\u80a1\u8f49\u5f31\u3001\u7f8e\u50b5/\u7f8e\u5143\u540c\u6b65\u58d3\u529b\u4e0a\u5347\uff1a\u964d\u4f4e\u8ffd\u50f9\uff0c\u53ea\u4fdd\u7559\u4f4e\u4e56\u96e2\u8207\u652f\u6490\u660e\u78ba\u6a19\u7684\u3002" },
    ],
    watchList: keyObservations,
    sourceUrls: assetRadar.map(item => ({ name: item.name, url: item.sourceUrl })).filter(item => item.url),
  };
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

function parseSwingCodes(value: unknown, fallback: string[] = []) {
  const raw = String(value || "").trim();
  const codes = raw
    ? raw.split(/[,\s]+/).map(cleanCode).filter(code => /^\d{4,6}$/.test(code))
    : fallback;
  return [...new Set(codes)].slice(0, 6);
}

function swingGroup(code: string) {
  return TAIWAN_SCREENING_UNIVERSE.find(item => item.code === code)?.group || "unclassified";
}

function swingSetupType(snapshot: ValueScore["technicalSnapshot"]) {
  const latest = snapshot.latest;
  const close = latest.close;
  if (close > latest.ma20 && latest.ma20 > latest.ma60 && latest.pullback < 62) return "20MA \u7e8c\u822a\u6ce2\u6bb5";
  if (close > latest.ma60 && close <= latest.ma20 * 1.03) return "\u56de\u6e2c 20MA \u89c0\u5bdf";
  if (close > snapshot.levels.resistanceShort * 0.98 && latest.volumeRatio >= 1.2) return "\u7a81\u7834\u58d3\u529b\u78ba\u8a8d";
  if (latest.pullback >= 72) return "\u904e\u71b1\u7b49\u5f85\u56de\u6a94";
  return "\u5340\u9593\u6574\u7406\u89c0\u5bdf";
}

function swingSetupDetail(snapshot: ValueScore["technicalSnapshot"]) {
  const latest = snapshot.latest;
  const close = latest.close;
  const distance20 = latest.ma20 ? ((close / latest.ma20) - 1) * 100 : null;
  const distance20Text = Number.isFinite(distance20) ? fmt(distance20 as number, 1) : "--";
  if (close > latest.ma20 && latest.ma20 > latest.ma60 && latest.pullback < 62) {
    return `20MA \u7e8c\u822a\uff1a\u6536\u76e4\u5728 20MA \u4e0a\u65b9\u4e14 20MA \u9ad8\u65bc 60MA\uff0c\u5c6c\u65bc 1-3 \u500b\u6708\u8da8\u52e2\u7e8c\u822a\u5019\u9078\uff1b\u82e5\u96e2 20MA ${distance20Text}% \u904e\u9060\uff0c\u61c9\u7b49\u56de\u6e2c\u6216\u653e\u91cf\u7a81\u7834\u78ba\u8a8d\u3002`;
  }
  if (close > latest.ma60 && close <= latest.ma20 * 1.03) {
    return `\u56de\u6e2c\u89c0\u5bdf\uff1a\u50f9\u683c\u9760\u8fd1 20MA\uff0c\u5c6c\u65bc\u7b49\u652f\u6490\u7684\u4f4d\u7f6e\uff1b\u82e5\u5b88\u4f4f 20MA \u4e26\u91cf\u80fd\u4e0d\u5931\u63a7\uff0c\u624d\u4fdd\u7559\u7e8c\u6f32\u5047\u8a2d\u3002`;
  }
  if (close > snapshot.levels.resistanceShort * 0.98 && latest.volumeRatio >= 1.2) {
    return `\u7e7c\u7e8c\u7e8c\u6f32/\u7a81\u7834\u78ba\u8a8d\uff1a\u50f9\u683c\u63a5\u8fd1\u77ed\u58d3\u6216\u5df2\u7a81\u7834\uff0c\u4e14\u91cf\u80fd\u6709\u653e\u5927\uff1b\u9069\u5408\u89c0\u5bdf\u662f\u5426\u7ad9\u7a69\u58d3\u529b\u8f49\u652f\u6490\u3002`;
  }
  if (latest.pullback >= 72) {
    return `\u904e\u71b1\u7b49\u56de\u6a94\uff1aRSI/\u4e56\u96e2\u6216\u6ce2\u52d5\u5df2\u504f\u9ad8\uff0c\u76f4\u63a5\u8ffd\u50f9\u7684\u505c\u640d\u8ddd\u96e2\u6703\u8b8a\u5927\uff1b\u512a\u5148\u7b49\u56de\u6e2c 20MA \u6216\u91cf\u7e2e\u6574\u7406\u3002`;
  }
  if (close < latest.ma20 && latest.ma20 < latest.ma60) {
    return `\u504f\u7a7a\u89c0\u5bdf\uff1a\u50f9\u683c\u5728 20MA \u4e0b\u65b9\u4e14 20MA \u4f4e\u65bc 60MA\uff0c\u4e0d\u9069\u5408\u7576\u4f5c\u512a\u5148\u6ce2\u6bb5\u5019\u9078\uff0c\u9700\u7b49\u6536\u56de 20MA \u518d\u8a55\u4f30\u3002`;
  }
  return `\u5340\u9593\u6574\u7406\uff1a\u8da8\u52e2\u689d\u4ef6\u5c1a\u672a\u5b8c\u5168\u6210\u7acb\uff0c\u9069\u5408\u5148\u770b\u58d3\u529b\u8207\u652f\u6490\u662f\u5426\u6536\u6582\uff1b\u7a81\u7834\u9700\u6709\u6210\u4ea4\u503c\u914d\u5408\u3002`;
}

function swingTechnicalScore(item: ValueScore) {
  const latest = item.technicalSnapshot.latest;
  let score = 35;
  if (latest.close > latest.ma20) score += 14;
  if (latest.ma20 > latest.ma60) score += 14;
  if (latest.close > latest.ma120) score += 8;
  if (latest.rsi14 >= 50 && latest.rsi14 <= 68) score += 10;
  if (latest.rsi14 > 74) score -= 10;
  if (latest.volumeRatio >= 1.1 && latest.volumeRatio <= 1.8) score += 8;
  if (latest.pullback >= 72) score -= 16;
  if (latest.close > item.technicalSnapshot.levels.resistanceShort * 0.98) score += 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function swingThemeFitScore(item: ValueScore) {
  const group = swingGroup(item.code);
  if (/semiconductor|server|electronics|industrial computer|optics/i.test(group)) return 88;
  if (/financial|telecom|consumer/i.test(group)) return 68;
  if (/materials|plastics|steel|shipping|petrochemical/i.test(group)) return 54;
  if (/ETF/i.test(group)) return 48;
  return 60;
}

function companyThemeDetail(code: string, group = "") {
  if (COMPANY_THEME_DETAILS[code]) return COMPANY_THEME_DETAILS[code];
  if (/semiconductor/i.test(group)) return "\u534a\u5c0e\u9ad4\u4f9b\u61c9\u93c8\uff1b\u9700\u8ffd\u8e64\u6676\u7247\u9700\u6c42\u3001\u5eab\u5b58\u5faa\u74b0\u8207 AI/HPC \u984c\u6750\u3002";
  if (/server|electronics|industrial computer/i.test(group)) return "\u96fb\u5b50\u88fd\u9020\u6216\u4f3a\u670d\u5668\u4f9b\u61c9\u93c8\uff1b\u91cd\u9ede\u770b AI \u4f3a\u670d\u5668\u3001PC/AI PC \u8207\u6210\u4ea4\u503c\u3002";
  if (/financial/i.test(group)) return "\u91d1\u878d\u80a1\uff1b\u91cd\u9ede\u770b\u5229\u7387\u3001\u6b96\u5229\u7387\u8207\u6cd5\u4eba\u6301\u7e8c\u6027\u3002";
  if (/shipping/i.test(group)) return "\u822a\u904b\u80a1\uff1b\u91cd\u9ede\u770b\u904b\u50f9\u3001\u666f\u6c23\u5faa\u74b0\u8207\u6210\u4ea4\u91cf\u8f49\u6298\u3002";
  if (/ETF/i.test(group)) return "ETF \u5546\u54c1\uff1b\u53ea\u5217\u70ba\u5927\u76e4/\u6d41\u52d5\u6027\u53c3\u8003\uff0c\u4e0d\u7576\u4f5c\u500b\u80a1\u984c\u6750\u3002";
  return "\u516c\u53f8\u984c\u6750\u5c1a\u672a\u5efa\u7acb\u7d30\u5206\u6a19\u7c64\uff1b\u5148\u4ee5\u7522\u696d\u5225\u3001\u6210\u4ea4\u503c\u8207 20MA \u7d50\u69cb\u5224\u8b80\u3002";
}

function scoreTradingValue(value100m: number | null) {
  if (value100m === null || !Number.isFinite(value100m)) return 35;
  if (value100m >= 80) return 95;
  if (value100m >= 30) return 84;
  if (value100m >= 10) return 72;
  if (value100m >= 3) return 58;
  return 42;
}

function scoreCloseVs20Ma(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 35;
  if (value >= 0 && value <= 6) return 92;
  if (value > 6 && value <= 12) return 76;
  if (value > 12) return 48;
  if (value >= -3) return 62;
  return 35;
}

function scoreMa20Slope(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 35;
  if (value >= 3) return 92;
  if (value >= 1) return 80;
  if (value >= 0) return 66;
  if (value >= -1) return 48;
  return 30;
}

function swingMainEvidence(closeVs20MaPct: number | null, ma20Slope5dPct: number | null, tradingValue100m: number | null) {
  const above20 = closeVs20MaPct !== null && Number.isFinite(closeVs20MaPct) && closeVs20MaPct >= 0;
  const rising20 = ma20Slope5dPct !== null && Number.isFinite(ma20Slope5dPct) && ma20Slope5dPct > 0;
  const near20 = closeVs20MaPct !== null && Number.isFinite(closeVs20MaPct) && closeVs20MaPct >= 0 && closeVs20MaPct <= 6;
  const highLiquidity = tradingValue100m !== null && Number.isFinite(tradingValue100m) && tradingValue100m >= 10;
  if (above20 && rising20 && near20) return highLiquidity
    ? "\u7ad9\u4e0a 20MA\uff0c\u5747\u7dda\u4e0a\u5347\uff1b\u4e14\u96e2 20MA \u4e0d\u9060\uff0c\u6210\u4ea4\u503c\u53ef\u7528\u3002"
    : "\u7ad9\u4e0a 20MA\uff0c\u5747\u7dda\u4e0a\u5347\uff1b\u4f46\u9700\u8907\u6838\u6d41\u52d5\u6027\u3002";
  if (above20 && rising20) return "\u6536\u76e4\u5728 20MA \u4e0a\u300120MA \u4e0a\u5347\uff1b\u4f46\u4e56\u96e2\u504f\u5927\uff0c\u4e0d\u9069\u5408\u76f4\u63a5\u8ffd\u9ad8\u3002";
  if (above20) return "\u6536\u76e4\u5728 20MA \u4e0a\uff0c\u4f46 20MA \u659c\u7387\u5c1a\u672a\u8f49\u5f37\uff0c\u5217\u70ba\u89c0\u5bdf\u3002";
  return "\u5c1a\u672a\u7ad9\u7a69 20MA\uff0c\u4e0d\u5217\u70ba\u512a\u5148\u8ffd\u8e64\uff0c\u9700\u7b49\u8da8\u52e2\u6536\u56de\u3002";
}

function swingThemeNote(item: any) {
  const group = swingGroup(item.code || "");
  return companyThemeDetail(item.code || "", group);
}

function swingLiquidityNote(item: any, candidate: any) {
  const trading = candidate?.sortKeys?.tradingValue100m;
  const close = candidate?.latestClose ?? item.close;
  const theme = swingThemeNote(item);
  if (Number.isFinite(close) && close >= 800) return `${theme}\uff1b\u9ad8\u50f9\u80a1\uff0c\u55ae\u7b46\u90e8\u4f4d\u98a8\u96aa\u8f03\u9ad8\uff0c\u9700\u540c\u6642\u6aa2\u67e5\u65e5\u6210\u4ea4\u503c\u8207\u96f6\u80a1\u6210\u4ea4\uff0c\u907f\u514d\u4e0d\u597d\u9032\u51fa\u3002`;
  if (Number.isFinite(trading) && trading >= 30) return `${theme}\uff1b\u6700\u65b0\u6210\u4ea4\u503c\u9ad8\uff0c\u9069\u5408\u5217\u5165\u6ce2\u6bb5\u6d41\u52d5\u6027\u5019\u9078\u3002`;
  if (Number.isFinite(trading) && trading >= 10) return `${theme}\uff1b\u6210\u4ea4\u503c\u4e2d\u9ad8\uff0c\u9700\u642d\u914d 20MA \u8207\u5931\u6548\u7dda\u78ba\u8a8d\u3002`;
  return `${theme}\uff1b\u6d41\u52d5\u6027\u504f\u4e2d\u7b49\uff0c\u8cc7\u91d1\u90e8\u4f4d\u9700\u4fdd\u5b88\u3002`;
}

function institutionalNetBuyText(totalNet: number | null | undefined, close: number | null | undefined) {
  if (!Number.isFinite(totalNet)) return "N/A";
  const shares = totalNet as number;
  const lots = round(shares / 1000, 0);
  const value100m = Number.isFinite(close) ? round((shares * (close as number)) / 100000000, 2) : null;
  const valueText = value100m !== null ? ` / ${fmt(value100m, 2)} \u5104\u4f30` : "";
  return `${fmt(lots, 0)} \u5f35${valueText}`;
}

function buildSwingCandidate(item: ValueScore, marketProxy: QuoteInfo | null = null, officialTrend: any = null) {
  const latest = item.technicalSnapshot.latest;
  const levels = item.technicalSnapshot.levels;
  const close = latest.close;
  const marketClose = marketProxy?.analysis.latest.close || null;
  const market20 = marketClose && marketProxy?.analysis.latest.ma20 ? ((marketClose / marketProxy.analysis.latest.ma20) - 1) * 100 : null;
  const stock20 = officialTrend?.closeVs20MaPct ?? (latest.ma20 ? ((close / latest.ma20) - 1) * 100 : null);
  const relativeStrength = stock20 !== null && market20 !== null ? round(stock20 - market20, 2) : null;
  const institutional = item.fundamentals?.data?.institutional;
  const revenue = item.fundamentals?.data?.revenue;
  const technical = swingTechnicalScore(item);
  const flowScore = Number.isFinite(institutional?.totalNet) ? ((institutional?.totalNet || 0) > 0 ? 12 : -8) : 0;
  const growthScore = Number.isFinite(revenue?.yoy) ? ((revenue?.yoy || 0) > 10 ? 12 : (revenue?.yoy || 0) > 0 ? 6 : -8) : 0;
  const rsScore = relativeStrength !== null ? (relativeStrength > 4 ? 10 : relativeStrength > 0 ? 5 : -6) : 0;
  const liquidityScore = Number.isFinite(item.volume) && (item.volume || 0) >= 500000 ? 8 : 0;
  const topicFit = swingThemeFitScore(item);
  const tradingValueScore = scoreTradingValue(officialTrend?.tradingValue100m ?? null);
  const closeVs20MaScore = scoreCloseVs20Ma(stock20);
  const ma20SlopeScore = scoreMa20Slope(officialTrend?.ma20Slope5dPct ?? null);
  const mainEvidence = swingMainEvidence(
    stock20 !== null && Number.isFinite(stock20) ? round(stock20, 2) : null,
    officialTrend?.ma20Slope5dPct ?? null,
    officialTrend?.tradingValue100m ?? null
  );
  const swingScore = Math.max(0, Math.min(100, Math.round(
    topicFit * 0.30 +
    tradingValueScore * 0.25 +
    closeVs20MaScore * 0.25 +
    ma20SlopeScore * 0.20 +
    Math.max(-8, Math.min(8, flowScore + growthScore + rsScore + liquidityScore))
  )));
  const invalidation = round(Math.min(levels.supportMid * 0.97, latest.ma60 * 0.98));
  const watchPriority = swingScore >= 76 ? "\u9ad8" : swingScore >= 62 ? "\u4e2d" : "\u4f4e";
  return {
    code: item.code,
    name: item.name,
    market: item.market,
    latestClose: item.close,
    latestDataDate: item.quoteDate,
    sector: swingGroup(item.code),
    setupType: swingSetupType(item.technicalSnapshot),
    setupDetail: swingSetupDetail(item.technicalSnapshot),
    swingScore,
    sortKeys: {
      topicFit,
      tradingValue100m: officialTrend?.tradingValue100m ?? null,
      tradingValueScore,
      closeVs20MaPct: stock20 !== null && Number.isFinite(stock20) ? round(stock20, 2) : null,
      closeVs20MaScore,
      ma20: officialTrend?.ma20 ?? latest.ma20,
      ma20FiveAgo: officialTrend?.ma20FiveAgo ?? null,
      ma20Slope5dPct: officialTrend?.ma20Slope5dPct ?? null,
      ma20SlopeScore,
      tradingValue3m100m: officialTrend?.tradingValue3m100m ?? null,
      rankingFormula: "\u4e3b\u984c\u5951\u5408\u5ea6 30% + \u6210\u4ea4\u503c 25% + \u6536\u76e4\u50f9\u76f8\u5c0d 20MA 25% + 20MA \u659c\u7387 20%",
      priceSource: officialTrend?.source || "Yahoo/TWSE \u5099\u63f4\u8cc7\u6599",
      priceSourceUrls: officialTrend?.sourceUrls || [],
    },
    watchPriority,
    primaryEvidence: [
      mainEvidence,
      `20MA ${fmt(officialTrend?.ma20 ?? latest.ma20)} / 60MA ${fmt(latest.ma60)}`,
      `RSI ${fmt(latest.rsi14, 1)}, \u56de\u6a94\u98a8\u96aa ${latest.pullback}%`,
      Number.isFinite(revenue?.yoy) ? `\u6708\u71df\u6536 YoY ${fmt(revenue?.yoy as number, 2)}%` : "\u6708\u71df\u6536\u52d5\u80fd\u7f3a\u8cc7\u6599",
      Number.isFinite(institutional?.totalNet) ? `\u8fd15\u65e5\u6cd5\u4eba\u5408\u8a08 ${fmt(institutional?.totalNet as number, 0)}` : "\u6cd5\u4eba\u8cc7\u6599\u7f3a\u8cc7\u6599",
    ],
    keyRisk: `\u8dcc\u7834 ${fmt(invalidation)} \u6216 MA20 ${fmt(latest.ma20)} \u7121\u6cd5\u6536\u56de\u6642\uff0c\u6ce2\u6bb5\u5047\u8a2d\u5931\u6548\u3002`,
    invalidationNote: `\u82e5\u6536\u76e4\u8dcc\u7834 ${fmt(invalidation)}\uff0c\u4ee3\u8868\u77ed\u7dda\u652f\u6490 ${fmt(levels.supportMid)} \u6216 60MA ${fmt(latest.ma60)} \u7d50\u69cb\u5df2\u5931\u5b88\uff1b\u82e5\u540c\u6642\u7121\u6cd5\u6536\u56de 20MA ${fmt(latest.ma20)}\uff0c1-3 \u500b\u6708\u6ce2\u6bb5\u5047\u8a2d\u61c9\u964d\u7d1a\u6216\u9000\u51fa\u89c0\u5bdf\u3002`,
    levels: {
      support: levels.supportShort,
      supportMid: levels.supportMid,
      resistance: levels.resistanceShort,
      resistanceMid: levels.resistanceMid,
      invalidation,
      target1: round(levels.resistanceShort * 1.04),
      target2: round(Math.max(levels.resistanceMid, latest.week52High) * 1.03),
    },
    signalHint: swingScore >= 76 && latest.pullback < 68 ? "\u504f\u591a\u5019\u9078" : latest.pullback >= 72 ? "\u89c0\u5bdf" : swingScore >= 58 ? "\u504f\u591a" : "\u907f\u958b",
  };
}

function rankRows<T>(items: T[], mapper: (item: T, index: number) => any) {
  return items.slice(0, 10).map((item, index) => ({ rank: index + 1, ...mapper(item, index) }));
}

function buildSwingThemeTables(candidates: any[], stockItems: ValueScore[]) {
  const byCode = new Map(stockItems.map(item => [item.code, item]));
  const itemFor = (candidate: any) => byCode.get(candidate.code) as any || candidate;
  const usable = candidates.filter(candidate => itemFor(candidate)?.professionalRating?.assetModel !== "etf");
  const hot = [...candidates].sort((a, b) => (b.sortKeys?.tradingValue100m || 0) - (a.sortKeys?.tradingValue100m || 0));
  const foreignYield = [...candidates].sort((a, b) => {
    const ai = itemFor(a);
    const bi = itemFor(b);
    const aInst = Number(ai.fundamentals?.data?.institutional?.totalNet);
    const bInst = Number(bi.fundamentals?.data?.institutional?.totalNet);
    const aYield = valuationMetric(ai, "dividendYield") || 0;
    const bYield = valuationMetric(bi, "dividendYield") || 0;
    return ((Number.isFinite(bInst) ? bInst : -999999) - (Number.isFinite(aInst) ? aInst : -999999)) || (bYield - aYield);
  });
  const epsGrowth = [...usable].sort((a, b) => {
    const ai = itemFor(a);
    const bi = itemFor(b);
    const aEps = Number(ai.fundamentals?.data?.profitability?.eps);
    const bEps = Number(bi.fundamentals?.data?.profitability?.eps);
    return ((Number.isFinite(bEps) ? bEps : -999999) - (Number.isFinite(aEps) ? aEps : -999999)) || ((b.sortKeys?.tradingValue100m || 0) - (a.sortKeys?.tradingValue100m || 0));
  });
  const highValue = [...candidates].sort((a, b) => (b.sortKeys?.tradingValue3m100m || b.sortKeys?.tradingValue100m || 0) - (a.sortKeys?.tradingValue3m100m || a.sortKeys?.tradingValue100m || 0));
  const ma20 = [...candidates]
    .filter(item => (item.sortKeys?.closeVs20MaPct ?? -999) >= 0 && (item.sortKeys?.ma20Slope5dPct ?? -999) > 0)
    .sort((a, b) => ((b.sortKeys?.ma20Slope5dPct || 0) - (a.sortKeys?.ma20Slope5dPct || 0)) || ((b.sortKeys?.tradingValue100m || 0) - (a.sortKeys?.tradingValue100m || 0)));
  return [
    {
      key: "hot",
      title: "\u71b1\u9580\u80a1\u7be9\u9078",
      description: "\u4ee5\u6700\u65b0\u65e5\u6210\u4ea4\u91cf/\u6210\u4ea4\u503c\u8207\u53ef\u5f97\u9031\u8f49\u7387\u4ee3\u7406\uff0c\u975e\u5b8c\u6574 5 \u65e5\u9031\u8f49\u7387\u3002",
      columns: ["\u6392\u540d", "\u4ee3\u78bc/\u540d\u7a31", "\u6536\u76e4", "\u6700\u65b0\u6210\u4ea4\u503c(\u5104)", "\u7be9\u9078\u91cd\u9ede"],
      rows: rankRows(hot, candidate => {
        const item = itemFor(candidate);
        return {
          code: candidate.code,
          name: candidate.name,
          close: candidate.latestClose,
          tradingValue100m: candidate.sortKeys?.tradingValue100m,
          focus: swingLiquidityNote(item, candidate),
        };
      }),
    },
    {
      key: "foreign-yield",
      title: "\u5916\u8cc7\u8cb7\u8d85\u5f37\u52e2\u80a1 / \u6b96\u5229\u7387\u6392\u5e8f",
      description: "\u512a\u5148\u770b\u8fd1\u671f\u6cd5\u4eba\u6de8\u8cb7\u8d85\uff0c\u4f75\u5217\u6b96\u5229\u7387\u3001\u672c\u76ca\u6bd4\u8207\u6210\u4ea4\u503c\u3002",
      columns: ["\u6392\u540d", "\u4ee3\u78bc/\u540d\u7a31", "\u6536\u76e4", "\u8fd1 5 \u65e5\u6cd5\u4eba\u8cb7\u8d85(\u5f35 / \u5104\u4f30)", "\u6b96\u5229\u7387%", "\u672c\u76ca\u6bd4", "\u6210\u4ea4\u503c(\u5104)"],
      rows: rankRows(foreignYield, candidate => {
        const item = itemFor(candidate);
        const totalNet = Number(item.fundamentals?.data?.institutional?.totalNet);
        return {
          code: candidate.code,
          name: candidate.name,
          close: candidate.latestClose,
          foreignNetBuy: Number.isFinite(totalNet) ? round(totalNet, 0) : null,
          foreignNetBuyText: institutionalNetBuyText(totalNet, candidate.latestClose),
          dividendYield: valuationMetric(item, "dividendYield"),
          per: valuationMetric(item, "per"),
          tradingValue100m: candidate.sortKeys?.tradingValue100m,
        };
      }),
    },
    {
      key: "eps-growth",
      title: "EPS \u6210\u9577\u5019\u9078",
      description: "\u4ee5\u53ef\u5f97 EPS \u8207\u6210\u4ea4\u503c/\u6d41\u52d5\u6027\u8a3b\u8a18\u505a\u7814\u7a76\u5019\u9078\u3002",
      columns: ["\u6392\u540d", "\u4ee3\u78bc/\u540d\u7a31", "\u6536\u76e4", "EPS", "\u6210\u4ea4\u503c/\u6d41\u52d5\u6027\u8a3b\u8a18"],
      rows: rankRows(epsGrowth, candidate => {
        const item = itemFor(candidate);
        return {
          code: candidate.code,
          name: candidate.name,
          close: candidate.latestClose,
          eps: Number.isFinite(item.fundamentals?.data?.profitability?.eps) ? round(item.fundamentals.data.profitability.eps, 2) : null,
          liquidityNote: swingLiquidityNote(item, candidate),
        };
      }),
    },
    {
      key: "trading-value",
      title: "\u9ad8\u6210\u4ea4\u503c\u5019\u9078",
      description: "\u4ee5\u6700\u65b0\u6210\u4ea4\u503c\u8207\u8fd1 3 \u500b\u6708\u4f30\u7b97\u6210\u4ea4\u503c\u6392\u5e8f\u3002",
      columns: ["\u6392\u540d", "\u4ee3\u78bc/\u540d\u7a31", "\u6536\u76e4", "\u6700\u65b0\u6210\u4ea4\u503c(\u5104)", "3M\u6210\u4ea4\u503c"],
      rows: rankRows(highValue, candidate => ({
        code: candidate.code,
        name: candidate.name,
        close: candidate.latestClose,
        tradingValue100m: candidate.sortKeys?.tradingValue100m,
        tradingValue3m100m: candidate.sortKeys?.tradingValue3m100m,
      })),
    },
    {
      key: "ma20",
      title: "20MA \u6280\u8853\u5019\u9078",
      description: "\u5f9e TWSE \u9010\u6a94\u6b77\u53f2\u8cc7\u6599\u8a08\u7b97\u51fa\u7684 20MA\uff1b\u689d\u4ef6\u70ba\u7ad9\u4e0a 20MA \u4e14 20MA \u4e0a\u5347\u3002",
      columns: ["\u6392\u540d", "\u4ee3\u78bc/\u540d\u7a31", "\u6700\u65b0\u6536\u76e4", "20MA", "20MA 5\u65e5\u524d", "\u689d\u4ef6"],
      rows: rankRows(ma20, candidate => ({
        code: candidate.code,
        name: candidate.name,
        close: candidate.latestClose,
        ma20: candidate.sortKeys?.ma20,
        ma20FiveAgo: candidate.sortKeys?.ma20FiveAgo,
        condition: swingMainEvidence(candidate.sortKeys?.closeVs20MaPct ?? null, candidate.sortKeys?.ma20Slope5dPct ?? null, candidate.sortKeys?.tradingValue100m ?? null),
      })),
    },
  ];
}

async function loadSwingMacro() {
  const settled = await Promise.allSettled([
    loadQuote("0050"),
    fetchYahooSymbolChart("^GSPC", "S&P 500", "6mo"),
    fetchYahooSymbolChart("TWD=X", "USD/TWD", "6mo"),
    loadQuote("2330"),
    fetchYahooSymbolChart("^TNX", "US 10Y Treasury Yield", "6mo"),
    fetchYahooSymbolChart("BTC-USD", "Bitcoin", "6mo"),
    fetchYahooSymbolChart("CL=F", "WTI Crude Oil Futures", "6mo"),
    fetchYahooSymbolChart("GC=F", "Gold Futures", "6mo"),
    fetchYahooSymbolChart("QQQ", "Nasdaq 100 ETF", "6mo"),
    loadSwingMacroNews(),
  ]);
  const tw = settled[0].status === "fulfilled" ? settled[0].value : null;
  const spx = settled[1].status === "fulfilled" ? settled[1].value : null;
  const fx = settled[2].status === "fulfilled" ? settled[2].value : null;
  const tsmc = settled[3].status === "fulfilled" ? settled[3].value : null;
  const ust10y = settled[4].status === "fulfilled" ? settled[4].value : null;
  const crypto = settled[5].status === "fulfilled" ? settled[5].value : null;
  const oil = settled[6].status === "fulfilled" ? settled[6].value : null;
  const gold = settled[7].status === "fulfilled" ? settled[7].value : null;
  const qqq = settled[8].status === "fulfilled" ? settled[8].value : null;
  const macroNews = settled[9].status === "fulfilled" ? settled[9].value : { ok: false, items: [], errors: [] };
  const riskScore = [
    tw ? (tw.analysis.latest.close > tw.analysis.latest.ma20 ? 25 : 8) : 0,
    spx ? (spx.trend === "risk-on" ? 25 : spx.trend === "range-bound" ? 14 : 4) : 0,
    fx ? ((fx.changePct20 || 0) <= 2 ? 18 : 6) : 0,
    tsmc ? (tsmc.analysis.latest.close > tsmc.analysis.latest.ma20 ? 20 : 8) : 0,
  ].reduce((sum, value) => sum + value, 0);
  const label = riskScore >= 72 ? "risk-on" : riskScore >= 56 ? "selective risk-on" : riskScore >= 42 ? "range-bound" : riskScore >= 28 ? "defensive" : "risk-off";
  const labelZh = label === "risk-on" ? "\u98a8\u96aa\u504f\u597d" :
    label === "selective risk-on" ? "\u9078\u64c7\u6027\u504f\u591a" :
    label === "range-bound" ? "\u5340\u9593\u76e4" :
    label === "defensive" ? "\u504f\u9632\u5b88" : "\u98a8\u96aa\u504f\u7a7a";
  const macroAssets = { tw, spx, fx, tsmc, ust10y, crypto, oil, gold, qqq };
  const briefing = buildMacroBriefing(riskScore, labelZh, macroNews, macroAssets);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    reportTimezone: "Asia/Taipei",
    horizon: "1-3 months",
    briefing,
    text: encodeTextTree({
      briefing,
      regime: {
        label: labelZh,
        summary: label === "risk-on" ? "\u53f0\u80a1\u8207\u7f8e\u80a1\u98a8\u96aa\u504f\u597d\u504f\u5f37\uff0c\u6ce2\u6bb5\u53ef\u512a\u5148\u770b 20MA \u4e0a\u65b9\u7e8c\u822a\u80a1\u3002" :
          label === "selective risk-on" ? "\u98a8\u96aa\u504f\u597d\u9078\u64c7\u6027\u504f\u591a\uff0c\u512a\u5148\u7be9\u51fa\u6709\u71df\u6536\u6216\u6cd5\u4eba\u652f\u6490\u7684\u5f37\u52e2\u80a1\u3002" :
          label === "range-bound" ? "\u5e02\u5834\u8f03\u50cf\u5340\u9593\u76e4\uff0c\u7a81\u7834\u8981\u770b\u91cf\u80fd\uff0c\u56de\u6e2c\u652f\u6490\u4e0d\u7834\u624d\u5ef6\u7e8c\u3002" :
          label === "defensive" ? "\u98a8\u96aa\u504f\u9632\u5b88\uff0c\u5019\u9078\u80a1\u9700\u8981\u66f4\u56b4\u683c\u7684\u5931\u6548\u50f9\u8207\u5009\u4f4d\u63a7\u5236\u3002" :
          "\u98a8\u96aa\u504f\u7a7a\uff0c\u6ce2\u6bb5\u6e05\u55ae\u4ee5\u89c0\u5bdf\u8207\u7b49\u5f85\u78ba\u8a8d\u70ba\u4e3b\u3002",
      },
      news: macroNews.items || [],
      screeningImplications: [
        "\u512a\u5148\u770b 20MA \u4e0a\u65b9\u4e14 MA20 \u9ad8\u65bc MA60 \u7684 1-3 \u500b\u6708\u6ce2\u6bb5\u7d50\u69cb\u3002",
        "RSI \u904e\u71b1\u8207\u8ddd\u96e2\u77ed\u7dda\u652f\u6490\u904e\u9060\u6642\uff0c\u5148\u964d\u70ba\u89c0\u5bdf\uff0c\u4e0d\u628a\u7a81\u7834\u7576\u4f5c\u76f4\u63a5\u9032\u5834\u7406\u7531\u3002",
        "\u71df\u6536 YoY\u3001\u8fd1 5 \u65e5\u6cd5\u4eba\u5408\u8a08\u4f5c\u70ba\u5019\u9078\u6392\u5e8f\u52a0\u5206\u3002",
        "\u6bcf\u6a94\u90fd\u9700\u8981\u652f\u6490\u3001\u58d3\u529b\u3001\u505c\u640d\u5931\u6548\u9ede\u8207\u4e8b\u4ef6\u98a8\u96aa\u6a19\u793a\u3002",
      ],
    }),
    regime: {
      label: labelZh,
      rawLabel: label,
      score: riskScore,
      summary: label === "risk-on" ? "\u53f0\u80a1\u8207\u7f8e\u80a1\u98a8\u96aa\u504f\u597d\u504f\u5f37\uff0c\u6ce2\u6bb5\u53ef\u512a\u5148\u770b 20MA \u4e0a\u65b9\u7e8c\u822a\u80a1\u3002" :
        label === "selective risk-on" ? "\u98a8\u96aa\u504f\u597d\u9078\u64c7\u6027\u504f\u591a\uff0c\u512a\u5148\u7be9\u51fa\u6709\u71df\u6536\u6216\u6cd5\u4eba\u652f\u6490\u7684\u5f37\u52e2\u80a1\u3002" :
        label === "range-bound" ? "\u5e02\u5834\u8f03\u50cf\u5340\u9593\u76e4\uff0c\u7a81\u7834\u8981\u770b\u91cf\u80fd\uff0c\u56de\u6e2c\u652f\u6490\u4e0d\u7834\u624d\u5ef6\u7e8c\u3002" :
        label === "defensive" ? "\u98a8\u96aa\u504f\u9632\u5b88\uff0c\u5019\u9078\u80a1\u9700\u8981\u66f4\u56b4\u683c\u7684\u5931\u6548\u50f9\u8207\u5009\u4f4d\u63a7\u5236\u3002" :
        "\u98a8\u96aa\u504f\u7a7a\uff0c\u6ce2\u6bb5\u6e05\u55ae\u4ee5\u89c0\u5bdf\u8207\u7b49\u5f85\u78ba\u8a8d\u70ba\u4e3b\u3002",
    },
    sources: {
      taiwanProxy: tw ? { label: "0050", date: tw.quoteDate, close: tw.close, source: tw.source, sourceUrls: tw.sourceUrls } : null,
      usProxy: spx,
      fxProxy: fx,
      semiconductorProxy: tsmc ? { label: "2330", date: tsmc.quoteDate, close: tsmc.close, source: tsmc.source, sourceUrls: tsmc.sourceUrls } : null,
      bondProxy: ust10y,
      cryptoProxy: crypto,
      oilProxy: oil,
      goldProxy: gold,
      nasdaqProxy: qqq,
    },
    news: macroNews,
    screeningImplications: [
      "\u512a\u5148\u770b 20MA \u4e0a\u65b9\u4e14 MA20 \u9ad8\u65bc MA60 \u7684 1-3 \u500b\u6708\u6ce2\u6bb5\u7d50\u69cb\u3002",
      "RSI \u904e\u71b1\u8207\u8ddd\u96e2\u77ed\u7dda\u652f\u6490\u904e\u9060\u6642\uff0c\u5148\u964d\u70ba\u89c0\u5bdf\uff0c\u4e0d\u628a\u7a81\u7834\u7576\u4f5c\u76f4\u63a5\u9032\u5834\u7406\u7531\u3002",
      "\u71df\u6536 YoY\u3001\u8fd1 5 \u65e5\u6cd5\u4eba\u5408\u8a08\u3001\u76f8\u5c0d 0050 \u5f37\u5f31\u4f5c\u70ba\u5019\u9078\u6392\u5e8f\u52a0\u5206\u3002",
      "\u6bcf\u6a94\u90fd\u9700\u8981\u652f\u6490\u3001\u58d3\u529b\u3001\u505c\u640d\u5931\u6548\u9ede\u8207\u4e8b\u4ef6\u98a8\u96aa\u6a19\u793a\u3002",
    ],
    errors: settled.map((item, index) => item.status === "rejected" ? { index, message: item.reason instanceof Error ? item.reason.message : String(item.reason) } : null).filter(Boolean),
  };
}

async function loadSwingScreener(universeValue: unknown) {
  const [screener, marketProxy] = await Promise.all([
    loadScreener("undervalued", universeValue, { fast: true }),
    loadQuote("0050").catch(() => null),
  ]);
  const stockItems = screener.items.filter(item => item.professionalRating.assetModel === "stock");
  const officialResults = await settleWithLimit(stockItems, 5, item => fetchTwseStockDayTrend(item.code));
  const officialMap = new Map<string, any>();
  const officialErrors: Array<{ code: string; message: string }> = [];
  officialResults.forEach((result, index) => {
    const code = stockItems[index]?.code;
    if (!code) return;
    if (result.status === "fulfilled") officialMap.set(code, result.value);
    else officialErrors.push({ code, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  });
  const candidates = stockItems
    .map(item => buildSwingCandidate(item, marketProxy, officialMap.get(item.code) || null))
    .sort((a, b) => b.swingScore - a.swingScore);
  const themeTables = buildSwingThemeTables(candidates, stockItems);
  const rankingMethod = {
    horizon: "1-3 months",
    formula: "\u4e3b\u984c\u5951\u5408\u5ea6 30% + \u6210\u4ea4\u503c 25% + \u6536\u76e4\u50f9\u76f8\u5c0d 20MA 25% + 20MA \u659c\u7387 20%",
    officialPriceSource: "TWSE STOCK_DAY",
    fallback: "\u82e5\u500b\u80a1\u975e TWSE \u6216\u5b98\u65b9\u7aef\u9ede\u6682\u6642\u4e0d\u53ef\u7528\uff0c\u8a72\u6b04\u4f4d\u6703\u6a19\u793a fallback\uff0c\u4e0d\u5047\u88dd\u70ba TWSE STOCK_DAY\u3002",
  };
  const gate = {
    required: true,
    instruction: "\u8acb\u52fe\u9078\u8981\u9032\u5165\u6df1\u5ea6\u6d41\u7a0b\u7684\u80a1\u7968\uff0c\u518d\u57f7\u884c\u53ef\u6bd4\u4f30\u503c\u3001\u6df1\u5ea6\u5206\u6790\u3001\u65e5\u7dda\u6280\u8853\u3001K \u7dda\u8a0a\u865f\u8207\u6700\u7d42\u6574\u5408\u3002",
  };
  return {
    ok: candidates.length > 0,
    generatedAt: new Date().toISOString(),
    horizon: "1-3 months",
    source: screener.source,
    universeMeta: screener.universeMeta,
    candidates,
    todayWatch: candidates.filter(item => item.watchPriority !== "\u4f4e" && item.signalHint !== "\u89c0\u5bdf").slice(0, 8),
    ranking: candidates.slice(0, 16),
    themeTables,
    text: encodeTextTree({
      candidates,
      todayWatch: candidates.filter(item => item.watchPriority !== "\u4f4e" && item.signalHint !== "\u89c0\u5bdf").slice(0, 8),
      ranking: candidates.slice(0, 16),
      themeTables,
      source: screener.source,
      rankingMethod,
      gate,
    }),
    rankingMethod,
    gate,
    errors: [...screener.errors, ...officialErrors],
  };
}

async function loadSwingValuation(codes: string[]) {
  const selected = await settleWithLimit(codes, 3, code => loadValueScore(code, { fast: true }));
  const peerBatch = await loadScreener("undervalued", undefined, { fast: true }).catch(() => null);
  const peerItems = peerBatch?.items || [];
  const items = selected.map((result, index) => {
    if (result.status === "rejected") return { ok: false, code: codes[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason) };
    const item = result.value;
    const group = swingGroup(item.code);
    const peers = peerItems.filter(peer => peer.code !== item.code && swingGroup(peer.code) === group).slice(0, 12);
    const peerValues = (key: "per" | "pbr" | "dividendYield") => peers.map(peer => valuationMetric(peer, key)).filter((value): value is number => value !== null).sort((a, b) => a - b);
    const median = (values: number[]) => values.length ? values[Math.floor(values.length / 2)] : null;
    return {
      ok: true,
      code: item.code,
      name: item.name,
      exchange: item.market,
      valuationDate: item.fundamentals?.data?.valuation?.date || item.quoteDate,
      currency: "TWD",
      sector: group,
      target: {
        close: item.close,
        per: valuationMetric(item, "per"),
        pbr: valuationMetric(item, "pbr"),
        dividendYield: valuationMetric(item, "dividendYield"),
        evRevenue: "N/A",
        evEbitda: "N/A",
        revenueGrowth: item.fundamentals?.data?.revenue?.yoy ?? item.fundamentals?.data?.profitability?.revenueYoY ?? null,
        margin: item.fundamentals?.data?.profitability?.revenue && item.fundamentals?.data?.profitability?.operatingIncome !== null
          ? round(((item.fundamentals.data.profitability.operatingIncome || 0) / item.fundamentals.data.profitability.revenue) * 100, 2)
          : null,
      },
      peerSummary: {
        count: peers.length,
        medianPer: median(peerValues("per")),
        medianPbr: median(peerValues("pbr")),
        medianDividendYield: median(peerValues("dividendYield")),
        evRevenue: "N/A",
        evEbitda: "N/A",
      },
      peers: peers.slice(0, 8).map(peer => ({
        code: peer.code,
        name: peer.name,
        per: valuationMetric(peer, "per"),
        pbr: valuationMetric(peer, "pbr"),
        dividendYield: valuationMetric(peer, "dividendYield"),
        revenueGrowth: peer.fundamentals?.data?.revenue?.yoy ?? null,
      })),
      bias: item.scores.undervalued !== null && item.scores.undervalued >= 70 ? "\u53ef\u80fd\u6298\u50f9" : item.scores.overvalued !== null && item.scores.overvalued >= 70 ? "\u504f\u8cb4" : "\u63a5\u8fd1\u540c\u696d\u5340\u9593",
      limitations: ["\u53f0\u80a1\u516c\u958b\u8cc7\u6599\u5c0d EV\u3001EBITDA \u8207\u5206\u6790\u5e2b\u9810\u4f30\u8986\u84cb\u4e0d\u8db3\uff0c\u7f3a\u8cc7\u6599\u6b04\u4f4d\u6a19\u793a N/A\uff0c\u4e0d\u7528\u5047\u6578\u5b57\u88dc\u503c\u3002"],
    };
  });
  return { ok: true, generatedAt: new Date().toISOString(), items, text: encodeTextTree({ items }) };
}

async function loadSwingDeepAnalysis(codes: string[]) {
  const results = await settleWithLimit(codes, 3, async code => {
    const [score, news] = await Promise.all([
      loadValueScore(code, { fast: true }),
      loadNews(code, FALLBACK_NAMES[code] || code, { force: false }).catch(err => ({ ok: false, items: [], note: err instanceof Error ? err.message : String(err) })),
    ]);
    const f = (score.fundamentals?.data || {}) as Record<string, any>;
    return {
      ok: true,
      code: score.code,
      name: score.name,
      horizon: "1-3 months",
      rating: score.professionalRating,
      fundamentals: {
        profitability: f.profitability || null,
        revenue: f.revenue || null,
        valuation: f.valuation || null,
        cashFlow: f.cashFlow || null,
        balanceSheet: f.balanceSheet || null,
        institutional: f.institutional || null,
      },
      thesis: [
        score.scores.growth.score !== null && score.scores.growth.score >= 65 ? "\u6210\u9577\u8cc7\u6599\u5c0d\u6ce2\u6bb5\u6709\u652f\u6490\u3002" : "\u6210\u9577\u8cc7\u6599\u4ecd\u9700\u89c0\u5bdf\u3002",
        score.scores.cashFlow.score !== null && score.scores.cashFlow.score >= 65 ? "\u73fe\u91d1\u6d41\u6216\u80a1\u5229\u54c1\u8cea\u8f03\u7a69\u3002" : "\u73fe\u91d1\u6d41\u8a0a\u865f\u4e0d\u8db3\u6216\u9700\u8907\u67e5\u3002",
        score.scores.marketConfidence.score !== null && score.scores.marketConfidence.score >= 60 ? "\u7c4c\u78bc\u8207\u5e02\u5834\u4fe1\u5fc3\u504f\u6b63\u5411\u3002" : "\u5e02\u5834\u4fe1\u5fc3\u5c1a\u672a\u5f62\u6210\u660e\u78ba\u512a\u52e2\u3002",
      ],
      catalysts: (news as any).items?.slice(0, 4).map((item: any) => ({
        title: item.title,
        source: item.source,
        publishedAt: item.publishedAt,
        relation: item.relation,
        sentiment: item.sentiment,
      })) || [],
      risks: [
        score.scores.chaseRisk.score !== null && score.scores.chaseRisk.score >= 72 ? "\u8ffd\u9ad8\u98a8\u96aa\u504f\u9ad8\uff0c\u9700\u7b49\u5f85\u56de\u6e2c\u6216\u91cf\u7e2e\u6574\u7406\u3002" : "\u8ffd\u9ad8\u98a8\u96aa\u672a\u660e\u986f\u5931\u63a7\uff0c\u4f46\u4ecd\u9700\u5b88\u5931\u6548\u50f9\u3002",
        score.dataStatus.coverage.percent < 60 ? "\u8cc7\u6599\u8986\u84cb\u7387\u4e0d\u8db3\uff0c\u7d50\u8ad6\u53ea\u80fd\u4f5c\u70ba\u89c0\u5bdf\u3002" : "\u8cc7\u6599\u8986\u84cb\u7387\u53ef\u7528\uff0c\u4f46\u8ca1\u5831\u66f4\u65b0\u4ecd\u9700\u8ffd\u8e64\u3002",
      ],
      dataStatus: score.dataStatus,
    };
  });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    items: results.map((result, index) => result.status === "fulfilled" ? result.value : { ok: false, code: codes[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason) }),
    text: encodeTextTree({
      items: results.map((result, index) => result.status === "fulfilled" ? result.value : { ok: false, code: codes[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason) }),
    }),
  };
}

function buildSwingTechnicalFromQuote(quote: QuoteInfo) {
  const latest = quote.analysis.latest;
  const levels = quote.analysis.levels;
  const support = levels.supportShort;
  const supportMid = levels.supportMid;
  const resistance = levels.resistanceShort;
  const resistanceMid = levels.resistanceMid;
  const invalidation = round(Math.min(levels.supportMid * 0.97, latest.ma60 * 0.98));
  const target1 = round(levels.resistanceShort * 1.04);
  const target2 = round(Math.max(levels.resistanceMid, latest.week52High) * 1.03);
  const maAlignment = latest.close > latest.ma20 && latest.ma20 > latest.ma60
    ? "\u50f9\u683c\u5728 20MA \u4e0a\u65b9\uff0c20MA \u9ad8\u65bc 60MA\uff0c\u5c6c\u65bc\u4e2d\u671f\u504f\u591a\u6392\u5217\u3002"
    : latest.close > latest.ma60
      ? "\u50f9\u683c\u4ecd\u5728 60MA \u4e0a\u65b9\uff0c\u4f46 20MA \u7d50\u69cb\u9700\u7b49\u5f85\u8f49\u5f37\u78ba\u8a8d\u3002"
      : "\u50f9\u683c\u4f4e\u65bc\u4e3b\u8981\u5747\u7dda\u6216\u7d50\u69cb\u504f\u5f31\uff0c\u4e0d\u5b9c\u7528\u8ffd\u50f9\u908f\u8f2f\u89e3\u8b80\u3002";
  const indicatorView = latest.rsi14 > 72
    ? "\u52d5\u80fd\u5f37\u4f46 RSI \u504f\u71b1\uff0c\u9700\u6ce8\u610f\u4e56\u96e2\u8207\u56de\u6a94\u58d3\u529b\u3002"
    : latest.rsi14 >= 50
      ? "RSI \u5728\u591a\u65b9\u5340\uff0c\u82e5 MACD \u8207\u91cf\u80fd\u540c\u6b65\uff0c\u7e8c\u822a\u6a5f\u7387\u8f03\u9ad8\u3002"
      : "RSI \u5c1a\u672a\u56de\u5230\u591a\u65b9\u5340\uff0c\u61c9\u7b49\u5f85\u8f49\u5f37\u6216\u56de\u6e2c\u78ba\u8a8d\u3002";
  const continuationScore = Math.max(0, Math.min(100, Math.round(
    45 +
    (latest.close > latest.ma20 ? 12 : -8) +
    (latest.ma20 > latest.ma60 ? 12 : -6) +
    (latest.rsi14 >= 50 && latest.rsi14 <= 68 ? 10 : latest.rsi14 > 74 ? -12 : 0) +
    (latest.volumeRatio >= 1.1 ? 6 : 0) -
    Math.max(0, latest.pullback - 60) * 0.4
  )));
  return {
    ok: true,
    code: quote.code,
    name: quote.name,
    date: quote.quoteDate,
    close: quote.close,
    trend: latest.close > latest.ma20 && latest.ma20 > latest.ma60 ? "\u504f\u591a" : latest.close > latest.ma60 ? "\u6574\u7406" : "\u504f\u5f31",
    continuationScore,
    pullbackRisk: latest.pullback,
    probabilities: {
      continuation: continuationScore,
      pullback: latest.pullback,
      rangeBound: Math.max(5, Math.min(95, 100 - Math.abs(continuationScore - 50) - Math.max(0, latest.pullback - 65))),
    },
    indicators: {
      ma5: latest.ma5,
      ma20: latest.ma20,
      ma60: latest.ma60,
      ma120: latest.ma120,
      rsi14: latest.rsi14,
      macdHist: latest.hist,
      kdK: latest.k,
      kdD: latest.d,
      bollingerPctB: latest.pctB,
      volumeRatio: latest.volumeRatio,
      atrPct: latest.atrPct,
    },
    levels: {
      support,
      supportMid,
      resistance,
      resistanceMid,
      invalidation,
      target1,
      target2,
    },
    framework: [
      { item: "\u50f9\u683c\u884c\u70ba", view: latest.close > latest.ma20 ? "\u6536\u76e4\u5728 20MA \u4e0a\uff0c\u591a\u65b9\u7d50\u69cb\u4ecd\u5728\u3002" : "\u672a\u7ad9\u7a69 20MA\uff0c\u9700\u7b49\u6536\u56de\u6216\u91cf\u80fd\u78ba\u8a8d\u3002" },
      { item: "\u79fb\u52d5\u5e73\u5747", view: maAlignment },
      { item: "\u6280\u8853\u6307\u6a19", view: indicatorView },
      { item: "\u7e8f\u8ad6\u8fd1\u4f3c", view: latest.close > latest.ma20 ? "\u65e5\u7dda\u53ef\u8996\u70ba\u5411\u4e0a\u6bb5\u843d\u5ef6\u4f38\uff1b\u9700\u7b49\u4f4e\u9031\u671f\u80cc\u96e2\u624d\u78ba\u8a8d\u53cd\u8f49\u3002" : "\u65e5\u7dda\u8f03\u50cf\u5340\u9593\u6216\u56de\u6e2c\u6bb5\uff0c\u4e0d\u5f37\u884c\u5224\u5b9a\u70ba\u4e0a\u653b\u6bb5\u3002" },
      { item: "\u827e\u7565\u7279\u6ce2\u6d6a", view: latest.close > latest.ma20 ? "\u504f\u5411\u4e3b\u5347\u6bb5\u6216\u7b2c 3/5 \u6ce2\u5ef6\u4f38\u5019\u9078\uff0c\u8dcc\u7834\u5931\u6548\u50f9\u5247\u6ce2\u6d6a\u5047\u8a2d\u964d\u7d1a\u3002" : "\u53ef\u80fd\u4ecd\u5728 ABC \u56de\u6e2c\u6216\u5340\u9593\u6574\u7406\uff0c\u9700\u5148\u7ad9\u56de\u5747\u7dda\u3002" },
      { item: "\u845b\u862d\u78a7\u6cd5\u5247", view: latest.close > latest.ma20 && latest.ma20 > latest.ma60 ? "\u63a5\u8fd1\u5747\u7dda\u4e0a\u5f4e\u5f8c\u7684\u8da8\u52e2\u8cb7\u9ede\uff1b\u82e5\u96e2 20MA \u904e\u9060\u5247\u6539\u70ba\u7b49\u62c9\u56de\u3002" : "\u5c1a\u672a\u6eff\u8db3\u5f37\u52e2\u5747\u7dda\u8cb7\u9ede\uff0c\u61c9\u7b49\u5f85\u6536\u56de\u6216\u91cd\u65b0\u7ad9\u7a69\u3002" },
    ],
    tradingPlan: {
      continuationEntry: `\u653e\u91cf\u7ad9\u7a69 ${fmt(resistance)} \u5f8c\uff0c\u624d\u628a\u7e8c\u822a\u60c5\u5883\u5347\u7d1a\u3002`,
      pullbackEntry: `\u56de\u6e2c ${fmt(support)}-${fmt(supportMid)} \u6216 20MA ${fmt(latest.ma20)} \u4e0d\u7834\uff0c\u518d\u89c0\u5bdf\u8f49\u5f37\u8a0a\u865f\u3002`,
      failureExit: `\u8dcc\u7834 ${fmt(invalidation)} \u4e14\u7121\u6cd5\u5feb\u901f\u6536\u56de\uff0c1-3 \u500b\u6708\u6ce2\u6bb5\u5047\u8a2d\u5931\u6548\u3002`,
      stopLoss: fmt(invalidation),
      targets: `${fmt(target1)} - ${fmt(target2)}`,
    },
    scenarios: [
      `\u7ad9\u7a69 ${fmt(resistance)} \u4e14\u91cf\u80fd\u5927\u65bc 20 \u65e5\u5747\u91cf 1.2 \u500d\uff0c\u7e8c\u6f32\u60c5\u5883\u5347\u6eab\u3002`,
      `\u56de\u6e2c MA20 ${fmt(latest.ma20)} \u4e0d\u7834\uff0c\u504f\u5411\u5065\u5eb7\u6574\u7406\u3002`,
      `\u8dcc\u7834 ${fmt(invalidation)} \u6642\uff0c1-3 \u500b\u6708\u6ce2\u6bb5\u5047\u8a2d\u5931\u6548\u3002`,
    ],
  };
}

async function loadSwingTechnical(codes: string[]) {
  const results = await settleWithLimit(codes, 3, code => loadQuote(code));
  const items = results.map((result, index) => result.status === "fulfilled" ? buildSwingTechnicalFromQuote(result.value) : { ok: false, code: codes[index], message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    items,
    text: encodeTextTree({ items }),
  };
}

function buildSwingSignalFromTechnical(item: any) {
  if (!item.ok) return item;
  const ind = item.indicators;
  const levels = item.levels;
  const longSetup = item.close > ind.ma20 && ind.ma20 > ind.ma60 && item.pullbackRisk < 68 && ind.rsi14 >= 48 && ind.rsi14 <= 72;
  const shortSetup = item.close < ind.ma60 && ind.rsi14 < 45 && ind.macdHist < 0;
  const wait = !longSetup && !shortSetup;
  const stance = longSetup ? "\u504f\u591a\u5019\u9078" : shortSetup ? "\u504f\u7a7a" : item.pullbackRisk >= 72 ? "\u89c0\u5bdf" : "\u907f\u958b";
  return {
    ok: true,
    code: item.code,
    name: item.name,
    stance,
    signal: longSetup ? "long setup" : shortSetup ? "short setup" : "no trade / wait for confirmation",
    strength: longSetup ? Math.min(92, item.continuationScore + 8) : shortSetup ? Math.max(50, 100 - item.continuationScore) : Math.max(30, Math.min(70, item.continuationScore)),
    context: `\u65e5\u7dda\u8da8\u52e2 ${item.trend || "N/A"}\uff0c\u6536\u76e4 ${fmt(item.close)}\uff0c20MA ${fmt(ind.ma20)}\uff0c60MA ${fmt(ind.ma60)}\u3002`,
    keyAreas: [
      `\u652f\u6490\u5340\uff1a${fmt(levels.support)}-${fmt(levels.supportMid)}`,
      `\u58d3\u529b\u5340\uff1a${fmt(levels.resistance)}-${fmt(levels.resistanceMid)}`,
      `\u5931\u6548\u50f9\uff1a${fmt(levels.invalidation)}`,
    ],
    candleRead: longSetup
      ? "\u6700\u65b0 K \u7dda\u7d50\u69cb\u504f\u591a\uff1a\u50f9\u683c\u5728\u5747\u7dda\u4e0a\u65b9\uff0c\u4f46\u82e5\u5df2\u9060\u96e2\u652f\u6490\uff0c\u61c9\u7b49\u56de\u6e2c\u6216\u7a81\u7834\u78ba\u8a8d\u3002"
      : shortSetup
        ? "\u6700\u65b0 K \u7dda\u7d50\u69cb\u504f\u7a7a\uff1a\u50f9\u683c\u4f4e\u65bc\u4e3b\u8981\u5747\u7dda\uff0c\u53cd\u5f48\u7121\u6cd5\u6536\u56de\u6642\u5bb9\u6613\u5ef6\u4f38\u8ce3\u58d3\u3002"
        : "\u6700\u65b0 K \u7dda\u4f4d\u7f6e\u4e0d\u5920\u4e7e\u6de8\uff1a\u591a\u7a7a\u689d\u4ef6\u6c92\u6709\u540c\u6b65\uff0c\u5148\u7b49\u7a81\u7834\u3001\u56de\u6e2c\u6216\u6536\u56de\u5747\u7dda\u3002",
    multiTimeframe: item.trend === "\u504f\u591a"
      ? "\u65e5\u7dda\u504f\u591a\u6642\uff0c\u4f4e\u9031\u671f\u61c9\u627e\u56de\u6e2c\u4e0d\u7834\u6216\u7a81\u7834\u5f8c\u56de\u6e2c\u8a0a\u865f\u3002"
      : "\u65e5\u7dda\u5c1a\u672a\u660e\u986f\u504f\u591a\uff0c\u4f4e\u9031\u671f\u8a0a\u865f\u4e0d\u61c9\u8207\u4e0a\u65b9\u58d3\u529b\u5c0d\u505a\u3002",
    decision: longSetup ? "\u504f\u591a\u5019\u9078\uff0c\u7b49\u78ba\u8a8d\u6216\u56de\u6e2c\u3002" : shortSetup ? "\u504f\u7a7a\uff0c\u53cd\u5f48\u4e0d\u904e\u58d3\u529b\u6642\u98a8\u96aa\u5347\u9ad8\u3002" : "\u4e0d\u4ea4\u6613 / \u7b49\u78ba\u8a8d\u3002",
    requiredConfirmation: longSetup
      ? `\u6536\u76e4\u7ad9\u7a69 ${fmt(levels.resistance)} \u6216\u56de\u6e2c MA20 \u4e0d\u7834\u3002`
      : shortSetup
        ? `\u53cd\u5f48\u7121\u6cd5\u7ad9\u56de MA60 ${fmt(ind.ma60)}\u3002`
        : `\u7b49\u5f85\u7a81\u7834 ${fmt(levels.resistance)} \u6216\u56de\u6e2c ${fmt(levels.support)} \u5f8c\u518d\u5224\u65b7\u3002`,
    invalidation: fmt(levels.invalidation),
    targetZone: `${fmt(levels.target1)} - ${fmt(levels.target2)}`,
  };
}

async function loadSwingSignal(codes: string[]) {
  const technical = await loadSwingTechnical(codes);
  const items = technical.items.map(buildSwingSignalFromTechnical);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    items,
    text: encodeTextTree({ items }),
  };
}

function buildSwingResearchReport(code: string, v: any, d: any, t: any, s: any) {
  const reportDate = new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" });
  const peerRows = Array.isArray(v.peers) ? v.peers.slice(0, 8).map((peer: any) => ({
    code: peer.code,
    name: peer.name,
    per: peer.per ?? "N/A",
    pbr: peer.pbr ?? "N/A",
    dividendYield: peer.dividendYield ?? "N/A",
  })) : [];
  const priceDate = t.date || v.valuationDate || d.dataStatus?.quoteDate || "N/A";
  const close = Number.isFinite(t.close) ? t.close : v.target?.close;
  const valuationText = v.ok
    ? `${v.bias || "N/A"}\uff1b\u76ee\u524d P/E ${v.target?.per ?? "N/A"}\u3001P/B ${v.target?.pbr ?? "N/A"}\uff0c\u540c\u696d\u53ef\u7528\u6a23\u672c ${v.peerSummary?.count ?? 0} \u6a94\u3002EV/EBITDA \u8207 EV/revenue \u56e0\u5373\u6642\u6de8\u50b5\u52d9\u8207 EBITDA \u8cc7\u6599\u4e0d\u8db3\u6a19\u70ba N/A\uff0c\u4e0d\u786c\u4f30\u3002`
    : v.message || "\u4f30\u503c\u8cc7\u6599\u4e0d\u8db3\u3002";
  const fundamentalText = d.ok
    ? `${(d.thesis || []).join(" ")} \u50ac\u5316\u65b0\u805e\uff1a${d.catalysts?.[0]?.title || "\u5c1a\u7121\u76f4\u63a5\u65b0\u805e\u50ac\u5316"}`
    : d.message || "\u500b\u80a1\u6df1\u5ea6\u8cc7\u6599\u4e0d\u8db3\u3002";
  const technicalText = t.ok
    ? `\u6700\u65b0\u6536\u76e4 ${fmt(t.close)}\uff0c20MA ${fmt(t.indicators?.ma20)}\uff0c60MA ${fmt(t.indicators?.ma60)}\uff0cRSI ${fmt(t.indicators?.rsi14, 1)}\uff0c\u8da8\u52e2\u5224\u65b7\u70ba${t.trend || "N/A"}\u3002\u652f\u6490 ${fmt(t.levels?.support)}-${fmt(t.levels?.supportMid)}\uff0c\u58d3\u529b ${fmt(t.levels?.resistance)}-${fmt(t.levels?.resistanceMid)}\uff0c\u5931\u6548\u50f9 ${fmt(t.levels?.invalidation)}\u3002`
    : t.message || "\u6280\u8853\u8cc7\u6599\u4e0d\u8db3\u3002";
  const klineText = s.ok
    ? `\u8a0a\u865f\uff1a${s.stance || "N/A"} / ${s.signal || "N/A"}\u3002\u78ba\u8a8d\u689d\u4ef6\uff1a${s.requiredConfirmation || "N/A"} \u76ee\u6a19\u5340 ${s.targetZone || "N/A"}\uff0c\u5931\u6548 ${s.invalidation || "N/A"}\u3002`
    : s.message || "\u591a\u7a7a\u8a0a\u865f\u8cc7\u6599\u4e0d\u8db3\u3002";
  const finalStance = s.stance || "\u89c0\u5bdf";
  const valuationTable = v.ok ? [
    { metric: "P/E", company: v.target?.per ?? "N/A", peerMedian: v.peerSummary?.medianPer ?? "N/A", interpretation: v.bias || "N/A" },
    { metric: "P/B", company: v.target?.pbr ?? "N/A", peerMedian: v.peerSummary?.medianPbr ?? "N/A", interpretation: v.bias || "N/A" },
    { metric: "\u6b96\u5229\u7387", company: v.target?.dividendYield ?? "N/A", peerMedian: v.peerSummary?.medianDividendYield ?? "N/A", interpretation: "\u7528\u65bc\u8f14\u52a9\u5224\u65b7\u5831\u916c\u8207\u4f30\u503c\uff0c\u4e0d\u55ae\u7368\u4f5c\u70ba\u8cb7\u8ce3\u4f9d\u64da\u3002" },
    { metric: "EV/EBITDA", company: "N/A", peerMedian: "N/A", interpretation: "\u5373\u6642\u6de8\u50b5\u52d9\u8207 EBITDA \u8cc7\u6599\u4e0d\u8db3\uff0c\u4e0d\u786c\u4f30\u3002" },
  ] : [];
  const financialSnapshot = d.ok ? [
    { item: "\u71df\u6536\u6210\u9577", value: d.fundamentals?.revenue?.yoy ?? d.fundamentals?.profitability?.revenueYoY ?? "N/A", view: "\u7528\u65bc\u5224\u65b7 1-3 \u500b\u6708\u984c\u6750\u662f\u5426\u6709\u57fa\u672c\u9762\u652f\u6490\u3002" },
    { item: "EPS", value: d.fundamentals?.profitability?.eps ?? "N/A", view: "\u82e5 EPS \u8207\u71df\u6536\u540c\u6b65\u6210\u9577\uff0c\u984c\u6750\u6301\u7e8c\u6027\u8f03\u9ad8\u3002" },
    { item: "\u73fe\u91d1\u6d41", value: d.fundamentals?.cashFlow?.operatingCashFlow ?? d.fundamentals?.cashFlow?.freeCashFlow ?? "N/A", view: "\u7528\u65bc\u6aa2\u67e5\u7372\u5229\u54c1\u8cea\uff1b\u7f3a\u8cc7\u6599\u6642\u4e0d\u88dc\u5047\u6578\u5b57\u3002" },
    { item: "\u8ca0\u50b5\u8207\u6d41\u52d5\u6027", value: d.fundamentals?.balanceSheet?.debtRatio ?? d.fundamentals?.balanceSheet?.currentRatio ?? "N/A", view: "\u7528\u65bc\u5224\u65b7\u56de\u6a94\u6642\u7684\u8ca1\u52d9\u627f\u53d7\u5ea6\u3002" },
  ] : [];
  const strengths = d.ok ? [
    ...(Array.isArray(d.thesis) ? d.thesis : []),
    d.catalysts?.[0]?.title ? `\u65b0\u805e\u50ac\u5316\uff1a${d.catalysts[0].title}` : "\u76ee\u524d\u6c92\u6709\u53ef\u76f4\u63a5\u5347\u7d1a\u7684\u65b0\u805e\u50ac\u5316\u3002",
  ] : [];
  const klineDetails = s.ok ? {
    context: s.context,
    keyAreas: s.keyAreas || [],
    candleRead: s.candleRead,
    multiTimeframe: s.multiTimeframe,
    decision: s.decision,
    confirmation: s.requiredConfirmation,
    invalidation: s.invalidation,
    targetZone: s.targetZone,
  } : null;
  const tradingPlan = t.tradingPlan || null;
  return {
    title: `${code} ${d.name || t.name || v.name || FALLBACK_NAMES[code] || ""} \u5f8c\u7e8c\u5206\u6790`,
    reportDate: `${reportDate} \u53f0\u7063\u6642\u9593`,
    latestPrice: `\u6700\u65b0\u53ef\u9a57\u8b49\u50f9\u683c\uff1a${priceDate} \u6536\u76e4 ${fmt(close)}\uff0c\u50f9\u683c\u4f86\u6e90\u4ee5 Yahoo/TWSE \u53ef\u5f97\u8cc7\u6599\u70ba\u4e3b\u3002`,
    executiveSummary: `\u7814\u7a76\u7acb\u5834\uff1a${finalStance}\u3002\u4f30\u503c\u5224\u65b7\u70ba${v.bias || "N/A"}\uff0c\u6280\u8853\u7d50\u69cb\u70ba${t.trend || "N/A"}\uff0cK \u7dda\u8a0a\u865f\u70ba${s.signal || "N/A"}\u3002`,
    valuation: valuationText,
    valuationTable,
    peers: peerRows,
    fundamentals: fundamentalText,
    financialSnapshot,
    strengths,
    risks: Array.isArray(d.risks) ? d.risks : [],
    technical: technicalText,
    technicalFramework: t.framework || [],
    probabilities: t.probabilities || null,
    tradingPlan,
    kline: klineText,
    klineDetails,
    scenarios: t.scenarios || [],
    dataQuality: [
      "\u8cc7\u6599\u4f86\u6e90\uff1a\u4f30\u503c\u8207\u5831\u50f9\u512a\u5148\u4f7f\u7528\u53ef\u9a57\u8b49\u516c\u958b\u8cc7\u6599\uff0c\u65e5\u7dda\u6280\u8853\u4f7f\u7528\u540c\u4e00\u7d44\u50f9\u683c\u8cc7\u6599\u8a08\u7b97\u3002",
      "\u9650\u5236\uff1a\u82e5\u4e94\u5e74\u5b8c\u6574\u8ca1\u5831\u3001TTM\u3001EV/EBITDA \u6216\u5206\u6790\u5e2b\u9810\u4f30\u4e0d\u8db3\uff0c\u7cfb\u7d71\u6703\u6a19\u793a N/A\uff0c\u4e0d\u7528\u5047\u8cc7\u6599\u586b\u88dc\u3002",
    ],
    conclusion: {
      valuation: v.bias || "N/A",
      fundamentals: d.rating?.grade ? `${d.rating.grade} / ${scoreTextValue(d.rating.total)}` : "N/A",
      technical: t.trend || "N/A",
      kline: s.stance || "N/A",
      horizon: "\u4ee5 1-3 \u500b\u6708\u6ce2\u6bb5\u70ba\u4e3b\uff0c\u7b49\u7a81\u7834\u6216\u62c9\u56de\u5b88\u4f4f\u5f8c\u518d\u63d0\u9ad8\u4fe1\u5fc3\u3002",
      mainRisk: d.risks?.[0] || "\u8cc7\u6599\u4e0d\u8db3",
      finalStance,
    },
  };
}

function buildSwingSummaryFromStages(codes: string[], valuation: any, deep: any, technical: any, signal: any) {
  const byCode = (items: any[]) => new Map(items.map(item => [item.code, item]));
  const valuationMap = byCode(valuation.items || []);
  const deepMap = byCode(deep.items || []);
  const technicalMap = byCode(technical.items || []);
  const signalMap = byCode(signal.items || []);
  const rows = codes.map(code => {
    const v: any = valuationMap.get(code) || {};
    const d: any = deepMap.get(code) || {};
    const t: any = technicalMap.get(code) || {};
    const s: any = signalMap.get(code) || {};
    const researchReport = buildSwingResearchReport(code, v, d, t, s);
    return {
      code,
      name: d.name || t.name || v.name || FALLBACK_NAMES[code] || code,
      valuationBias: v.bias || "N/A",
      fundamentalBias: d.rating?.grade ? `${d.rating.grade} / ${scoreTextValue(d.rating.total)}` : "N/A",
      technicalBias: t.trend || "N/A",
      klineSignal: s.signal || "N/A",
      scenario: s.requiredConfirmation || "\u8cc7\u6599\u4e0d\u8db3",
      keyLevels: t.levels || null,
      mainCatalyst: d.catalysts?.[0]?.title || "\u5c1a\u7121\u76f4\u63a5\u65b0\u805e\u50ac\u5316",
      mainRisk: d.risks?.[0] || "\u8cc7\u6599\u4e0d\u8db3",
      finalStance: s.stance || "\u89c0\u5bdf",
      researchReport,
    };
  });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    rows,
    text: encodeTextTree({ rows }),
    rankedWatchlist: [...rows].sort((a, b) => {
      const rank = (stance: string) => stance === "\u504f\u591a\u5019\u9078" ? 4 : stance === "\u504f\u591a" ? 3 : stance === "\u89c0\u5bdf" ? 2 : stance === "\u907f\u958b" ? 1 : 0;
      return rank(b.finalStance) - rank(a.finalStance);
    }),
    riskControls: [
      "\u4e0d\u628a\u5019\u9078\u6e05\u55ae\u89e3\u8b80\u6210\u76f4\u63a5\u8cb7\u9032\u8a0a\u865f\u3002",
      "\u6240\u6709\u5019\u9078\u90fd\u5fc5\u9808\u5148\u5b9a\u7fa9\u5931\u6548\u50f9\uff0c\u8dcc\u7834\u5f8c\u505c\u6b62\u539f\u672c\u6ce2\u6bb5\u5047\u8a2d\u3002",
      "\u82e5\u8cc7\u6599\u8986\u84cb\u7387\u4e0d\u8db3\u6216\u65b0\u805e\u4f86\u6e90\u903e\u6642\uff0c\u8a72\u6a94\u53ea\u4fdd\u7559\u89c0\u5bdf\uff0c\u4e0d\u5347\u7d1a\u70ba\u9ad8\u4fe1\u5fc3\u5019\u9078\u3002",
    ],
  };
}

async function loadSwingSummary(codes: string[]) {
  const [valuation, deep, technical] = await Promise.all([
    loadSwingValuation(codes),
    loadSwingDeepAnalysis(codes),
    loadSwingTechnical(codes),
  ]);
  const signalItems = (technical.items || []).map(buildSwingSignalFromTechnical);
  const signal = {
    ok: true,
    generatedAt: new Date().toISOString(),
    items: signalItems,
    text: encodeTextTree({ items: signalItems }),
  };
  return buildSwingSummaryFromStages(codes, valuation, deep, technical, signal);
}

function buildSwingOrchestratedMarkdown(payload: any) {
  const summaryRows = payload.summary?.rows || [];
  const lines = [
    "# Dino K\u68d2\u5224\u65b7\u7b56\u7565\uff5cSkill Orchestrated Report",
    "",
    `\u7522\u751f\u6642\u9593\uff1a${payload.generatedAt}`,
    `\u4f7f\u7528\u5951\u7d04\uff1a${SWING_SKILL_BUNDLE.orchestrator.name} + ${SWING_SKILL_BUNDLE.specialists.length} specialist skills`,
    `\u9078\u80a1 gate\uff1a${payload.gate?.status || "N/A"}\uff0c\u6a19\u7684\uff1a${(payload.selectedCodes || []).join(", ") || "N/A"}`,
    "",
    "## \u7de8\u6392\u9806\u5e8f",
    ...SWING_SKILL_BUNDLE.stageOrder.map((stage, index) => `${index + 1}. ${stage}`),
    "",
    "## \u6700\u7d42\u6574\u5408",
  ];
  for (const row of summaryRows) {
    const levels = row.keyLevels || {};
    lines.push(
      "",
      `### ${row.code} ${row.name || ""}`,
      `- \u7814\u7a76\u7acb\u5834\uff1a${row.finalStance || "N/A"}`,
      `- \u4f30\u503c\uff1a${row.valuationBias || "N/A"}\uff1b\u57fa\u672c\u9762\uff1a${row.fundamentalBias || "N/A"}`,
      `- \u65e5\u7dda\u6280\u8853\uff1a${row.technicalBias || "N/A"}\uff1bK \u7dda\uff1a${row.klineSignal || "N/A"}`,
      `- \u689d\u4ef6\uff1a${row.scenario || "N/A"}`,
      `- \u95dc\u9375\u4f4d\u968e\uff1a\u652f\u6490 ${fmt(levels.support)} / \u58d3\u529b ${fmt(levels.resistance)} / \u5931\u6548 ${fmt(levels.invalidation)}`,
      `- \u4e3b\u50ac\u5316\uff1a${row.mainCatalyst || "N/A"}`,
      `- \u4e3b\u98a8\u96aa\uff1a${row.mainRisk || "N/A"}`
    );
  }
  lines.push(
    "",
    "## \u98a8\u96aa\u63a7\u5236",
    ...((payload.summary?.riskControls || []).map((item: string) => `- ${item}`))
  );
  return lines.join("\n");
}

function parseSwingPromptContext(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.slice(0, 9000));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readRequestJson(ctx: any) {
  if (ctx?.body && typeof ctx.body === "object") return ctx.body;
  if (ctx?.body && typeof ctx.body === "string") {
    try {
      return JSON.parse(ctx.body);
    } catch {
      return {};
    }
  }
  if (ctx?.request && typeof ctx.request.json === "function") {
    try {
      return await ctx.request.json();
    } catch {
      return {};
    }
  }
  if (ctx?.req && typeof ctx.req.json === "function") {
    try {
      return await ctx.req.json();
    } catch {
      return {};
    }
  }
  return {};
}

function compactText(value: unknown, max = 420) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function compactRows(rows: any[], mapper: (row: any) => any, limit = 8) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit).map(mapper);
}

function buildSwingLlmPromptData(payload: any, promptContext: any) {
  const stage = payload.stages || payload;
  const valuationItems = stage.valuation?.items || [];
  const deepItems = stage.deep?.items || [];
  const technicalItems = stage.technical?.items || [];
  const signalItems = stage.signal?.items || [];
  const summaryRows = stage.summary?.rows || [];
  return {
    contract: {
      orchestrator: SWING_SKILL_BUNDLE.orchestrator.name,
      specialists: SWING_SKILL_BUNDLE.specialists.map(item => ({ stage: item.stage, name: item.name })),
      stageOrder: SWING_SKILL_BUNDLE.stageOrder,
      gate: SWING_SKILL_BUNDLE.gate,
    },
    generatedAt: payload.generatedAt,
    selectedCodes: payload.selectedCodes || [],
    marketContext: promptContext?.macro || stage.macro || null,
    screenerContext: promptContext?.screener || stage.screener || null,
    valuation: compactRows(valuationItems, item => ({
      code: item.code,
      name: item.name,
      bias: item.bias || item.message,
      target: item.target,
      peerSummary: item.peerSummary,
      limitations: item.limitations,
    }), 6),
    fundamentalDeepDive: compactRows(deepItems, item => ({
      code: item.code,
      name: item.name,
      rating: item.rating,
      thesis: (item.thesis || []).slice(0, 5),
      catalysts: compactRows(item.catalysts || [], c => ({ title: c.title, source: c.source, publishedAt: c.publishedAt }), 3),
      risks: (item.risks || []).slice(0, 5),
      dataStatus: item.dataStatus,
    }), 6),
    dailyTechnical: compactRows(technicalItems, item => ({
      code: item.code,
      name: item.name,
      date: item.date,
      close: item.close,
      trend: item.trend || item.message,
      indicators: item.indicators,
      levels: item.levels,
      probabilities: item.probabilities,
      tradingPlan: item.tradingPlan,
      scenarios: item.scenarios,
    }), 6),
    klineSignal: compactRows(signalItems, item => ({
      code: item.code,
      name: item.name,
      signal: item.signal || item.message,
      strength: item.strength,
      stance: item.stance,
      requiredConfirmation: item.requiredConfirmation,
      invalidation: item.invalidation,
      targetZone: item.targetZone,
    }), 6),
    finalSynthesis: compactRows(summaryRows, row => ({
      code: row.code,
      name: row.name,
      finalStance: row.finalStance,
      valuationBias: row.valuationBias,
      fundamentalBias: row.fundamentalBias,
      technicalBias: row.technicalBias,
      klineSignal: row.klineSignal,
      scenario: row.scenario,
      keyLevels: row.keyLevels,
      mainCatalyst: row.mainCatalyst,
      mainRisk: row.mainRisk,
    }), 6),
    riskControls: stage.summary?.riskControls || [],
  };
}

function buildSwingLlmInstructions() {
  return [
    "You are the report-generation layer for a Taiwan stock 1-3 month swing-trading workflow.",
    "Write Traditional Chinese Markdown only. Use a senior macro strategist + stock screener + comparable valuation + fundamental analyst + daily technical analyst + K-line long/short signal style.",
    "Do not invent unavailable financial, valuation, news, or price data. If a field is missing, write N/A or explicitly say data is unavailable.",
    "Do not give direct investment advice or guaranteed predictions. Frame outputs as research stance, watchlist, conditions, invalidation, and risk controls.",
    "Use the selected stock codes as the gate-approved scope. Do not add unrelated tickers.",
    "Required Markdown structure: # title, ## \u5e02\u5834\u8207\u984c\u6750\u80cc\u666f, ## Screener \u5019\u9078\u908f\u8f2f, ## \u4f7f\u7528\u8005\u9078\u80a1 Gate, one ## section per selected stock, ## \u6700\u7d42\u89c0\u5bdf\u6e05\u55ae, ## \u98a8\u96aa\u8207\u5931\u6548\u689d\u4ef6.",
    "For each selected stock include: valuation read, fundamental thesis, daily technical read, K-line long/short signal, key levels, continuation condition, pullback condition, invalidation, and 1-3 month final stance.",
  ].join("\n");
}

function buildSwingLlmUserPrompt(promptData: any) {
  const jsonText = JSON.stringify(promptData).slice(0, 3500);
  return [
    "\u8acb\u6839\u64da\u4e0b\u5217 JSON \u7522\u751f\u63a5\u8fd1 Codex skill `taiwan-stock-swing-orchestrator` \u7684\u7e41\u9ad4\u4e2d\u6587 Markdown \u5831\u544a\u3002",
    "\u91cd\u9ede\uff1a\u8981\u628a\u5e02\u5834\u80cc\u666f\u3001screener \u5019\u9078\u908f\u8f2f\u3001\u4f7f\u7528\u8005\u9078\u80a1\u3001\u4f30\u503c\u3001\u57fa\u672c\u9762\u3001\u65e5\u7dda\u6280\u8853\u8207 K \u7dda\u8a0a\u865f\u6574\u5408\u6210\u4e00\u4efd\u53ef\u8b80\u7684\u7814\u7a76\u5831\u544a\u3002",
    "\u4e0d\u8981\u8f38\u51fa JSON\u3002\u4e0d\u8981\u52a0\u5165\u672a\u5728\u8cc7\u6599\u4e2d\u51fa\u73fe\u7684\u8ca1\u5831\u6578\u5b57\u6216\u65b0\u805e\u3002",
    "",
    "```json",
    jsonText,
    "```",
  ].join("\n");
}

function extractOpenAiText(payload: any) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const parts: string[] = [];
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function generateSwingLlmReport(reportPayload: any, promptContext: any) {
  const apiKey = await getOpenAiApiKey();
  const model = await getOpenAiReportModel();
  const promptData = buildSwingLlmPromptData(reportPayload, promptContext);
  const promptPreview = {
    selectedCodes: promptData.selectedCodes,
    marketContextAvailable: Boolean(promptData.marketContext),
    screenerContextAvailable: Boolean(promptData.screenerContext),
    valuationRows: promptData.valuation.length,
    deepRows: promptData.fundamentalDeepDive.length,
    technicalRows: promptData.dailyTechnical.length,
    signalRows: promptData.klineSignal.length,
  };
  if (!apiKey) {
    return {
      ok: false,
      status: "missing_secret",
      provider: "openai_responses",
      mode: "single_final_editor_with_stage_contract",
      model,
      message: "OPENAI_API_KEY AppDeploy secret is not configured.",
      promptPreview,
      steps: SWING_SKILL_BUNDLE.stageOrder.map(stage => ({ stage, status: "skipped_missing_secret" })),
      markdown: "",
    };
  }
  const timeoutMs = 12000;
  try {
    const res = await Promise.race([
      fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: buildSwingLlmInstructions(),
          input: buildSwingLlmUserPrompt(promptData),
        max_output_tokens: 420,
          store: false,
        }),
      }),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error(`OpenAI report generation timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]) as Response;
    const raw = await res.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: "api_error",
        provider: "openai_responses",
        mode: "single_final_editor_with_stage_contract",
        model,
        httpStatus: res.status,
        message: compactText(data?.error?.message || raw || "OpenAI report generation failed.", 600),
        promptPreview,
        steps: SWING_SKILL_BUNDLE.stageOrder.map(stage => ({ stage, status: "skipped_api_error" })),
        markdown: "",
      };
    }
    const markdown = extractOpenAiText(data);
    return {
      ok: Boolean(markdown),
      status: markdown ? "generated" : "empty_output",
      provider: "openai_responses",
      mode: "single_final_editor_with_stage_contract",
      model,
      responseId: data?.id || null,
      usage: data?.usage || null,
      promptPreview,
      steps: SWING_SKILL_BUNDLE.stageOrder.map(stage => ({ stage, status: markdown ? "covered_in_final_editor" : "empty_output" })),
      markdown,
      message: markdown ? "\u5df2\u7531 LLM prompt pipeline \u7522\u751f\u7e41\u4e2d Markdown \u5831\u544a\u3002" : "OpenAI response did not include text output.",
    };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof Error && /timed out|AbortError/i.test(`${err.name} ${err.message}`) ? "timeout" : "exception",
      provider: "openai_responses",
      mode: "single_final_editor_with_stage_contract",
      model,
      message: err instanceof Error ? err.message : String(err),
      promptPreview,
      steps: SWING_SKILL_BUNDLE.stageOrder.map(stage => ({ stage, status: "skipped_exception" })),
      markdown: "",
    };
  }
}

async function callOpenAiReportStep(apiKey: string, model: string, instructions: string, input: string, maxOutputTokens: number, timeoutMs: number) {
  try {
    const res = await Promise.race([
      fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions,
          input,
          max_output_tokens: maxOutputTokens,
          store: false,
        }),
      }),
      new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error(`OpenAI report step timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]) as Response;
    const raw = await res.text();
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: "api_error",
        httpStatus: res.status,
        message: compactText(data?.error?.message || raw || "OpenAI report step failed.", 600),
        text: "",
      };
    }
    const text = extractOpenAiText(data);
    return {
      ok: Boolean(text),
      status: text ? "generated" : "empty_output",
      responseId: data?.id || null,
      usage: data?.usage || null,
      text,
    };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof Error && /timed out|AbortError/i.test(`${err.name} ${err.message}`) ? "timeout" : "exception",
      message: err instanceof Error ? err.message : String(err),
      text: "",
    };
  }
}

function specialistInstructions(role: string, task: string) {
  return [
    `You are ${role} inside the taiwan-stock-swing-orchestrator backend report runner.`,
    "Write Traditional Chinese Markdown only.",
    "Use only the evidence JSON and previous specialist outputs. Do not invent missing numbers, news, peers, or price levels.",
    "Keep this as research framing, scenarios, invalidation, and risk controls. Do not write direct buy/sell instructions.",
    task,
  ].join("\n");
}

function buildSpecialistInput(promptData: any, previousOutputs: any[], focus: string, maxChars = 20000) {
  const previous = previousOutputs.map(item => ({
    stage: item.stage,
    skill: item.skill,
    markdown: compactText(item.markdown, 1600),
  }));
  return JSON.stringify({
    focus,
    evidenceProvider: "backend_data_api",
    promptData,
    previous,
  }).slice(0, maxChars);
}

function fallbackStepMarkdown(stage: string, promptData: any) {
  if (stage === "macro") {
    return [
      "## \u5e02\u5834\u8207\u984c\u6750\u80cc\u666f",
      compactText(promptData.marketContext?.marketConclusion || promptData.marketContext?.regime?.summary || "\u5e02\u5834\u80cc\u666f\u7531 evidence provider \u63d0\u4f9b\uff0cLLM \u5c1a\u672a\u7522\u751f\u7d50\u8ad6\u3002", 900),
    ].join("\n\n");
  }
  if (stage === "screener") {
    return [
      "## Screener \u5019\u9078\u908f\u8f2f",
      compactText(promptData.screenerContext?.rankingMethod?.formula || promptData.screenerContext?.rankingMethod?.rankingFormula || "\u4ee5\u4e3b\u984c\u5951\u5408\u3001\u6210\u4ea4\u503c\u300120MA \u4f4d\u7f6e\u8207\u659c\u7387\u4f5c\u70ba\u5019\u9078 evidence\u3002", 900),
    ].join("\n\n");
  }
  return "";
}

async function generateSwingSpecialistChainReport(reportPayload: any, promptContext: any) {
  const apiKey = await getOpenAiApiKey();
  const model = await getOpenAiReportModel();
  const promptData = buildSwingLlmPromptData(reportPayload, promptContext);
  const promptPreview = {
    selectedCodes: promptData.selectedCodes,
    marketContextAvailable: Boolean(promptData.marketContext),
    screenerContextAvailable: Boolean(promptData.screenerContext),
    valuationRows: promptData.valuation.length,
    deepRows: promptData.fundamentalDeepDive.length,
    technicalRows: promptData.dailyTechnical.length,
    signalRows: promptData.klineSignal.length,
  };
  const stages = [
    {
      stage: "macro",
      skill: "senior-macro-strategist",
      role: "a senior macro strategist",
      task: "Produce the market regime and 1-3 month screening implications. Keep it concise and evidence-linked.",
      maxTokens: 350,
    },
    {
      stage: "screener",
      skill: "taiwan-stock-screener",
      role: "a Taiwan stock screener",
      task: "Explain the candidate screening logic, selected-stock gate, and why the chosen stocks proceed to deeper analysis.",
      maxTokens: 350,
    },
    {
      stage: "valuation",
      skill: "comparable-company-analysis",
      role: "a comparable-company valuation analyst",
      task: "For each selected stock, explain relative valuation, peer limitations, premium/discount bias, and missing-data constraints.",
      maxTokens: 450,
    },
    {
      stage: "fundamental",
      skill: "senior-stock-investment-analysis",
      role: "a senior stock investment analyst",
      task: "For each selected stock, produce a 1-3 month fundamental thesis, catalysts, risks, and data-quality notes.",
      maxTokens: 450,
    },
    {
      stage: "technical",
      skill: "daily-market-technical-analysis",
      role: "a daily market technical analyst",
      task: "For each selected stock, interpret trend, moving averages, RSI/MACD if available, support, resistance, scenarios, and invalidation.",
      maxTokens: 450,
    },
    {
      stage: "kline",
      skill: "kline-long-short-signal",
      role: "a K-line long/short signal analyst",
      task: "For each selected stock, decide conditional long setup, short setup, or wait/no-trade using daily technical alignment.",
      maxTokens: 400,
    },
    {
      stage: "final",
      skill: "taiwan-stock-swing-orchestrator",
      role: "the final editor and orchestrator",
      task: "Synthesize every previous specialist output into one polished Traditional Chinese Markdown report with sections: title, market background, screener logic, gate, one section per selected stock, final watchlist, and risk/invalidation controls.",
      maxTokens: 1000,
    },
  ];
  if (!apiKey) {
    return {
      ok: false,
      status: "missing_secret",
      provider: "openai_responses",
      mode: "sequential_specialist_chain",
      model,
      message: "OPENAI_API_KEY AppDeploy secret is not configured.",
      promptPreview,
      steps: stages.map(item => ({ stage: item.stage, skill: item.skill, status: "skipped_missing_secret" })),
      markdown: "",
    };
  }
  const outputs: any[] = [];
  for (const stage of stages) {
    const input = buildSpecialistInput(promptData, outputs, stage.stage, stage.stage === "final" ? 14000 : 10000);
    const result = await callOpenAiReportStep(
      apiKey,
      model,
      specialistInstructions(stage.role, stage.task),
      input,
      stage.maxTokens,
      stage.stage === "final" ? 22000 : 18000
    );
    outputs.push({
      stage: stage.stage,
      skill: stage.skill,
      status: result.status,
      ok: result.ok,
      responseId: result.responseId || null,
      usage: result.usage || null,
      message: result.message || "",
      markdown: result.ok ? result.text : fallbackStepMarkdown(stage.stage, promptData),
    });
    if (!result.ok && ["api_error", "timeout", "exception"].includes(result.status)) {
      break;
    }
  }
  const finalOutput = outputs.find(item => item.stage === "final" && item.ok);
  return {
    ok: Boolean(finalOutput?.markdown),
    status: finalOutput?.markdown ? "generated" : outputs.some(item => !item.ok) ? "partial_or_failed" : "empty_output",
    provider: "openai_responses",
    mode: "sequential_specialist_chain",
    model,
    promptPreview,
    steps: outputs.map(item => ({
      stage: item.stage,
      skill: item.skill,
      status: item.status,
      ok: item.ok,
      responseId: item.responseId,
      usage: item.usage,
      message: item.message,
    })),
    markdown: finalOutput?.markdown || "",
    intermediateMarkdown: outputs.filter(item => item.stage !== "final").map(item => ({
      stage: item.stage,
      skill: item.skill,
      markdown: item.markdown,
    })),
    message: finalOutput?.markdown
      ? "\u5df2\u7531\u9806\u5e8f specialist prompt chain \u7522\u751f\u7e41\u4e2d Markdown \u5831\u544a\u3002"
      : "Sequential specialist prompt chain did not complete; deterministic fallback report is used.",
  };
}

const SWING_BACKGROUND_STAGES = [
  {
    stage: "macro",
    skill: "senior-macro-strategist",
    role: "a senior macro strategist",
    task: "Produce the market regime and 1-3 month screening implications. Keep it concise and evidence-linked.",
    maxTokens: 420,
    timeoutMs: 22000,
  },
  {
    stage: "screener",
    skill: "taiwan-stock-screener",
    role: "a Taiwan stock screener",
    task: "Explain the candidate screening logic, selected-stock gate, and why the chosen stocks proceed to deeper analysis.",
    maxTokens: 420,
    timeoutMs: 22000,
  },
  {
    stage: "user-selection-gate",
    skill: "taiwan-stock-swing-orchestrator",
    role: "the user-selection gate",
    task: "Confirm that only user-selected stock codes proceed to valuation, fundamental, technical, K-line signal, and final synthesis.",
    maxTokens: 0,
    timeoutMs: 0,
  },
  {
    stage: "valuation",
    skill: "comparable-company-analysis",
    role: "a comparable-company valuation analyst",
    task: "For each selected stock, explain relative valuation, peer limitations, premium/discount bias, and missing-data constraints.",
    maxTokens: 560,
    timeoutMs: 24000,
  },
  {
    stage: "deep-analysis",
    skill: "senior-stock-investment-analysis",
    role: "a senior stock investment analyst",
    task: "For each selected stock, produce a 1-3 month fundamental thesis, catalysts, risks, and data-quality notes.",
    maxTokens: 560,
    timeoutMs: 24000,
  },
  {
    stage: "technical",
    skill: "daily-market-technical-analysis",
    role: "a daily market technical analyst",
    task: "For each selected stock, interpret trend, moving averages, RSI/MACD if available, support, resistance, scenarios, and invalidation.",
    maxTokens: 560,
    timeoutMs: 24000,
  },
  {
    stage: "signal",
    skill: "kline-long-short-signal",
    role: "a K-line long/short signal analyst",
    task: "For each selected stock, decide conditional long setup, short setup, or wait/no-trade using daily technical alignment.",
    maxTokens: 500,
    timeoutMs: 22000,
  },
  {
    stage: "summary",
    skill: "taiwan-stock-swing-orchestrator",
    role: "the final editor and orchestrator",
    task: "Synthesize every previous specialist output into one polished Traditional Chinese Markdown report with sections: title, market background, screener logic, gate, one section per selected stock, final watchlist, and risk/invalidation controls.",
    maxTokens: 1400,
    timeoutMs: 28000,
  },
];

function initialSwingJobSteps() {
  return SWING_BACKGROUND_STAGES.map(item => ({
    stage: item.stage,
    skill: item.skill,
    status: "pending",
    ok: false,
    message: "",
  }));
}

function swingJobGate(codes: string[]) {
  return {
    required: true,
    status: codes.length ? "passed" : "blocked",
    selectedCodes: codes,
    instruction: "\u8acb\u5148\u5b8c\u6210\u5019\u9078\u6e05\u55ae\u5f8c\u9078\u53d6\u80a1\u7968\uff0c\u518d\u555f\u52d5\u4f30\u503c\u3001\u500b\u80a1\u6df1\u5ea6\u3001\u6280\u8853\u8207 K \u7dda\u7d9c\u5408\u5831\u544a\u3002",
  };
}

function buildSwingJobReportPayload(job: any) {
  const evidence = job.evidence || {};
  const macro = evidence.macro || job.promptContext?.macro || {
    ok: true,
    reusedFrom: "client workflow gate",
    note: "Macro/news stage is loaded before user selection and is not recomputed in the background report job.",
  };
  const screener = evidence.screener || job.promptContext?.screener || {
    ok: true,
    reusedFrom: "client workflow gate",
    note: "Screener stage is loaded before user selection and is not recomputed in the background report job.",
    universe: job.universe || null,
  };
  const valuation = evidence.valuation || { ok: false, items: [], text: encodeTextTree({ items: [] }) };
  const deep = evidence.deep || { ok: false, items: [], text: encodeTextTree({ items: [] }) };
  const technical = evidence.technical || { ok: false, items: [], text: encodeTextTree({ items: [] }) };
  const signal = evidence.signal || { ok: false, items: [], text: encodeTextTree({ items: [] }) };
  const summary = evidence.summary || { ok: false, rows: [], riskControls: [], text: encodeTextTree({ rows: [] }) };
  return {
    ok: true,
    generatedAt: job.createdAt || new Date().toISOString(),
    selectedCodes: job.codes || [],
    contract: SWING_SKILL_BUNDLE,
    orchestration: {
      mode: "background_polling_specialist_chain",
      sourceRoot: SWING_SKILL_BUNDLE.sourceRoot,
      stageOrder: SWING_BACKGROUND_STAGES.map(item => item.stage),
      specialistCount: SWING_SKILL_BUNDLE.specialists.length,
      reusedStageOutputs: true,
      jobId: job.id || null,
    },
    gate: swingJobGate(job.codes || []),
    evidenceProvider: "backend_data_api",
    stages: { macro, screener, valuation, deep, technical, signal, summary },
    evidence: { macro, screener, valuation, deep, technical, signal, summary },
    macro,
    screener,
    valuation,
    deep,
    technical,
    signal,
    summary,
  };
}

function buildSwingJobResult(job: any) {
  const reportPayload: any = buildSwingJobReportPayload(job);
  const fallbackMarkdown = buildSwingOrchestratedMarkdown(reportPayload);
  const outputs = Array.isArray(job.outputs) ? job.outputs : [];
  const finalOutput = outputs.find(item => item.stage === "summary" && item.ok);
  const llm = {
    ok: Boolean(finalOutput?.markdown),
    status: finalOutput?.markdown ? "generated" : outputs.some(item => !item.ok) ? "partial_or_failed" : "empty_output",
    provider: "openai_responses",
    mode: "background_polling_specialist_chain",
    model: job.model || null,
    jobId: job.id || null,
    promptPreview: job.promptPreview || null,
    steps: job.steps || [],
    intermediateMarkdown: outputs.filter(item => item.stage !== "summary").map(item => ({
      stage: item.stage,
      skill: item.skill,
      markdown: item.markdown,
    })),
    markdown: finalOutput?.markdown || "",
    message: finalOutput?.markdown
      ? "\u5df2\u7531 background polling specialist chain \u7522\u751f\u7e41\u4e2d Markdown \u5831\u544a\u3002"
      : "Background specialist chain did not complete; deterministic fallback report is used.",
  };
  const reportMarkdown = llm.ok && llm.markdown ? llm.markdown : fallbackMarkdown;
  return {
    ...reportPayload,
    llm,
    reportMarkdown,
    fallbackReportMarkdown: fallbackMarkdown,
    text: encodeTextTree({
      contract: SWING_SKILL_BUNDLE,
      gate: reportPayload.gate,
      orchestration: reportPayload.orchestration,
      reportMarkdown,
      llm,
    }),
  };
}

function publicSwingJob(job: any, includeResult = false) {
  const stageCount = SWING_BACKGROUND_STAGES.length;
  const completed = (job.steps || []).filter((step: any) => ["generated", "passed", "fallback", "skipped_disabled", "timeout", "api_error", "exception"].includes(step.status)).length;
  const currentStage = SWING_BACKGROUND_STAGES[Math.min(job.currentStageIndex || 0, stageCount - 1)]?.stage || "summary";
  const done = ["generated", "partial_or_failed", "failed", "disabled"].includes(job.status);
  return {
    ok: true,
    jobId: job.id,
    status: job.status,
    done,
    currentStage,
    progress: {
      completed,
      total: stageCount,
      percent: Math.round((Math.min(completed, stageCount) / stageCount) * 100),
    },
    stageOrder: SWING_BACKGROUND_STAGES.map(item => item.stage),
    steps: job.steps || [],
    pollAfterMs: done ? 0 : 1200,
    message: job.message || "",
    result: includeResult || done ? buildSwingJobResult(job) : null,
  };
}

async function readSwingReportJob(id: string) {
  const [record] = await db.get<any>(SWING_REPORT_JOB_TABLE, [id]);
  return record ? { ...record, id } : null;
}

async function saveSwingReportJob(id: string, job: any) {
  const { id: _id, ...record } = job;
  const [ok] = await db.update(SWING_REPORT_JOB_TABLE, [{ id, record }]);
  if (!ok) throw new Error("Unable to update swing report job.");
}

async function createSwingReportJob(codes: string[], universeValue: unknown, promptContext: any, llmEnabled = true) {
  const now = new Date().toISOString();
  const model = await getOpenAiReportModel();
  const evidence = {
    macro: promptContext?.macro || null,
    screener: promptContext?.screener || null,
  };
  const record = {
    status: llmEnabled ? "queued" : "disabled",
    createdAt: now,
    updatedAt: now,
    codes,
    universe: universeValue || null,
    promptContext: promptContext || null,
    llmEnabled,
    model,
    currentStageIndex: 0,
    steps: initialSwingJobSteps(),
    outputs: [],
    evidence,
    message: llmEnabled ? "Background specialist chain queued." : "LLM report generation disabled by request.",
  };
  const [id] = await db.add(SWING_REPORT_JOB_TABLE, [record]);
  if (!id) throw new Error("Unable to create swing report job.");
  return { ...record, id };
}

async function ensureSwingJobEvidence(job: any, stage: string) {
  job.evidence = job.evidence || {};
  if (stage === "valuation" && !job.evidence.valuation) {
    job.evidence.valuation = await withTimeout(loadSwingValuation(job.codes || []), 45000, "valuation stage timed out");
  }
  if (stage === "deep-analysis" && !job.evidence.deep) {
    job.evidence.deep = await withTimeout(loadSwingDeepAnalysis(job.codes || []), 45000, "fundamental stage timed out");
  }
  if (stage === "technical" && !job.evidence.technical) {
    job.evidence.technical = await withTimeout(loadSwingTechnical(job.codes || []), 45000, "technical stage timed out");
  }
  if (stage === "signal" && !job.evidence.signal) {
    const signalItems = ((job.evidence.technical || {}).items || []).map(buildSwingSignalFromTechnical);
    job.evidence.signal = {
      ok: true,
      generatedAt: new Date().toISOString(),
      items: signalItems,
      text: encodeTextTree({ items: signalItems }),
    };
  }
  if (stage === "summary" && !job.evidence.summary) {
    if (!job.evidence.valuation) job.evidence.valuation = await withTimeout(loadSwingValuation(job.codes || []), 45000, "valuation stage timed out");
    if (!job.evidence.deep) job.evidence.deep = await withTimeout(loadSwingDeepAnalysis(job.codes || []), 45000, "fundamental stage timed out");
    if (!job.evidence.technical) job.evidence.technical = await withTimeout(loadSwingTechnical(job.codes || []), 45000, "technical stage timed out");
    if (!job.evidence.signal) {
      const signalItems = ((job.evidence.technical || {}).items || []).map(buildSwingSignalFromTechnical);
      job.evidence.signal = {
        ok: true,
        generatedAt: new Date().toISOString(),
        items: signalItems,
        text: encodeTextTree({ items: signalItems }),
      };
    }
    job.evidence.summary = buildSwingSummaryFromStages(job.codes || [], job.evidence.valuation, job.evidence.deep, job.evidence.technical, job.evidence.signal);
  }
}

async function advanceSwingReportJob(jobId: string) {
  const job = await readSwingReportJob(jobId);
  if (!job) return null;
  if (["generated", "partial_or_failed", "failed", "disabled"].includes(job.status)) return job;
  const stageDef = SWING_BACKGROUND_STAGES[job.currentStageIndex || 0];
  if (!stageDef) {
    job.status = "partial_or_failed";
    job.updatedAt = new Date().toISOString();
    job.message = "Background specialist chain ended without final synthesis.";
    await saveSwingReportJob(jobId, job);
    return job;
  }
  const steps = Array.isArray(job.steps) ? job.steps : initialSwingJobSteps();
  const stepIndex = steps.findIndex((step: any) => step.stage === stageDef.stage);
  if (stepIndex >= 0) {
    steps[stepIndex] = { ...steps[stepIndex], status: "running", message: "" };
  }
  job.status = "running";
  job.steps = steps;
  job.updatedAt = new Date().toISOString();
  await saveSwingReportJob(jobId, job);

  try {
    if (stageDef.stage === "user-selection-gate") {
      if (stepIndex >= 0) {
        steps[stepIndex] = { ...steps[stepIndex], status: "passed", ok: true, message: "Selected stock gate passed." };
      }
      job.outputs = [...(job.outputs || []), {
        stage: stageDef.stage,
        skill: stageDef.skill,
        status: "passed",
        ok: true,
        markdown: `## \u4f7f\u7528\u8005\u9078\u80a1 Gate\n\n\u5df2\u901a\u904e\uff1a${(job.codes || []).join(", ")}`,
      }];
    } else {
      await ensureSwingJobEvidence(job, stageDef.stage);
      const apiKey = await getOpenAiApiKey();
      const model = job.model || await getOpenAiReportModel();
      const reportPayload = buildSwingJobReportPayload(job);
      const promptData = buildSwingLlmPromptData(reportPayload, job.promptContext);
      job.promptPreview = {
        selectedCodes: promptData.selectedCodes,
        valuationRows: promptData.valuation.length,
        deepRows: promptData.fundamentalDeepDive.length,
        technicalRows: promptData.dailyTechnical.length,
        signalRows: promptData.klineSignal.length,
      };
      let result: any;
      if (!apiKey) {
        result = { ok: false, status: "missing_secret", message: "OPENAI_API_KEY AppDeploy secret is not configured.", text: fallbackStepMarkdown(stageDef.stage, promptData) };
      } else {
        result = await callOpenAiReportStep(
          apiKey,
          model,
          specialistInstructions(stageDef.role, stageDef.task),
          buildSpecialistInput(promptData, job.outputs || [], stageDef.stage, stageDef.stage === "summary" ? 14000 : 10000),
          stageDef.maxTokens,
          stageDef.timeoutMs
        );
      }
      const markdown = result.ok ? result.text : fallbackStepMarkdown(stageDef.stage, promptData);
      if (stepIndex >= 0) {
        steps[stepIndex] = {
          ...steps[stepIndex],
          status: result.ok ? "generated" : result.status,
          ok: Boolean(result.ok),
          responseId: result.responseId || null,
          usage: result.usage || null,
          message: result.message || "",
        };
      }
      job.outputs = [...(job.outputs || []), {
        stage: stageDef.stage,
        skill: stageDef.skill,
        status: result.ok ? "generated" : result.status,
        ok: Boolean(result.ok),
        responseId: result.responseId || null,
        usage: result.usage || null,
        message: result.message || "",
        markdown,
      }];
    }
    job.currentStageIndex = (job.currentStageIndex || 0) + 1;
    job.steps = steps;
    job.updatedAt = new Date().toISOString();
    if (job.currentStageIndex >= SWING_BACKGROUND_STAGES.length) {
      const result = buildSwingJobResult(job);
      job.status = result.llm.ok ? "generated" : "partial_or_failed";
      job.message = result.llm.message;
    } else {
      job.status = "running";
      job.message = `Completed ${stageDef.stage}; waiting for next poll.`;
    }
  } catch (err) {
    if (stepIndex >= 0) {
      steps[stepIndex] = {
        ...steps[stepIndex],
        status: "exception",
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    job.steps = steps;
    job.status = "partial_or_failed";
    job.updatedAt = new Date().toISOString();
    job.message = `Background stage ${stageDef.stage} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  await saveSwingReportJob(jobId, job);
  return job;
}

async function loadSwingOrchestratedReport(codes: string[], universeValue?: unknown, promptContext?: any, options: { llm?: boolean } = {}) {
  const generatedAt = new Date().toISOString();
  const macro = promptContext?.macro || {
    ok: true,
    reusedFrom: "client workflow gate",
    note: "Macro/news stage is loaded before user selection and is not recomputed in the deep-analysis endpoint.",
  };
  const screener = promptContext?.screener || {
    ok: true,
    reusedFrom: "client workflow gate",
    note: "Screener stage is loaded before user selection and is not recomputed in the deep-analysis endpoint.",
    universe: universeValue || null,
  };
  const gate = {
    required: true,
    status: codes.length ? "passed" : "blocked",
    selectedCodes: codes,
    instruction: "\u8acb\u5148\u5b8c\u6210\u5019\u9078\u6e05\u55ae\u5f8c\u9078\u53d6\u80a1\u7968\uff0c\u518d\u555f\u52d5\u4f30\u503c\u3001\u500b\u80a1\u6df1\u5ea6\u3001\u6280\u8853\u8207 K \u7dda\u7d9c\u5408\u5831\u544a\u3002",
  };
  if (!codes.length) {
    return {
      ok: false,
      generatedAt,
      contract: SWING_SKILL_BUNDLE,
      orchestration: { mode: "project-local-skill-contract", stageOrder: SWING_SKILL_BUNDLE.stageOrder },
      gate,
      stages: { macro, screener },
      text: encodeTextTree({ contract: SWING_SKILL_BUNDLE, gate }),
    };
  }
  const [valuation, deep, technical] = await Promise.all([
    loadSwingValuation(codes),
    loadSwingDeepAnalysis(codes),
    loadSwingTechnical(codes),
  ]);
  const signalItems = (technical.items || []).map(buildSwingSignalFromTechnical);
  const signal = {
    ok: true,
    generatedAt: new Date().toISOString(),
    items: signalItems,
    text: encodeTextTree({ items: signalItems }),
  };
  const summary = buildSwingSummaryFromStages(codes, valuation, deep, technical, signal);
  const reportPayload: any = {
    ok: true,
    generatedAt,
    selectedCodes: codes,
    contract: SWING_SKILL_BUNDLE,
    orchestration: {
      mode: "project-local-skill-contract",
      sourceRoot: SWING_SKILL_BUNDLE.sourceRoot,
      stageOrder: SWING_SKILL_BUNDLE.stageOrder,
      specialistCount: SWING_SKILL_BUNDLE.specialists.length,
      reusedStageOutputs: true,
    },
    gate,
    evidenceProvider: "backend_data_api",
    stages: { macro, screener, valuation, deep, technical, signal, summary },
    evidence: { macro, screener, valuation, deep, technical, signal, summary },
    macro,
    screener,
    valuation,
    deep,
    technical,
    signal,
    summary,
  };
  const fallbackMarkdown = buildSwingOrchestratedMarkdown(reportPayload);
  const llm = options.llm === false ? {
    ok: false,
    status: "disabled",
    provider: "deterministic_fallback",
    model: null,
    message: "LLM report generation disabled by request.",
    markdown: "",
  } : await generateSwingLlmReport(reportPayload, promptContext);
  const reportMarkdown = llm.ok && llm.markdown ? llm.markdown : fallbackMarkdown;
  return {
    ...reportPayload,
    llm,
    reportMarkdown,
    fallbackReportMarkdown: fallbackMarkdown,
    text: encodeTextTree({
      contract: SWING_SKILL_BUNDLE,
      gate,
      orchestration: reportPayload.orchestration,
      reportMarkdown,
      llm,
    }),
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

  "GET /api/swing/macro": [async () => {
    try {
      return json(await loadSwingMacro(), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing macro view: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/swing/screener": [async ({ query }: any) => {
    try {
      return json(await loadSwingScreener(query.universe), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing screener: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/swing/valuation": [async ({ query }: any) => {
    const codes = parseSwingCodes(query.codes || query.code);
    if (!codes.length) return error("Missing stock codes", 400);
    try {
      return json(await loadSwingValuation(codes), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing valuation: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/swing/deep-analysis": [async ({ query }: any) => {
    const codes = parseSwingCodes(query.codes || query.code);
    if (!codes.length) return error("Missing stock codes", 400);
    try {
      return json(await loadSwingDeepAnalysis(codes), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing deep analysis: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/swing/technical": [async ({ query }: any) => {
    const codes = parseSwingCodes(query.codes || query.code);
    if (!codes.length) return error("Missing stock codes", 400);
    try {
      return json(await loadSwingTechnical(codes), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing technical view: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/swing/signal": [async ({ query }: any) => {
    const codes = parseSwingCodes(query.codes || query.code);
    if (!codes.length) return error("Missing stock codes", 400);
    try {
      return json(await loadSwingSignal(codes), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing signal: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/swing/summary": [async ({ query }: any) => {
    const codes = parseSwingCodes(query.codes || query.code);
    if (!codes.length) return error("Missing stock codes", 400);
    try {
      return json(await loadSwingSummary(codes), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing summary: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/swing/orchestrated-report": [async ({ query }: any) => {
    const codes = parseSwingCodes(query.codes || query.code);
    if (!codes.length) return error("Missing stock codes", 400);
    const promptContext = parseSwingPromptContext(query.promptContext || query.context);
    const llmEnabled = String(query.llm || "1") !== "0";
    try {
      return json(await loadSwingOrchestratedReport(codes, query.universe, promptContext, { llm: llmEnabled }), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing orchestrated report: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "POST /api/swing/orchestrated-report/jobs": [async (ctx: any) => {
    const body = await readRequestJson(ctx);
    const codes = parseSwingCodes(Array.isArray(body.codes) ? body.codes.join(",") : body.codes || body.code);
    if (!codes.length) return error("Missing stock codes", 400);
    const promptContext = body.promptContext || body.context || null;
    const llmEnabled = body.llm !== false && String(body.llm ?? "1") !== "0";
    try {
      const job = await createSwingReportJob(codes, body.universe, promptContext, llmEnabled);
      return json(publicSwingJob(job), 202);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to create swing report job: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "GET /api/swing/orchestrated-report/jobs/:id": [async ({ params }: any) => {
    const id = String(params?.id || "").trim();
    if (!id) return error("Missing report job id", 400);
    try {
      const job = await advanceSwingReportJob(id);
      if (!job) return error("Report job not found", 404);
      return json(publicSwingJob(job, ["generated", "partial_or_failed", "failed", "disabled"].includes(job.status)), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to advance swing report job: ${err instanceof Error ? err.message : String(err)}`,
      }, 502);
    }
  }],

  "POST /api/swing/orchestrated-report": [async (ctx: any) => {
    const body = await readRequestJson(ctx);
    const codes = parseSwingCodes(Array.isArray(body.codes) ? body.codes.join(",") : body.codes || body.code);
    if (!codes.length) return error("Missing stock codes", 400);
    const promptContext = body.promptContext || body.context || null;
    const llmEnabled = body.llm !== false && String(body.llm ?? "1") !== "0";
    try {
      return json(await loadSwingOrchestratedReport(codes, body.universe, promptContext, { llm: llmEnabled }), 200);
    } catch (err) {
      return json({
        ok: false,
        message: `Unable to build swing orchestrated report: ${err instanceof Error ? err.message : String(err)}`,
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
