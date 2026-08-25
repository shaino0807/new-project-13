#!/usr/bin/env node

import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "file:///C:/Users/shaino/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
const html = await readFile(new URL("../index.html", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const server = http.createServer((request, response) => {
  if (request.url === "/src/main.ts") {
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
    response.end("// AppDeploy bridge is injected by the QA fixture.\n");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const url = `http://127.0.0.1:${address.port}/`;

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--no-sandbox", "--disable-gpu"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const scoreItem = (index) => ({
      ok: true,
      code: String(2300 + index),
      name: `測試公司${index}`,
      market: index % 2 ? "TWSE" : "TPEx",
      industryGroup: index % 3 ? "半導體業" : "電子零組件業",
      close: 100 + index,
      change: index % 2 ? 1.2 : -0.8,
      quoteDate: "2026-08-25",
      volume: 1000000 + index,
      generatedAt: "2026-08-26T01:00:00.000Z",
      fairValue: { value: 110 + index, upsidePct: 10 },
      scores: {
        undervalued: 90 - index / 2,
        overvalued: 30 + index / 2,
        smallInvestor: 88 - index / 3,
        cashFlow: { score: 84 - index / 4, label: "stable" },
        growth: { score: 82 - index / 5, label: "growth" },
        marketConfidence: { score: 70, label: "neutral" },
        chaseRisk: { score: 35, label: "low" },
        profitability: { score: 75 },
        financialStability: { score: 78 },
        valuation: { score: 80 },
      },
      dataStatus: {
        quoteDate: "2026-08-25",
        coverage: { available: 8, total: 9, percent: 89, label: "high" },
        staleDatasets: [],
        cachedDatasets: [],
        warnings: [],
      },
      rankingTrust: { status: "rankable", quality: "high", coveragePercent: 89, hasQuoteDate: true, staleDatasetCount: 0, reasons: [] },
      professionalRating: { total: 86 - index / 4, grade: "A", gradeLabel: "high", assetModel: "stock", components: [] },
      cfoGuide: { actionLabel: "分批研究", singleEntryLimitPct: 10, maxHoldingPct: 20, worstCaseLossPct: -8, stopTrackingAssumption: "資料失效時停止" },
    });
    const items = Array.from({ length: 64 }, (_, index) => scoreItem(index));
    const radar = {
      ok: true,
      snapshotStatus: "complete",
      generatedAt: "2026-08-26T01:00:00.000Z",
      universeMeta: { name: "250-stock performance pilot", version: "pilot-v2", fullMarketCompanyCount: 1985, fullMarketStatus: "connected", requestedCount: 250, scoredCount: 244, pilotSize: 250, rankingOutputLimit: 64 },
      rankingSnapshot: { generatedAt: "2026-08-26T01:00:00.000Z", requestedCount: 250, scoredCount: 244, rankableCount: 180, highTrustCount: 90, oldestQuoteDate: "2026-08-25", newestQuoteDate: "2026-08-25", rankingRule: "score coverage date code" },
      marketState: { avgScore: 76, highChase: 2, goodCoverage: 90, undervalued: 40, total: 180, tone: "neutral", note: "snapshot" },
      ranked: { observationPool: items, todayWatch: items.slice(0, 8), watchlist: items, chaseRisk: items, undervalued: items, overvalued: [...items].reverse(), active: items, cashflow: items, growth: items, smallInvestor: items, etf: [] },
      finmind: { status: "snapshot", note: "no homepage scoring" },
      backtest: { results: [] },
    };
    const quote = code => {
      const count = 130;
      const closes = Array.from({ length: count }, (_, index) => 80 + index * 0.2);
      const highs = closes.map(value => value + 2);
      const lows = closes.map(value => value - 2);
      const volumes = closes.map((_, index) => 1000000 + index * 1000);
      const flat = value => closes.map(() => value);
      const labels = Array.from({ length: count }, (_, index) => `2026-04-${String((index % 28) + 1).padStart(2, "0")}`);
      return {
        code,
        symbol: `${code}.TW`,
        name: code === "2330" ? "台積電" : `測試${code}`,
        market: "TWSE",
        currency: "TWD",
        close: closes.at(-1), open: closes.at(-1) - 1, high: closes.at(-1) + 2, low: closes.at(-1) - 2,
        quoteDate: "2026-08-25", change: 1.5, volume: volumes.at(-1), source: "QA fixture", sourceUrls: {}, series: [],
        analysis: {
          labels, closes, highs, lows, volumes,
          ma5: flat(104), ma10: flat(103), ma20: flat(102), ma60: flat(98), ma120: flat(94),
          bb: { up: flat(108), mid: flat(102), low: flat(96), pctB: flat(0.6), bw: flat(0.1) },
          macd: { dif: flat(1.2), dea: flat(1), hist: flat(0.4) },
          rsi14: flat(58), kd: { k: flat(60), d: flat(55) }, atr14: flat(2),
          levels: { supportShort: 100, supportMid: 94, resistanceShort: 108, resistanceMid: 112 },
          latest: { date: "2026-08-25", close: closes.at(-1), ma5: 104, ma10: 103, ma20: 102, ma20FiveDaysAgo: 101, ma60: 98, ma120: 94, rsi14: 58, k: 60, d: 55, dif: 1.2, dea: 1, hist: 0.4, pctB: 0.6, bandwidth: 0.1, atr14: 2, atrPct: 1.9, volumeRatio: 1.1, week52High: 115, week52Low: 75, pullback: 45 },
          probabilities: { overall: 45, technical: 58, volume: 52, wave: 55, fundamental: 60, longTerm: 35 },
        },
      };
    };
    window.__apiCalls = [];
    window.appApi = {
      async get(path) {
        window.__apiCalls.push(`GET ${path}`);
        if (path === "/api/market-radar") return { data: radar };
        if (path.startsWith("/api/screener/snapshot")) return { data: { ...radar, mode: "undervalued", items } };
        if (path.startsWith("/api/quote")) {
          const code = new URL(path, location.origin).searchParams.get("code");
          if (code === "9999") throw new Error("Network request failed");
          return { data: { ok: true, quote: quote(code) } };
        }
        if (path.startsWith("/api/fundamentals")) return { data: { ok: true, partial: true, data: {}, cache: { cachedDatasets: [], staleDatasets: [] } } };
        if (path.startsWith("/api/value-score")) return { data: { ok: false, message: "QA optional score unavailable" } };
        if (path.startsWith("/api/news")) return { data: { ok: true, items: [], note: "QA" } };
        if (path.startsWith("/api/stocks/search")) {
          const query = new URL(path, location.origin).searchParams.get("q");
          return { data: { ok: true, matches: query === "2330" ? [{ code: "2330", name: "台積電", type: "twse", industry: "半導體業", matchType: "exact_code" }] : [] } };
        }
        return { data: { ok: false, message: "QA route not provided" } };
      },
      async post(path) {
        window.__apiCalls.push(`POST ${path}`);
        return { data: { ok: false, message: "QA POST not provided" } };
      },
    };
    window.dispatchEvent(new Event("app-api-ready"));
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#marketRadarState")?.textContent?.includes("公開資料批次"));
  const initialCalls = await page.evaluate(() => window.__apiCalls);
  assert(initialCalls.some(call => call === "GET /api/market-radar"), "Homepage did not read the persisted market-radar endpoint");
  assert(!initialCalls.some(call => call.includes("/api/workbench")), "Homepage unexpectedly called /api/workbench");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const actions = [...document.querySelectorAll(".market-header-actions button")];
    return {
      visibleActions: actions.filter(button => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.display !== "none" && rect.width > 0 && rect.height > 0;
      }).map(button => ({ text: button.textContent.trim(), height: button.getBoundingClientRect().height })),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert(mobile.visibleActions.length === 3, `Expected three visible mobile primary actions, found ${mobile.visibleActions.length}`);
  assert(mobile.visibleActions.every(action => action.height >= 44), "A mobile primary action is shorter than 44px");
  assert(mobile.overflow <= 1, `Mobile page has ${mobile.overflow}px horizontal overflow`);

  await page.locator('.market-header-actions [data-market-view="client"]').click();
  await page.waitForFunction(() => location.hash === "#workspace-client");
  await page.locator("#backHomeBtn").click();
  await page.waitForFunction(() => !document.querySelector("#appPage")?.classList.contains("workspace-active"));

  await page.locator("#stockInput").fill("9999");
  await page.locator("#analyzeBtn").click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("找不到"));
  assert(!(await page.locator("#appPage").evaluate(element => element.classList.contains("workspace-active"))), "Failed stock search opened the stock workspace");

  await page.locator("#stockInput").fill("2330");
  await page.locator("#analyzeBtn").click();
  try {
    await page.waitForFunction(() => location.hash === "#workspace-stock" && document.querySelector("#appPage")?.classList.contains("workspace-active"), null, { timeout: 10000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      hash: location.hash,
      workspaceActive: document.querySelector("#appPage")?.classList.contains("workspace-active"),
      status: document.querySelector("#status")?.textContent,
      task: document.querySelector("#customerTaskMessage")?.textContent,
      calls: window.__apiCalls,
    }));
    throw new Error(`Successful-search QA timed out: ${JSON.stringify({ state, pageErrors })}`, { cause: error });
  }
  assert(await page.locator("#stockPage").isVisible(), "Successful stock search did not show the stock workspace");

  process.stdout.write(`${JSON.stringify({ ok: true, initialCalls, mobile, successfulSearchHash: await page.evaluate(() => location.hash) }, null, 2)}\n`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
