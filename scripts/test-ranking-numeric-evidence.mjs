import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

// Execute the production contract without importing backend services or starting jobs.
const source = await readFile(new URL("../backend/index.ts", import.meta.url), "utf8");
const start = source.indexOf("const RANKING_MODE_REQUIRED_FIELDS");
const end = source.indexOf("function rankingItemHasMinimumEvidence", start);
assert(start >= 0 && end > start, "Production evidence contract boundaries must exist");
const check = runInNewContext(stripTypeScriptTypes(source.slice(start, end)) + "\nrankingModeEvidenceContract;");
const fixture = {
  close: 100, quoteDate: "2026-09-11", volume: 1000,
  technicalSnapshot: { latest: { ma20: 90, ma60: 80, volumeRatio: 1.5, atrPct: 2 } },
  fundamentals: { data: {
    profitability: { date: "2026-Q2", eps: 2, epsYoY: 5 },
    revenue: { date: "2026-08", yoy: 10 },
    valuation: { per: 15, pbr: 2, dividendYield: 3 },
    cashFlow: { date: "2026-Q2", operatingCashFlow: 10, freeCashFlow: 5, cashChange: -1, endingCash: 20 },
    balanceSheet: { liabilityRatio: 30 },
  } },
};
const paths = {
  undervalued: ["profitability.eps", "revenue.yoy", "cashFlow.operatingCashFlow", "balanceSheet.liabilityRatio", "latest.ma20", "latest.ma60"],
  overvalued: ["profitability.eps", "revenue.yoy", "cashFlow.operatingCashFlow", "balanceSheet.liabilityRatio", "latest.ma20", "latest.ma60"],
  active: ["volume", "latest.volumeRatio", "latest.ma20"],
  cashflow: ["cashFlow.operatingCashFlow", "cashFlow.freeCashFlow", "cashFlow.cashChange", "cashFlow.endingCash"],
  growth: ["profitability.eps", "profitability.epsYoY", "revenue.yoy"],
  "small-investor": ["volume", "latest.atrPct", "latest.ma20", "latest.ma60", "balanceSheet.liabilityRatio"],
};
const invalid = [null, undefined, "", " \t ", false, true, [], [1], {}, NaN, Infinity, -Infinity, "NaN", "Infinity", "missing"];
let cases = 0;
for (const [mode, fields] of Object.entries(paths)) {
  assert.equal(check(mode, fixture).passed, true, `${mode} baseline`);
  for (const path of ["close", ...fields]) {
    for (const value of [...invalid, 0, "0", -1, "-1.5", " 2.5 "]) {
      const item = structuredClone(fixture);
      const parts = path.split(".");
      const owner = parts.length === 1 ? item : parts[0] === "latest"
        ? item.technicalSnapshot.latest : item.fundamentals.data[parts[0]];
      owner[parts.at(-1)] = value;
      const expected = !invalid.includes(value);
      assert.equal(check(mode, item).passed, expected, `${mode} ${path}: ${String(value)}`);
      cases++;
    }
  }
}
for (const mode of ["undervalued", "overvalued"]) {
  for (const value of invalid) {
    const item = structuredClone(fixture);
    item.fundamentals.data.valuation = { per: 10, pbr: value, dividendYield: value };
    assert.equal(check(mode, item).passed, false, `${mode}: one valid valuation field is insufficient`);
    item.fundamentals.data.valuation.pbr = "0";
    assert.equal(check(mode, item).passed, true, `${mode}: two valid valuation fields suffice`);
    cases += 2;
  }
}
console.log(JSON.stringify({ ok: true, cases, scope: "Production numeric evidence contract; no network or persistence" }));

// Exercise actual production cache-hit branches with in-memory database doubles.
const cacheStart = source.indexOf("async function requestFinMindDataset(");
const cacheEnd = source.indexOf("\n}\n", cacheStart) + 3;
assert(cacheStart >= 0 && cacheEnd > cacheStart, "Production cache function must exist");
const dataset = "TaiwanStockFinancialStatements";
const cachedEntry = { data: [{ value: 0 }], fetchedAt: Date.now() - 1000 };
for (const expectedSource of ["memory", "persistent"]) {
  let persistentReads = 0;
  const request = runInNewContext(stripTypeScriptTypes(source.slice(cacheStart, cacheEnd)) + "\nrequestFinMindDataset;", {
    finMindCache: new Map(expectedSource === "memory" ? [[`${dataset}:2330`, cachedEntry]] : []),
    FINMIND_PERSISTENT_DATASETS: new Set([dataset]),
    readPersistentFinMindCache: async () => { persistentReads++; return cachedEntry; },
    finMindCacheTtl: () => 86400000,
  });
  const result = await request(dataset, "2330");
  assert.equal(result.cacheSource, expectedSource);
  assert.equal(result.cached, true);
  assert.equal(result.stale, false);
  assert.equal(result.fetchedAt, new Date(cachedEntry.fetchedAt).toISOString());
  assert.equal(persistentReads, expectedSource === "persistent" ? 1 : 0);
}
console.log(JSON.stringify({ ok: true, cacheProvenanceCases: 2, scope: "Production cache-hit branches with database doubles" }));
