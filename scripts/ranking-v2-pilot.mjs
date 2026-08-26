#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const PILOT_SIZE = 250;
const OUTPUT_LIMIT = 64;
const MIN_COVERAGE = 60;
const MODES = ["undervalued", "overvalued", "active", "cashflow", "growth", "small-investor"];
const LIVE_UNIVERSE_URL = "https://api-v2.appdeploy.ai/app/932f5348aea14e86a7/api/universe";
const LIQUIDITY_ENDPOINTS = [
  { type: "twse", url: "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL" },
  { type: "tpex", url: "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes" },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    dataStatus: {
      quoteDate: "2026-08-25",
      coverage: { percent: coverage },
      staleDatasets,
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

function isRankable(item, mode) {
  return Boolean(item.ok && item.code && item.quoteDate
    && Number.isFinite(item.professionalRating.total)
    && Number(item.dataStatus.coverage.percent) >= MIN_COVERAGE
    && item.dataStatus.staleDatasets.length === 0
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

function syntheticUniverse() {
  const industries = ["semiconductor", "electronics", "financial", "shipping", "consumer", "biotech", "materials", "other"];
  return Array.from({ length: 1985 }, (_, index) => ({
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
    noStaleGate: backend.includes('trust.status !== "rankable"'),
    compactTrust: backend.includes("rankingTrust: item.rankingTrust || buildRankingTrust(item)"),
    pilotDoesNotActivate: backend.includes("{ activate: !job.pilotSize }") && backend.includes('snapshotStatus: "pilot-complete"'),
    persistedHomepage: frontend.includes('api.get("/api/market-radar")'),
    mobileActions: frontend.includes(".market-header-actions { display:grid; grid-template-columns:repeat(3,minmax(0,1fr))"),
    successfulSearchOpens: frontend.includes('if (await run(code)) openWorkspace("stock")'),
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

  const selectedMarkets = pilotA.reduce((counts, item) => ({ ...counts, [item.type]: (counts[item.type] || 0) + 1 }), {});
  const selectedIndustries = new Set(pilotA.map(item => `${item.type}|${item.industry || "unclassified"}`)).size;
  const selectedLiquidity = pilotA.reduce((counts, item) => ({ ...counts, [item.liquidityTier || "unavailable"]: (counts[item.liquidityTier || "unavailable"] || 0) + 1 }), {});
  assert(["low", "medium", "high"].every(tier => selectedLiquidity[tier] > 0), "Pilot does not cover all available liquidity tiers");
  const result = {
    ok: true,
    source: universe.source,
    fullDirectory: { total: listed.length, counts: universe.counts },
    pilot: { size: pilotA.length, markets: selectedMarkets, liquidityTiers: selectedLiquidity, marketIndustryBuckets: selectedIndustries, deterministic: true },
    contract: { minimumCoverage: MIN_COVERAGE, staleAllowed: false, outputPerMode: OUTPUT_LIMIT, modes: MODES.length },
    independence: {
      uniqueConstituentSets: uniqueConstituentSets.size,
      topFiveByMode: Object.fromEntries(MODES.map(mode => [mode, rankings[mode].slice(0, 5).map(item => item.code)])),
    },
    cpuBenchmark: { iterations: 1000, totalMs: Number(benchmarkMs.toFixed(2)), averageMs: Number((benchmarkMs / 1000).toFixed(4)) },
    sourceChecks,
    limitation: "This local run measures deterministic selection, evidence gating, and ranking CPU only. A remote 250-stock data-source run is still required to measure network calls, provider quotas, retries, and wall-clock scoring time.",
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
