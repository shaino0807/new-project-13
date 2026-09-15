#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

const PILOT_SIZE = 250;
const FULL_MARKET_SIZE = 1985;
const OUTPUT_LIMIT = 64;
const MIN_COVERAGE = 60;
const JOB_BATCH_SIZE = 20;
const MODES = ["undervalued", "overvalued", "active", "cashflow", "growth", "small-investor"];
const LIVE_UNIVERSE_URL = "https://api-v2.appdeploy.ai/app/932f5348aea14e86a7/api/universe";
const LIQUIDITY_ENDPOINTS = [
  { type: "twse", url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL" },
  { type: "tpex", url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes" },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectedYahooSuffix(type) {
  if (type === "twse") return ".TW";
  if (type === "tpex") return ".TWO";
  return null;
}

function pilotFingerprint(companies) {
  return createHash("sha256")
    .update(companies.map(company => `${company.type}:${company.code}`).sort().join("|"))
    .digest("hex");
}

function suspendedOnDate(record, effectiveDate) {
  if (!record?.explicitlyHalted) return false;
  if (!effectiveDate) return !record.explicitlyResumed;
  if (record.haltDate && record.haltDate > effectiveDate) return false;
  if (record.resumeDate && record.resumeDate <= effectiveDate) return false;
  return true;
}

function buildRepresentativePilotUniverse(companies, size = PILOT_SIZE) {
  const listed = [...new Map(companies
    .filter(company => company.type === "twse" || company.type === "tpex")
    .filter(company => /^\d{4}$/.test(String(company.code || "")))
    .map(company => [company.code, company])).values()]
    .sort((a, b) => `${a.type}|${a.industry}|${a.liquidityTier || "unavailable"}|${a.code}`.localeCompare(`${b.type}|${b.industry}|${b.liquidityTier || "unavailable"}|${b.code}`));
  if (listed.length <= size) return listed;
  const selected = new Map();
  const buckets = new Map();
  for (const company of listed) {
    const key = `${company.type}|${company.industry || "unclassified"}|${company.liquidityTier || "unavailable"}`;
    buckets.set(key, [...(buckets.get(key) || []), company]);
  }
  const bucketEntries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  const representativeBuckets = bucketEntries.length <= size
    ? bucketEntries
    : Array.from({ length: size }, (_, index) => bucketEntries[Math.floor(((index + 0.5) * bucketEntries.length) / size)]);
  for (const [, rows] of representativeBuckets) {
    if (selected.size >= size) break;
    const representative = rows[Math.floor((rows.length - 1) / 2)];
    selected.set(representative.code, representative);
  }
  const remaining = listed.filter(company => !selected.has(company.code));
  const needed = Math.max(0, size - selected.size);
  for (let index = 0; index < needed; index += 1) {
    const candidateIndex = Math.min(remaining.length - 1, Math.floor(((index + 0.5) * remaining.length) / needed));
    const candidate = remaining[candidateIndex];
    if (candidate) selected.set(candidate.code, candidate);
  }
  for (const company of remaining) {
    if (selected.size >= size) break;
    selected.set(company.code, company);
  }
  return [...selected.values()].sort((a, b) => a.code.localeCompare(b.code)).slice(0, size);
}

function deterministicNumber(code, salt) {
  let value = 2166136261;
  for (const char of `${code}|${salt}`) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) % 101;
}

function buildSyntheticFeature(company, index) {
  const coverage = index % 29 === 0 ? 55 : 60 + deterministicNumber(company.code, "coverage") % 41;
  const staleDatasets = index % 47 === 0 ? ["synthetic-stale-source"] : [];
  const score = salt => deterministicNumber(company.code, salt);
  return {
    ok: true,
    code: company.code,
    name: company.name,
    market: company.type === "twse" ? "TWSE" : "TPEx",
    industryGroup: company.industry || "unclassified",
    close: 10 + score("close"),
    change: score("change") - 50,
    quoteDate: "2026-08-25",
    volume: 1000 + score("active") * 1000,
    professionalRating: { total: score("total") },
    scores: {
      undervalued: score("undervalued"),
      overvalued: score("overvalued"),
      smallInvestor: score("small-investor"),
      cashFlow: { score: score("cashflow") },
      growth: { score: score("growth") },
    },
    technicalSnapshot: {
      latest: {
        ma20: 20 + score("ma20"),
        ma60: 18 + score("ma60"),
        atrPct: 1 + score("atr") / 10,
        volumeRatio: 1.5 + score("volume-ratio") / 100,
      },
      pattern: {
        historySessions: 120,
        aboveRising20Ma: true,
        trendLineBreakout: true,
        trendLinePrice: 18 + score("trend-line"),
        trendLineBreakoutPct: 1 + score("trend-breakout") / 10,
        wBottom: true,
        wBottomNeckline: 17 + score("neckline"),
        volumeExpansion: true,
        averageVolume20: 1000 + score("average-volume") * 100,
        volumeExpansionMultiple: 1.5 + score("volume-expansion") / 100,
        allPassed: true,
      },
    },
    fundamentals: {
      data: {
        profitability: { date: "2026-Q2", eps: 1 + score("eps") / 10, epsYoY: score("eps-yoy") - 20 },
        revenue: { date: "2026-07", yoy: score("revenue-yoy") - 20 },
        valuation: { per: 5 + score("per") / 2, pbr: 0.8 + score("pbr") / 20, dividendYield: score("yield") / 10 },
        cashFlow: {
          date: "2026-Q2",
          operatingCashFlow: score("ocf") * 1000000,
          freeCashFlow: (score("fcf") - 20) * 1000000,
          cashChange: (score("cash-change") - 50) * 100000,
          endingCash: score("ending-cash") * 1000000,
        },
        balanceSheet: { liabilityRatio: 20 + score("liability") / 2 },
      },
    },
    dataStatus: {
      quoteDate: "2026-08-25",
      coverage: { percent: coverage },
      staleDatasets,
      quoteOutcome: { category: "current" },
    },
  };
}

function scoreFor(mode, item) {
  if (mode === "overvalued") return item.scores.overvalued;
  if (mode === "active") return item.volume;
  if (mode === "cashflow") return item.scores.cashFlow.score;
  if (mode === "growth") return item.scores.growth.score;
  if (mode === "small-investor") return item.scores.smallInvestor;
  return item.scores.undervalued;
}

function hasRankingNumericEvidence(value) {
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
    && Number.isFinite(Number(value));
}

function modeEvidenceContract(item, mode) {
  const missing = [];
  const requireFinite = (label, value) => {
    if (!hasRankingNumericEvidence(value)) missing.push(label);
  };
  const requireText = (label, value) => {
    if (!String(value || "").trim()) missing.push(label);
  };
  const fundamentals = item.fundamentals?.data || {};
  const profitability = fundamentals.profitability || {};
  const revenue = fundamentals.revenue || {};
  const valuation = fundamentals.valuation || {};
  const cashFlow = fundamentals.cashFlow || {};
  const balance = fundamentals.balanceSheet || {};
  const latest = item.technicalSnapshot?.latest || {};
  requireFinite("latest close", item.close);
  requireText("quote date", item.quoteDate || item.dataStatus?.quoteDate);
  if (mode === "undervalued" || mode === "overvalued") {
    if ([valuation.per, valuation.pbr, valuation.dividendYield].filter(hasRankingNumericEvidence).length < 2) missing.push("two valuation fields");
    requireFinite("EPS", profitability.eps);
    requireFinite("monthly revenue YoY", revenue.yoy);
    requireFinite("operating cash flow", cashFlow.operatingCashFlow);
    requireFinite("liability ratio", balance.liabilityRatio);
    requireFinite("20MA", latest.ma20);
    requireFinite("60MA", latest.ma60);
  } else if (mode === "active") {
    requireFinite("latest volume", item.volume);
    requireFinite("20-day volume ratio", latest.volumeRatio);
    requireFinite("20MA", latest.ma20);
  } else if (mode === "cashflow") {
    requireText("cash-flow period", cashFlow.date);
    requireFinite("operating cash flow", cashFlow.operatingCashFlow);
    requireFinite("free cash flow", cashFlow.freeCashFlow);
    requireFinite("cash change", cashFlow.cashChange);
    requireFinite("ending cash", cashFlow.endingCash);
  } else if (mode === "growth") {
    requireText("financial-statement period", profitability.date);
    requireFinite("EPS", profitability.eps);
    requireFinite("EPS YoY", profitability.epsYoY);
    requireText("monthly revenue period", revenue.date);
    requireFinite("monthly revenue YoY", revenue.yoy);
  } else if (mode === "small-investor") {
    requireFinite("latest volume", item.volume);
    requireFinite("ATR14 percent", latest.atrPct);
    requireFinite("20MA", latest.ma20);
    requireFinite("60MA", latest.ma60);
    requireFinite("liability ratio", balance.liabilityRatio);
  }
  return { passed: missing.length === 0, missing };
}

function isRankable(item, mode) {
  return Boolean(item.ok && item.code && item.quoteDate
    && Number.isFinite(item.professionalRating.total)
    && Number(item.dataStatus.coverage.percent) >= MIN_COVERAGE
    && item.dataStatus.staleDatasets.length === 0
    && item.dataStatus.quoteOutcome.category === "current"
    && modeEvidenceContract(item, mode).passed
    && Number.isFinite(scoreFor(mode, item)));
}

function compare(mode, a, b) {
  const scoreDiff = scoreFor(mode, b) - scoreFor(mode, a);
  if (scoreDiff) return scoreDiff;
  const coverageDiff = b.dataStatus.coverage.percent - a.dataStatus.coverage.percent;
  if (coverageDiff) return coverageDiff;
  const dateDiff = b.quoteDate.localeCompare(a.quoteDate);
  if (dateDiff) return dateDiff;
  return a.code.localeCompare(b.code);
}

function buildIndependentRankings(features) {
  return Object.fromEntries(MODES.map(mode => [
    mode,
    features.filter(item => isRankable(item, mode)).sort((a, b) => compare(mode, a, b)).slice(0, OUTPUT_LIMIT),
  ]));
}

function buildCutoffAudit(features, mode) {
  const sorted = features.filter(item => isRankable(item, mode)).sort((a, b) => compare(mode, a, b));
  const reversed = [...features].reverse().filter(item => isRankable(item, mode)).sort((a, b) => compare(mode, a, b));
  return {
    passed: sorted.length >= OUTPUT_LIMIT
      && sorted.map(item => item.code).join(",") === reversed.map(item => item.code).join(","),
    eligibleCount: sorted.length,
    cutoffCode: sorted[OUTPUT_LIMIT - 1]?.code || null,
    nextCode: sorted[OUTPUT_LIMIT]?.code || null,
    auditBand: sorted.slice(49, 90).map((item, index) => ({ rank: index + 50, code: item.code, score: scoreFor(mode, item) })),
  };
}

function retryableCategory(category) {
  return category === "provider_failure";
}

function terminalDispositionsAllowActivation(counts) {
  return Number(counts.provider_failure || 0) === 0 && Number(counts.unresolved || 0) === 0;
}

function exact20MaPatternPassed(item) {
  const pattern = item.technicalSnapshot?.pattern || {};
  return pattern.historySessions >= 60
    && pattern.aboveRising20Ma === true
    && pattern.trendLineBreakout === true
    && pattern.wBottom === true
    && pattern.volumeExpansion === true
    && pattern.allPassed === true;
}

function syntheticUniverse() {
  const industries = ["semiconductor", "electronics", "financial", "shipping", "consumer", "biotech", "materials", "other"];
  return Array.from({ length: FULL_MARKET_SIZE }, (_, index) => ({
    code: String(1000 + index).padStart(4, "0"),
    name: `Synthetic ${index + 1}`,
    type: index < 1133 ? "twse" : "tpex",
    industry: industries[index % industries.length],
    liquidityTier: ["low", "medium", "high"][deterministicNumber(String(1000 + index), "liquidity") % 3],
  }));
}

function numeric(value) {
  const parsed = Number(String(value ?? "").replace(/[,+]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : NaN;
}

async function loadLiveLiquidity() {
  const settled = await Promise.all(LIQUIDITY_ENDPOINTS.map(async endpoint => {
    const response = await fetch(endpoint.url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`${endpoint.type} liquidity endpoint returned HTTP ${response.status}`);
    const rows = await response.json();
    assert(Array.isArray(rows), `${endpoint.type} liquidity endpoint returned a non-array payload`);
    return { endpoint, rows };
  }));
  const profiles = new Map();
  for (const { endpoint, rows } of settled) {
    for (const row of rows) {
      const code = String(row.Code || row.SecuritiesCompanyCode || row.SecuritiesCode || row["證券代號"] || "").trim();
      if (!/^\d{4}$/.test(code)) continue;
      const volume = numeric(row.TradeVolume || row.Volume || row.TradingShares || row.TransactionNumber || row["成交股數"] || row["成交量"]);
      const tradeValue = numeric(row.TradeValue || row.TransactionAmount || row.TradingValue || row["成交金額"]);
      const close = numeric(row.ClosingPrice || row.Close || row["收盤價"]);
      const liquidityValue = Number.isFinite(tradeValue) && tradeValue > 0
        ? tradeValue
        : Number.isFinite(volume) && volume > 0 ? volume * (Number.isFinite(close) && close > 0 ? close : 1) : null;
      profiles.set(code, { type: endpoint.type, liquidityValue, liquidityTier: liquidityValue === null ? "unavailable" : "medium" });
    }
  }
  for (const type of ["twse", "tpex"]) {
    const rows = [...profiles.entries()]
      .filter(([, profile]) => profile.type === type && Number.isFinite(profile.liquidityValue))
      .sort((a, b) => a[1].liquidityValue - b[1].liquidityValue || a[0].localeCompare(b[0]));
    rows.forEach(([, profile], index) => {
      const percentile = rows.length ? (index + 0.5) / rows.length : 0;
      profile.liquidityTier = percentile < 1 / 3 ? "low" : percentile < 2 / 3 ? "medium" : "high";
    });
  }
  return profiles;
}

async function loadUniverse(useLive) {
  if (!useLive) return { source: "synthetic-1985", companies: syntheticUniverse(), counts: { twse: 1133, tpex: 852 } };
  const [response, liquidity] = await Promise.all([
    fetch(LIVE_UNIVERSE_URL, { headers: { Accept: "application/json" } }),
    loadLiveLiquidity(),
  ]);
  if (!response.ok) throw new Error(`Universe endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  assert(payload?.ok && Array.isArray(payload.companies), "Universe endpoint did not return a company directory");
  return {
    source: LIVE_UNIVERSE_URL,
    companies: payload.companies.map(company => ({
      ...company,
      liquidityTier: liquidity.get(company.code)?.liquidityTier || "unavailable",
      liquidityValue: liquidity.get(company.code)?.liquidityValue ?? null,
    })),
    counts: payload.counts || {},
  };
}

async function verifySourceContracts() {
  const [backend, frontend] = await Promise.all([
    readFile(new URL("../backend/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
  ]);
  const checks = {
    coverage60: backend.includes("const RANKING_MIN_ITEM_COVERAGE = 60"),
    output64: backend.includes("const RANKING_OUTPUT_LIMIT = 64"),
    success95: backend.includes("const RANKING_MIN_SUCCESS_RATIO = 0.95"),
    fullRowsAtPublish: backend.includes("items: featureRows"),
    independentComparator: backend.includes("compareRankingItems(a, b, item => screenerSortValue(rankingMode, item))"),
    candidatePoolRemoved: !backend.includes("mergeRankingCandidatePool") && !backend.includes("RANKING_JOB_TOP_PER_MODE"),
    noActive55Threshold: !backend.includes("dataCoveragePct >= 55") && !backend.includes("coveragePct < 55"),
    liquidityStrata: backend.includes("loadPilotLiquidityProfiles") && backend.includes('company.liquidityTier || "unavailable"'),
    exactRequestMetrics: backend.includes("externalRequestCount: externalRequests.total") && !backend.includes("externalRequestCount: null"),
    readTimeSnapshotGate: backend.includes("const revalidatedPayload = applyRankingEvidenceGate") && backend.includes("The persisted snapshot no longer satisfies the current"),
    noStaleGate: backend.includes('trust.status !== "rankable"'),
    compactTrust: backend.includes("rankingTrust: item.rankingTrust || buildRankingTrust(item)"),
    pilotDoesNotActivate: backend.includes("{ activate: !job.pilotSize }") && backend.includes('snapshotStatus: "pilot-complete"'),
    persistedHomepage: frontend.includes('api.get("/api/market-radar")'),
    mobileActions: frontend.includes(".market-header-actions { display:grid; grid-template-columns:repeat(3,minmax(0,1fr))"),
    successfulSearchOpens: frontend.includes('if (await run(code)) openWorkspace("stock")'),
    marketAwareYahooSuffix: backend.includes('if (normalized === "twse") return [".TW"]')
      && backend.includes('if (normalized === "tpex") return [".TWO"]')
      && backend.includes('fetchYahooChart(code, "1y", metrics, market)'),
    officialDailyQuoteCache: backend.includes("officialDailyQuoteCache")
      && backend.includes("officialDailyQuoteInflight")
      && backend.includes("loadOfficialDailyQuoteSnapshot"),
    officialSuspensionEvidence: backend.includes("officialSuspensionCache")
      && backend.includes("loadOfficialSuspensionSnapshot")
      && backend.includes("isSuspendedOnDate")
      && backend.includes("TradingResumptionDate")
      && backend.includes("/exchangeReport/TWTAWU")
      && backend.includes("/tpex_spendi_today"),
    persistedOfficialPilotQuote: backend.includes("officialQuote: liquidityProfile?.officialQuote || null")
      && backend.includes("companyProfile?.officialQuote")
      && backend.includes('if (/^\\d+$/.test(code) && !snapshot)'),
    structuredQuoteOutcomes: backend.includes('type QuoteFailureCategory = "suspended_or_halted"')
      && backend.includes("outcomeClassification")
      && backend.includes("quoteOutcome"),
    quoteOutcomeGate: backend.includes('quoteOutcome === "suspended_or_halted"')
      && backend.includes('quoteOutcome === "no_quote_for_latest_session"'),
    sampleFingerprint: backend.includes('stableEvidenceId(["ranking-pilot", job.pilotVersion'),
    fullMarketBatch20: backend.includes("const RANKING_JOB_BATCH_SIZE = 20")
      && backend.includes("const RANKING_JOB_CONCURRENCY = 4"),
    providerScopedRetry: backend.includes('return category === "provider_failure"')
      && backend.includes("retryableFailedCodes"),
    officialHistoricalWarehouse: backend.includes("const MARKET_HISTORY_TARGET_SESSIONS = 120")
      && backend.includes("loadOfficialHistoricalMarketDay")
      && backend.includes("persistOfficialHistoryProfileBatches"),
    persistentFinMindCache: backend.includes('const FINMIND_DATASET_CACHE_TABLE = "finmind_dataset_cache_v1"')
      && backend.includes("readPersistentFinMindCache")
      && backend.includes("persistFinMindCache"),
    tpexMonthlyRevenue: backend.includes("mopsfin_t187ap05_O")
      && backend.includes("OFFICIAL_MONTHLY_REVENUE_ENDPOINTS"),
    modeSpecificEvidence: backend.includes("RANKING_MODE_REQUIRED_FIELDS")
      && backend.includes("rankingModeEvidenceContract"),
    cutoffAudit: backend.includes("buildRankingCutoffAudit")
      && backend.includes("auditBand: sorted.slice(49, 90)"),
    noSyntheticRankingHistory: backend.includes("allowSyntheticHistory = true")
      && backend.includes("!allowSyntheticHistory")
      && backend.includes("No synthetic history or ranking snapshot was produced"),
    exact20MaPattern: backend.includes("trendLineBreakout")
      && backend.includes("wBottomNeckline")
      && backend.includes("volumeExpansionMultiple")
      && backend.includes("technicalPatternAllPassed"),
    unresolvedSourceGate: backend.includes("unresolvedSourceFailures === 0")
      && backend.includes("zero provider_failure/unresolved dispositions"),
  };
  Object.entries(checks).forEach(([key, passed]) => assert(passed, `Source contract failed: ${key}`));
  return checks;
}

async function main() {
  const useLive = process.argv.includes("--live-universe");
  const sourceChecks = await verifySourceContracts();
  const universe = await loadUniverse(useLive);
  const listed = universe.companies.filter(company => company.type === "twse" || company.type === "tpex");
  assert(listed.length >= 1700, `Listed/OTC universe is incomplete: ${listed.length}`);

  const pilotA = buildRepresentativePilotUniverse(listed, PILOT_SIZE);
  const pilotB = buildRepresentativePilotUniverse([...listed].reverse(), PILOT_SIZE);
  assert(pilotA.length === PILOT_SIZE, `Pilot size is ${pilotA.length}, expected ${PILOT_SIZE}`);
  assert(new Set(pilotA.map(item => item.code)).size === PILOT_SIZE, "Pilot contains duplicate codes");
  assert(pilotA.map(item => item.code).join(",") === pilotB.map(item => item.code).join(","), "Pilot selection is not reproducible");
  assert(expectedYahooSuffix("twse") === ".TW", "TWSE must map directly to Yahoo .TW");
  assert(expectedYahooSuffix("tpex") === ".TWO", "TPEx must map directly to Yahoo .TWO");
  assert(expectedYahooSuffix("emerging") === null, "Unknown markets must not be silently assigned a listed/OTC suffix");
  const resumedRecord = { explicitlyHalted: true, explicitlyResumed: true, haltDate: "2026-08-13", resumeDate: "2026-08-14" };
  assert(suspendedOnDate(resumedRecord, "2026-08-13"), "A stock must be suspended on its official halt date before resumption");
  assert(!suspendedOnDate(resumedRecord, "2026-08-25"), "A historical halt record must not mark a resumed stock as currently suspended");

  const features = pilotA.map(buildSyntheticFeature);
  const benchmarkStartedAt = performance.now();
  let rankings;
  for (let iteration = 0; iteration < 1000; iteration += 1) rankings = buildIndependentRankings(features);
  const benchmarkMs = performance.now() - benchmarkStartedAt;

  for (const mode of MODES) {
    assert(rankings[mode].length === OUTPUT_LIMIT, `${mode} returned ${rankings[mode].length}, expected ${OUTPUT_LIMIT}`);
    assert(new Set(rankings[mode].map(item => item.code)).size === OUTPUT_LIMIT, `${mode} contains duplicate codes`);
    assert(rankings[mode].every(item => pilotA.some(company => company.code === item.code)), `${mode} contains a code outside the pilot universe`);
    assert(rankings[mode].every(item => isRankable(item, mode)), `${mode} contains an ineligible item`);
  }
  const uniqueConstituentSets = new Set(MODES.map(mode => rankings[mode].map(item => item.code).sort().join(",")));
  assert(uniqueConstituentSets.size >= 2, "Independent modes unexpectedly produced the same 64-stock constituent set");

  const fullMarketUniverse = syntheticUniverse();
  const dynamicFeatures = listed.map(buildSyntheticFeature);
  const dynamicRankings = buildIndependentRankings(dynamicFeatures);
  const reversedDynamicRankings = buildIndependentRankings([...dynamicFeatures].reverse());
  const declaredCodes = new Set(listed.map(company => company.code));
  assert(declaredCodes.size === listed.length, "Dynamic directory contains duplicate codes");
  for (const mode of MODES) {
    assert(dynamicRankings[mode].length === OUTPUT_LIMIT, `Dynamic ${mode} must return Top 64`);
    assert(dynamicRankings[mode].every(item => declaredCodes.has(item.code)), `Dynamic ${mode} escaped its directory`);
    assert(dynamicRankings[mode].map(item => item.code).join(",") === reversedDynamicRankings[mode].map(item => item.code).join(","), `Dynamic ${mode} ordering is unstable`);
  }
  const fullMarketFeatures = fullMarketUniverse.map(buildSyntheticFeature);
  const fullMarketStartedAt = performance.now();
  const fullMarketRankings = buildIndependentRankings(fullMarketFeatures);
  const fullMarketBenchmarkMs = performance.now() - fullMarketStartedAt;
  const cutoffAudits = Object.fromEntries(MODES.map(mode => [mode, buildCutoffAudit(fullMarketFeatures, mode)]));
  assert(fullMarketUniverse.length === FULL_MARKET_SIZE, `Full-market simulation contains ${fullMarketUniverse.length}, expected ${FULL_MARKET_SIZE}`);
  assert(Math.ceil(fullMarketUniverse.length / JOB_BATCH_SIZE) === 100, "1,985 stocks must be processed in exactly 100 batches of at most 20");
  for (const mode of MODES) {
    assert(fullMarketRankings[mode].length === OUTPUT_LIMIT, `Full-market ${mode} returned ${fullMarketRankings[mode].length}, expected ${OUTPUT_LIMIT}`);
    assert(fullMarketRankings[mode].every(item => modeEvidenceContract(item, mode).passed), `Full-market ${mode} contains a row missing mandatory fields`);
    assert(cutoffAudits[mode].passed, `Full-market ${mode} cutoff audit failed determinism or minimum-row checks`);
    assert(cutoffAudits[mode].auditBand.length === 41, `Full-market ${mode} must retain ranks 50-90 for boundary review`);
  }
  const cashflowMissing = structuredClone(fullMarketRankings.cashflow[0]);
  delete cashflowMissing.fundamentals.data.cashFlow.endingCash;
  assert(!isRankable(cashflowMissing, "cashflow"), "A cash-flow row missing ending cash must be rejected, not ranked");
  const growthMissing = structuredClone(fullMarketRankings.growth[0]);
  delete growthMissing.fundamentals.data.profitability.epsYoY;
  assert(!isRankable(growthMissing, "growth"), "A growth row missing EPS YoY must be rejected, not ranked");
  const failureCategories = ["provider_failure", "unresolved", "no_quote_for_latest_session", "suspended_or_halted", "not_rankable"];
  const retriedCategories = failureCategories.filter(retryableCategory);
  assert(retriedCategories.length === 1 && retriedCategories[0] === "provider_failure", "Only transient provider failures may be retried");
  assert(!retryableCategory("no_quote_for_latest_session"), "Deterministic no-quote dispositions must not waste retry requests");
  assert(!retryableCategory("not_rankable"), "Evidence-contract failures must not waste retry requests");
  assert(!terminalDispositionsAllowActivation({ provider_failure: 1, unresolved: 0 }), "A remaining provider failure must block activation");
  assert(!terminalDispositionsAllowActivation({ provider_failure: 0, unresolved: 1 }), "An unresolved disposition must block activation");
  assert(terminalDispositionsAllowActivation({ provider_failure: 0, unresolved: 0, no_quote_for_latest_session: 8, suspended_or_halted: 2 }), "Explicit no-quote and suspension dispositions may complete the ledger without receiving ranks");
  assert(fullMarketFeatures.every(exact20MaPatternPassed), "Synthetic exact-20MA fixtures must pass all four conditions");
  for (const failedField of ["aboveRising20Ma", "trendLineBreakout", "wBottom", "volumeExpansion"]) {
    const failedPattern = structuredClone(fullMarketFeatures[0]);
    failedPattern.technicalSnapshot.pattern[failedField] = false;
    assert(!exact20MaPatternPassed(failedPattern), `20MA theme must reject a row when ${failedField} fails`);
  }

  const selectedMarkets = pilotA.reduce((counts, item) => ({ ...counts, [item.type]: (counts[item.type] || 0) + 1 }), {});
  const selectedIndustries = new Set(pilotA.map(item => `${item.type}|${item.industry || "unclassified"}`)).size;
  const selectedLiquidity = pilotA.reduce((counts, item) => ({ ...counts, [item.liquidityTier || "unavailable"]: (counts[item.liquidityTier || "unavailable"] || 0) + 1 }), {});
  assert(["low", "medium", "high"].every(tier => selectedLiquidity[tier] > 0), "Pilot does not cover all available liquidity tiers");
  const result = {
    ok: true,
    source: universe.source,
    fullDirectory: { total: listed.length, counts: universe.counts },
    dynamicUniverseSimulation: { total: listed.length, batchCount: Math.ceil(listed.length / JOB_BATCH_SIZE), uniqueCodes: declaredCodes.size, deterministic: true, outputByMode: Object.fromEntries(MODES.map(mode => [mode, dynamicRankings[mode].length])), dataKind: "synthetic features over the selected directory; not real stock scoring" },
    pilot: {
      size: pilotA.length,
      markets: selectedMarkets,
      liquidityTiers: selectedLiquidity,
      marketIndustryBuckets: selectedIndustries,
      deterministic: true,
      sampleFingerprint: pilotFingerprint(pilotA),
      yahooSuffixMapping: { twse: expectedYahooSuffix("twse"), tpex: expectedYahooSuffix("tpex"), unknown: expectedYahooSuffix("unknown") },
    },
    contract: { minimumCoverage: MIN_COVERAGE, staleAllowed: false, outputPerMode: OUTPUT_LIMIT, modes: MODES.length },
    independence: {
      uniqueConstituentSets: uniqueConstituentSets.size,
      topFiveByMode: Object.fromEntries(MODES.map(mode => [mode, rankings[mode].slice(0, 5).map(item => item.code)])),
    },
    cpuBenchmark: { iterations: 1000, totalMs: Number(benchmarkMs.toFixed(2)), averageMs: Number((benchmarkMs / 1000).toFixed(4)) },
    fullMarketSimulation: {
      universeSize: fullMarketUniverse.length,
      batchSize: JOB_BATCH_SIZE,
      batchCount: Math.ceil(fullMarketUniverse.length / JOB_BATCH_SIZE),
      concurrency: 4,
      rankingMs: Number(fullMarketBenchmarkMs.toFixed(2)),
      outputByMode: Object.fromEntries(MODES.map(mode => [mode, fullMarketRankings[mode].length])),
      cutoffAudits,
      missingFieldRejection: { cashflowEndingCash: true, growthEpsYoY: true },
      retriedCategories,
      terminalDispositionGate: { providerFailureMustBeZero: true, unresolvedMustBeZero: true },
      exact20MaContract: ["above rising 20MA", "trend-line breakout", "W-bottom neckline breakout", "volume >= 1.5x prior 20-session average"],
    },
    sourceChecks,
    limitation: "This is a deterministic local 1,985-stock simulation plus source-code contract audit. It does not claim that a live 1,985-stock collection completed, that remote persistence limits passed, or that a formal snapshot was activated.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
